// Самозамена исполнителя слота — только с одобрения владельца (владелец 07.11.2026).
//
// Правило владельца: «без меня никто ничего не сделает». Роль может ПОПРОСИТЬ
// заменить свой же зависший слот, но замена выполняется только после того, как
// владелец нажал кнопку (ответ на вопрос через `taskflow_ask_user_question`).
// Сам по себе вызов роли ничего не перезапускает: он создаёт заявку `pending`.
//
// Почему отдельная таблица, а не поле в вопросе: вопрос — это разговор с
// владельцем (payload валидируется строго по формату пакета), а заявка — это
// состояние слота. Их жизненные циклы разные: вопрос может истечь, а заявка
// остаться ожидающей.
import crypto from "node:crypto";
import db from "../db.js";
import { logEvent } from "../agentState.js";

export type SlotReplacementRequest = {
  id: string;
  subtask_id: string;
  task_id: string;
  role_key: string;
  requested_by: string;
  reason: string;
  question_id: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "applied" | "failed";
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  error: string | null;
};

/** Сколько живёт заявка. После — считается истёкшей: владелец не ответил. */
export const SLOT_REQUEST_TTL_MINUTES = 30;

function row(id: string): SlotReplacementRequest | undefined {
  return db.prepare("SELECT * FROM slot_replacement_requests WHERE id = ?").get(id) as
    | SlotReplacementRequest
    | undefined;
}

/** Заявка роли на замену своего слота. Ничего не перезапускает. */
export function requestSlotReplacement(args: {
  subtaskId: string;
  taskId: string;
  roleKey: string;
  requestedBy: string;
  reason: string;
}): SlotReplacementRequest {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO slot_replacement_requests(id, subtask_id, task_id, role_key, requested_by, reason, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(id, args.subtaskId, args.taskId, args.roleKey, args.requestedBy, args.reason.slice(0, 1000));
  logEvent({
    taskId: args.taskId,
    actorId: args.requestedBy,
    kind: "slot_replacement_requested",
    field: args.subtaskId,
    toValue: JSON.stringify({ request_id: id, role: args.roleKey, reason: args.reason.slice(0, 300) }),
  });
  return row(id)!;
}

/** Привязать заявку к вопросу владельцу — по нему придёт «да» или «нет». */
export function attachQuestion(requestId: string, questionId: string): void {
  db.prepare("UPDATE slot_replacement_requests SET question_id = ? WHERE id = ?").run(questionId, requestId);
}

/** Заявка, ожидающая ответа по конкретному вопросу. */
export function pendingRequestForQuestion(questionId: string): SlotReplacementRequest | undefined {
  return db
    .prepare("SELECT * FROM slot_replacement_requests WHERE question_id = ? AND status = 'pending'")
    .get(questionId) as SlotReplacementRequest | undefined;
}

/** Истёкшие заявки закрываем: владелец не ответил — замены не будет. */
export function expireStaleRequests(): number {
  return db
    .prepare(
      `UPDATE slot_replacement_requests
          SET status='expired', decided_at=datetime('now')
        WHERE status='pending'
          AND created_at <= datetime('now', ?)`,
    )
    .run(`-${SLOT_REQUEST_TTL_MINUTES} minutes`).changes;
}

export function markRequest(id: string, status: SlotReplacementRequest["status"], decidedBy: string | null, error?: string): void {
  db.prepare(
    `UPDATE slot_replacement_requests
        SET status=?, decided_at=datetime('now'), decided_by=?, error=?
      WHERE id=?`,
  ).run(status, decidedBy, error ?? null, id);
}

export function slotReplacementRequest(id: string): SlotReplacementRequest | undefined {
  return row(id);
}

/**
 * Одобрен ли вариант «заменить» в ответе владельца.
 *
 * Смотрим не на текст модели, а на то, какой ВАРИАНТ выбрал владелец:
 * метка варианта должна начинаться со «Заменить». Всё остальное (в том числе
 * «Отмена» и любой свой ответ владельца) — отказ.
 */
export function ownerApprovedReplacement(answer: { answers: Array<{ questionIndex: number; selected: string[] }> }): boolean {
  return answer.answers.some((entry) => entry.selected.some((label) => /^заменить/i.test(String(label).trim())));
}
