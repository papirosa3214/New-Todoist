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

/** Разбор блока — отдельная инструкция (владелец 20.10.2026): побудка на
 *  блок приходит из любого плана, и Оркестратору нужно понимать, что именно
 *  проверить и какими инструментами чинить, а не только «разберись». */
const BLOCK_KIND_HINT: Record<string, string> = {
  needs_input: "роль ждёт решения или сведений — проверь, не ответ ли это, который есть в карточке, базе знаний или у другой роли",
  capability: "роли не хватает инструмента, доступа или компетенции — часто это не та роль или не тот проект/машина у карточки",
  dependency: "роль ждёт чужой результат — проверь, не стоит ли шаг раньше нужного предшественника",
  transient: "временный сбой (сеть, лимит, сервис) — чаще всего хватает перезапуска шага",
};

const BLOCK_GUIDE = [
  "Тебя разбудили, потому что шаг встал в блок. Разберись, почему, и сними препятствие сам, если можешь.",
  "1. Пойми ситуацию: taskflow_task (карточка, лента, комментарии), taskflow_plan_read (граф плана), taskflow_slot_snapshot (что успел шаг), taskflow_topic_read (переписка ролей по карточке).",
  "2. Найди причину. Типичные: план построен неправильно (шаг раньше нужного предшественника, не хватает шага, лишний шаг); роли не хватило инструмента, доступа или знаний; не та роль на шаге; карточка лежит не в том проекте, и у роли нет нужной машины или репозитория; вопрос, на который ответ уже есть.",
  "3. Почини доступными средствами:",
  "   — ответь роли или подскажи, где взять сведения: taskflow_topic_send; поищи ответ: taskflow_kb_search;",
  "   — перестрой план: taskflow_plan_ops — add_step (добавить шаг другой роли), update_step (поменять роль, задание или порядок шага), skip_step / remove_step (убрать лишнее);",
  "   — подбери роль: taskflow_team_read (кто есть, какие у ролей инструменты и модели);",
  "   — порядок и зависимости карточек: taskflow_dependencies, taskflow_children;",
  "   — шаг мёртв или застрял: taskflow_slot_status → taskflow_slot_reset → taskflow_slot_restart (в reason — что изменилось и что делать дальше);",
  "4. Если без владельца никак (решение по смыслу, деньги, доступ, который выдаёт только он) — напиши ему один конкретный вопрос в карточку: taskflow_comment.",
  "Работу роли сам не делай. Если всё уже идёт штатно — ничего не делай.",
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
    const row = db.prepare(`SELECT s.title, s.task_id, s.plan_node_key AS slot, s.admission_cycle AS cycle, s.block_type, p.id AS plan_id, t.title AS task_title, t.creator_id
        FROM subtasks s JOIN task_collaboration_plans p ON p.id = s.collaboration_plan_id JOIN tasks t ON t.id = s.task_id
       WHERE s.id = ? AND (p.profile = 'orchestrated' OR ? = 'blocked') AND p.status = 'approved'`).get(subtaskId, kind) as any;
    // Блок будит Оркестратора в любом плане (владелец 20.10.2026): планы из
    // автоприёма («один исполнитель») стояли в блоке, а будить было некого.
    // Возврат, повтор и согласование — по-прежнему только в режиме «Оркестратор».
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
      kind === "blocked" && row.block_type ? `Вид блока: ${row.block_type}${BLOCK_KIND_HINT[row.block_type] ? ` — ${BLOCK_KIND_HINT[row.block_type]}` : ""}.` : "",
      kind === "approval" ? "Реши сам: taskflow_plan_proposal_decide (task_id, plan_id, op_id из подробностей, decision approve|reject). Одобряй, только если шаг нужен для результата карточки и не выходит за её границы." : "",
      ...(kind === "blocked" ? BLOCK_GUIDE : TAIL),
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

/** Заголовок вида события. `stalled_restarted` уходит сразу после
 *  закрытия зависшей попытки, до результата старта, поэтому формулировка
 *  обещает только запуск перезапуска, а не его успех (ревью критика
 *  16.10.2026, D1). Провал старта — отдельный вид с отдельным ключом. */
const STALLED_HEADLINE: Record<StalledWakeKind, string> = {
  stalled_restarted: "завис, сервер запустил перезапуск",
  stalled_restart_failed: "завис, перезапуск сервером не удался",
  stalled_blocked: "завис и встал в блок",
};

/** Личность события читается по-разному: у большинства видов это id
 *  закрытой попытки, но у узла без попытки — цикл допуска. */
const eventLabel = (attemptKey: string): string =>
  attemptKey.startsWith("cycle:") ? `цикл допуска ${attemptKey.slice("cycle:".length)}` : `попытка ${attemptKey}`;

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
    // id шага в ключе обязателен: у шага без попытки attemptKey — `cycle:N`,
    // одинаковый у всех карточек, и INSERT OR IGNORE молча глотал побудку,
    // если такое сообщение уже было по другой карточке (20.10.2026: Критик
    // веб-карточки завис, сторож «разбудил», а сообщение не создалось).
    const messageId = `orch-${kind}:${subtaskId}:${attemptKey}`;
    openWakeChat(chatId, orch.id, row.creator_id);
    const text = [
      `Заминка в команде по карточке «${row.task_title}» (${row.task_id}), план ${row.plan_id}.`,
      `Шаг «${row.title}» (${row.slot}, id ${subtaskId}) ${STALLED_HEADLINE[kind]}.`,
      `Событие сторожа зависших шагов, ${eventLabel(attemptKey)}.`,
      detail ? `Подробности: ${detail.slice(0, 600)}` : "",
      ...(kind === "stalled_blocked" ? BLOCK_GUIDE : TAIL),
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
