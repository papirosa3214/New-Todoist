// Применение одобренной заявки на самозамену слота (владелец 07.11.2026).
//
// Отдельный модуль, чтобы не тянуть в `chats.ts` тяжёлый runtime-граф и не
// плодить циклы импортов: маршрут ответа владельца просто зовёт эту функцию
// после того, как вопрос закрыт.
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { restartOccupiedSlot } from "./slotRestart.js";
import {
  markRequest,
  ownerApprovedReplacement,
  pendingRequestForQuestion,
  type SlotReplacementRequest,
} from "./slotReplacementRequest.js";

/**
 * Владелец ответил на вопрос по заявке: «заменить» — заменяем слот, иначе
 * закрываем заявку как отклонённую. Возвращает описание исхода для ответа
 * клиенту (не бросает: ответ владельца уже сохранён, замена — побочный эффект).
 */
export async function applySlotReplacementAnswer(
  questionId: string,
  answer: { answers: Array<{ questionIndex: number; selected: string[] }> },
  decidedBy: string,
): Promise<{ replaced: boolean; request?: SlotReplacementRequest; error?: string } | null> {
  const request = pendingRequestForQuestion(questionId);
  if (!request) return null;

  if (!ownerApprovedReplacement(answer)) {
    markRequest(request.id, "rejected", decidedBy);
    logEvent({
      taskId: request.task_id,
      actorId: decidedBy,
      kind: "slot_replacement_rejected",
      field: request.subtask_id,
      toValue: JSON.stringify({ request_id: request.id }),
    });
    return { replaced: false, request };
  }

  markRequest(request.id, "approved", decidedBy);
  try {
    // Заменяем ровно ту роль, что просила: роль берётся из заявки, а не из
    // аргументов модели, и повторно сверяется в restartOccupiedSlot.
    const result = await restartOccupiedSlot(request.subtask_id, request.role_key, decidedBy, request.reason);
    markRequest(request.id, "applied", decidedBy);
    logEvent({
      taskId: request.task_id,
      actorId: decidedBy,
      kind: "slot_replacement_applied",
      field: request.subtask_id,
      toValue: JSON.stringify({ request_id: request.id, role: request.role_key }),
    });
    return { replaced: true, request };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markRequest(request.id, "failed", decidedBy, message.slice(0, 500));
    logEvent({
      taskId: request.task_id,
      actorId: decidedBy,
      kind: "slot_replacement_failed",
      field: request.subtask_id,
      toValue: JSON.stringify({ request_id: request.id, error: message.slice(0, 300) }),
    });
    return { replaced: false, request, error: message };
  }
}

/** Заявки, у которых владелец не ответил за отведённое время. */
export function closeExpiredRequests(): void {
  const rows = db
    .prepare(
      `SELECT id, task_id, subtask_id FROM slot_replacement_requests
        WHERE status='pending' AND created_at <= datetime('now', ?)`,
    )
    .all("-30 minutes") as Array<{ id: string; task_id: string; subtask_id: string }>;
  for (const row of rows) {
    markRequest(row.id, "expired", null);
    logEvent({
      taskId: row.task_id,
      actorId: "system",
      kind: "slot_replacement_expired",
      field: row.subtask_id,
      toValue: JSON.stringify({ request_id: row.id }),
    });
  }
}
