import crypto from "node:crypto";
import db from "../db.js";
import { stopChatWorkPlan } from "../lib/subtaskWorkPlan.js";

export function chatDeliveryMaxRestarts(): number {
  const raw = Number(process.env.TASKFLOW_CHAT_DELIVERY_MAX_RESTARTS
    ?? process.env.TASKFLOW_CHAT_DELIVERY_RECLAIMS
    ?? process.env.TASKFLOW_CHAT_DELIVERY_MAX_ATTEMPTS ?? 2);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2;
}
function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
export function deliveryRestartCount(payload: Record<string, unknown>): number {
  // Old records used independent counters. Adopt their sum, never reset history.
  return Math.max(count(payload.restartCount), count(payload.retryCount) + count(payload.reclaimCount));
}
export type DeliveryRestartReason = "execution_failed" | "lease_expired" | "server_restarted";

/** One transaction covers the budget, transition and terminal notification. */
export function restartDelivery(
  id: string, reason: DeliveryRestartReason, from: "failed" | "picked",
  maxRestarts = chatDeliveryMaxRestarts(),
): "restarted" | "exhausted" | "skipped" {
  return db.transaction(() => {
    const row = db.prepare("SELECT q.*, c.task_id FROM chat_message_queue q LEFT JOIN chats c ON c.id=q.chat_id WHERE q.id=?")
      .get(id) as {status:string;payload_json:string;chat_id:string;role_id:string;message_id:string|null;task_id:string|null}|undefined;
    if (!row || row.status !== from) return "skipped";
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload_json || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
    } catch { /* Retain the obligation even if its diagnostic payload was corrupt. */ }
    if (payload.expired) return "skipped";
    const used = deliveryRestartCount(payload);
    if (used >= maxRestarts) {
      const notify = !payload.retryExhausted;
      Object.assign(payload, {restartCount:used,retryExhausted:1,expired:1,lastRestartReason:reason});
      db.prepare("UPDATE chat_message_queue SET status='failed',finished_at=datetime('now'),updated_at=datetime('now'),payload_json=? WHERE id=? AND status=?")
        .run(JSON.stringify(payload),id,from);
      if (notify) {
        // Общий бюджет повторов исчерпан окончательно: план останавливается с
        // явной причиной, второго молчаливого повтора нет (карточка b504958a, §7).
        stopChatWorkPlan(row.chat_id, row.role_id, "budget_exhausted");
        const explanation = payload.failureReason === "queue_wait_timeout" ? "истёк срок ожидания очереди"
          : {execution_failed:"ход завершился ошибкой",lease_expired:"потеряна аренда выполнения",server_restarted:"сервер перезапустился до ответа"}[reason];
        const text = `Роль не смогла ответить: исчерпан общий бюджет повторов (${used}). Причина: ${explanation}. Чат ${row.chat_id}, сообщение ${row.message_id ?? id}. Повтори сообщение в чате, чтобы продолжить вручную.`;
        const owners = db.prepare("SELECT id FROM users WHERE role='owner' AND type='human' AND COALESCE(archived,0)=0").all() as {id:string}[];
        for (const owner of owners)
          db.prepare("INSERT INTO notifications(id,user_id,type,task_id,text) VALUES(?,?,'delivery_retry_exhausted',?,?)")
            .run(crypto.randomUUID(),owner.id,row.task_id,text);
      }
      return "exhausted";
    }
    payload.restartCount = used + 1;
    payload.lastRestartReason = reason;
    // Keep legacy diagnostics readable while sharing one authoritative budget.
    const legacyKey = reason === "execution_failed" ? "retryCount" : "reclaimCount";
    payload[legacyKey] = count(payload[legacyKey]) + 1;
    db.prepare("UPDATE chat_message_queue SET status='pending',picked_at=NULL,finished_at=NULL,updated_at=datetime('now'),payload_json=? WHERE id=? AND status=?")
      .run(JSON.stringify(payload),id,from);
    return "restarted";
  })();
}
