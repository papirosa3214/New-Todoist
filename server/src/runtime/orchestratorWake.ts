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
    db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES (?,'Заминки команды','direct',?)").run(chatId, row.creator_id);
    for (const member of [row.creator_id, orch.id]) db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES (?,?)").run(chatId, member);
    const attempt = kind === "retry" && row.cycle ? ` Это попытка №${row.cycle}.` : "";
    const text = [
      `Заминка в команде по карточке «${row.task_title}» (${row.task_id}), план ${row.plan_id}.`,
      `Шаг «${row.title}» (${row.slot}, id ${subtaskId}) ${HEADLINE[kind]}.${attempt}`,
      detail ? `Подробности: ${detail.slice(0, 600)}` : "",
      kind === "approval" ? "Реши сам: taskflow_plan_proposal_decide (task_id, plan_id, op_id из подробностей, decision approve|reject). Одобряй, только если шаг нужен для результата карточки и не выходит за её границы." : "",
      "Разберись как оркестратор: taskflow_task и taskflow_plan_read. Если шаг ходит по кругу или упёрся —",
      "сними препятствие: ответь роли (taskflow_topic_send), уточни или замени шаг (taskflow_plan_ops: update_step / skip_step / add_step),",
      "либо, если нужен владелец, напиши ему конкретный вопрос в карточку (taskflow_comment). Если всё идёт штатно — ничего не делай.",
      "Работу роли сам не делай.",
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
