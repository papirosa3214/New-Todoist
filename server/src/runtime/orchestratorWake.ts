import crypto from "node:crypto";
import db from "../db.js";
import { roleUserId } from "../roleRouting.js";
import { logEvent } from "../agentState.js";
import { broadcastToUsers } from "../ws.js";
import { loadChatMessage } from "../lib/chatMessages.js";
import { enqueueMessageDelivery } from "./chatQueue.js";
import { ORCHESTRATE_SLOT, ORCHESTRATE_ASSEMBLE_SLOT } from "./orchestratedPlan.js";

export type WakeKind = "blocked" | "returned" | "retry" | "approval";
type Wake = { chatId: string; roleId: string; deliveryId: string; messageId: string };

const HEADLINE: Record<WakeKind, string> = {
  blocked: "встал в блок",
  returned: "возвращён проверяющим на доработку",
  retry: "запущен повторно (новая попытка)",
  approval: "просит согласовать изменение плана",
};

/** Хвост-инструкция оркестратору — общий для всех пробуждений. */
const TAIL = [
  "Разберись как оркестратор: taskflow_task и taskflow_plan_read. Если шаг ходит по кругу или упёрся —",
  "сними препятствие: ответь роли (taskflow_topic_send), уточни или замени шаг (taskflow_plan_ops: update_step / skip_step / add_step),",
  "либо, если нужен владелец, напиши ему конкретный вопрос в карточку (taskflow_comment). Если всё идёт штатно — ничего не делай.",
  "Работу роли сам не делай.",
];

/** Открыть личный чат «Заминки команды» и положить в него сообщение.
 *  Оркестратор — всегда участник; автор карточки добавляется, только если
 *  он есть и это не он сам (`chat_members.member_id` NOT NULL, а вставка
 *  идёт в транзакции: пустой `creator_id` уронил бы всю отправку). */
function openWakeChat(chatId: string, orchestratorId: string, creatorId: string | null): void {
  db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES (?,'Заминки команды','direct',?)").run(chatId, orchestratorId);
  db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES (?,?)").run(chatId, orchestratorId);
  if (creatorId && creatorId !== orchestratorId) {
    db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES (?,?)").run(chatId, creatorId);
  }
}

/**
 * Режим «Оркестратор» (владелец 13.10.2026): заминка шага команды будит
 * Оркестратора сообщением через очередь чата — как передачу на интеграцию.
 * Простое уведомление (signalBlock) роль не запускает, и заминка висела бы
 * до протухания аренды. События: блок, возврат проверяющим (без блока роли
 * могут по кругу сжечь попытки), новая попытка того же шага. Только план
 * orchestrated и только шаги команды, не его собственные.
 */
export function wakeOrchestrator(subtaskId: string, actorId: string | null, kind: WakeKind, detail: string | null): Wake | null {
  return db.transaction(() => {
    const row = db.prepare(`SELECT s.title, s.task_id, s.plan_node_key AS slot, s.admission_cycle AS cycle, p.id AS plan_id, t.title AS task_title, t.creator_id
        FROM subtasks s JOIN task_collaboration_plans p ON p.id = s.collaboration_plan_id JOIN tasks t ON t.id = s.task_id
       WHERE s.id = ? AND p.profile = 'orchestrated' AND p.status = 'approved'`).get(subtaskId) as any;
    if (!row || row.slot === ORCHESTRATE_SLOT || row.slot === ORCHESTRATE_ASSEMBLE_SLOT) return null;
    const orch = db.prepare("SELECT id FROM users WHERE id = ? AND type = 'ai' AND COALESCE(archived,0) = 0").get(roleUserId("code_orchestrator")) as { id: string } | undefined;
    if (!orch) return null;
    const chatId = "orchestrator-wake:" + orch.id;
    const messageId = `orch-${kind}:${subtaskId}:${crypto.randomUUID()}`;
    openWakeChat(chatId, orch.id, row.creator_id);
    const attempt = kind === "retry" && row.cycle ? ` Это попытка №${row.cycle}.` : "";
    const text = [
      `Заминка в команде по карточке «${row.task_title}» (${row.task_id}), план ${row.plan_id}.`,
      `Шаг «${row.title}» (${row.slot}, id ${subtaskId}) ${HEADLINE[kind]}.${attempt}`,
      detail ? `Подробности: ${detail.slice(0, 600)}` : "",
      kind === "approval" ? "Реши сам: taskflow_plan_proposal_decide (task_id, plan_id, op_id из подробностей, decision approve|reject). Одобряй, только если шаг нужен для результата карточки и не выходит за её границы." : "",
      ...TAIL,
    ].filter(Boolean).join("\n");
    db.prepare("INSERT OR IGNORE INTO chat_messages(id,from_user_id,text,channel,chat_id,task_id,work_mode) VALUES (?,?,?,'chat',?,?,'work')").run(messageId, actorId ?? row.creator_id, text, chatId, row.task_id);
    db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(chatId);
    const queued = enqueueMessageDelivery({ chatId, roleId: orch.id, deliveryId: messageId, messageId, payload: { mode: "work", hop: 0 } });
    logEvent({ taskId: row.task_id, actorId, kind: "orchestrator_woken", field: `${kind}:${subtaskId}`, toValue: row.title });
    return { chatId, roleId: orch.id, deliveryId: queued.id, messageId };
  })();
}

/** Доставка после коммита: показать сообщение в чате и запустить роль. */
export function deliverWake(wake: Wake | null): void {
  if (!wake) return;
  const audience = (db.prepare("SELECT member_id FROM chat_members WHERE chat_id=?").all(wake.chatId) as Array<{ member_id: string }>).map(r => r.member_id);
  broadcastToUsers(audience, { type: "chat:new", message: loadChatMessage(wake.messageId) });
  void import("../routes/chats.js").then(({ recoverAgentDelivery }) => recoverAgentDelivery(wake))
    .catch(error => console.warn("[orchestrator-wake] доставка отложена", error));
}

/** Безопасная обёртка для мест, где побудка не должна ронять основное действие. */
export function wakeAndDeliver(subtaskId: string, actorId: string | null, kind: WakeKind, detail: string | null): void {
  try { deliverWake(wakeOrchestrator(subtaskId, actorId, kind, detail)); }
  catch (err) { console.warn(`[orchestrator-wake] ${kind} по ${subtaskId} не ушла:`, err); }
}

/* ── Сторож зависших шагов (карточка 2beb2bf2, контракт fc0ea9a6) ──
 *
 * `wakeOrchestrator` смотрит только планы профиля `orchestrated` — таких
 * в базе единицы, а зависать могут шаги любых профилей (у этой карточки
 * профиль `bug_regression`). Расширять тот фильтр нельзя: тогда оркестратора
 * будил бы каждый блок во всех остальных планах. Поэтому для событий
 * сторожа — отдельная функция: тот же чат и та же доставка, но без
 * профильного фильтра и только для этих трёх видов событий.
 */

export type StalledWakeKind = "stalled_restarted" | "stalled_restart_failed" | "stalled_blocked";

const STALLED_HEADLINE: Record<StalledWakeKind, string> = {
  stalled_restarted: "завис и был перезапущен сервером",
  stalled_restart_failed: "завис, перезапуск сервером не удался",
  stalled_blocked: "завис и встал в блок",
};

/**
 * Сообщение оркестратору о событии сторожа. `attemptKey` — личность
 * события (id закрытой попытки, иначе `cycle:<admission_cycle>`), из него
 * строится детерминированный `messageId`: `chat_messages.id` — primary key,
 * поэтому `INSERT OR IGNORE` даёт ровно одно сообщение на событие даже при
 * гонке двух процессов, а повторный вызов вернёт тот же id без новой строки.
 */
export function wakeOrchestratorStalled(subtaskId: string, kind: StalledWakeKind, attemptKey: string, detail: string | null): Wake | null {
  return db.transaction(() => {
    const row = db.prepare(`SELECT s.title, s.task_id, s.plan_node_key AS slot, p.id AS plan_id, t.title AS task_title, t.creator_id
        FROM subtasks s JOIN task_collaboration_plans p ON p.id = s.collaboration_plan_id JOIN tasks t ON t.id = s.task_id
       WHERE s.id = ? AND p.status = 'approved'`).get(subtaskId) as any;
    if (!row || row.slot === ORCHESTRATE_SLOT || row.slot === ORCHESTRATE_ASSEMBLE_SLOT) return null;
    const orch = db.prepare("SELECT id FROM users WHERE id = ? AND type = 'ai' AND COALESCE(archived,0) = 0").get(roleUserId("code_orchestrator")) as { id: string } | undefined;
    if (!orch) return null;
    const chatId = "orchestrator-wake:" + orch.id;
    const messageId = `orch-${kind}:${attemptKey}`;
    openWakeChat(chatId, orch.id, row.creator_id);
    const text = [
      `Заминка в команде по карточке «${row.task_title}» (${row.task_id}), план ${row.plan_id}.`,
      `Шаг «${row.title}» (${row.slot}, id ${subtaskId}) ${STALLED_HEADLINE[kind]}.`,
      `Событие сторожа зависших шагов, попытка ${attemptKey}.`,
      detail ? `Подробности: ${detail.slice(0, 600)}` : "",
      ...TAIL,
    ].filter(Boolean).join("\n");
    db.prepare("INSERT OR IGNORE INTO chat_messages(id,from_user_id,text,channel,chat_id,task_id,work_mode) VALUES (?,?,?,'chat',?,?,'work')").run(messageId, orch.id, text, chatId, row.task_id);
    db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(chatId);
    const queued = enqueueMessageDelivery({ chatId, roleId: orch.id, deliveryId: messageId, messageId, payload: { mode: "work", hop: 0 } });
    logEvent({ taskId: row.task_id, actorId: orch.id, kind: "orchestrator_woken", field: `${kind}:${subtaskId}`, toValue: attemptKey });
    return { chatId, roleId: orch.id, deliveryId: queued.id, messageId };
  })();
}

/** Обёртка сторожа: уведомление не должно ронять ни авторестарт, ни блок. */
export function wakeAndDeliverStalled(subtaskId: string, kind: StalledWakeKind, attemptKey: string, detail: string | null): void {
  try { deliverWake(wakeOrchestratorStalled(subtaskId, kind, attemptKey, detail)); }
  catch (err) { console.warn(`[orchestrator-wake] ${kind} по ${subtaskId} не ушла:`, err); }
}
