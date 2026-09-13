// Спек 1.2, 1.2.7 — триггеры авто-подсказки консультации (R7).
//
// Серверная сторона: хранение пометки «consultation_suggested» и помощник
// для записи. Триггерную логику (когда срабатывает) считает trigger.py
// после каждого действия агента (см. attempt_should_consult там же); здесь
// только регистрация факта.
//
// R7: (а) > 2 правок в одном файле за попытку без зелёных тестов;
//     (б) общий diff > 300 строк.
//
// reasons накапливаются как множество — один раз зашёл «diff_size», и до
// конца попытки эта причина стоит. Агент сам решает, идти ли за
// консультацией (R7 — «агент может игнорировать»). Пометка живёт в двух
// местах для надёжности чтения:
//   - attempts.consultation_suggested_reasons (JSON-массив) — для быстрого
//     GET /api/tasks/:id;
//   - task_events с kind='consultation_suggested' — для аудита в ленте
//     задачи (compass и activity читают task_events).

import db from "../db.js";
import { logEvent } from "../agentState.js";

/** Допустимые коды причин. Жёсткий список — UI и тесты сверяются. */
export const CONSULTATION_REASONS = ["diff_size", "edits_no_tests"] as const;
export type ConsultationReason = (typeof CONSULTATION_REASONS)[number];

function isValidReason(value: string): value is ConsultationReason {
  return (CONSULTATION_REASONS as readonly string[]).includes(value);
}

interface RecordConsultationSuggestionParams {
  taskId: string;
  attemptId: string;
  reasons: string[];
  /** Кто сигнализирует (агент/trigger.py). null = системный (на будущее). */
  actorId?: string | null;
}

interface RecordConsultationSuggestionResult {
  /** Итоговое множество причин после объединения. */
  reasons: ConsultationReason[];
  /** true, если хотя бы одна новая причина добавлена в этой записи. */
  added: boolean;
  /** false, если попытка не найдена для этой задачи. Вызывающий должен
   *  вернуть 404 — операция бессмысленна, если attempt_id не существует
   *  или не принадлежит указанной задаче. */
  attemptFound: boolean;
}

/**
 * Сливает новые причины с уже записанными на попытке и пишет task_event.
 *
 * - Невалидные причины (не из `CONSULTATION_REASONS`) отбрасываются молча.
 * - Дубликаты игнорируются (множество, не счётчик).
 * - Пустой массив причин — no-op (защита от случайного вызова).
 *
 * Возвращает `{ reasons, added }`: `added` пригодится вызывающему, чтобы
 * решить, нужен ли отдельный лог «триггер сработал впервые за попытку».
 */
export function recordConsultationSuggestion(
  params: RecordConsultationSuggestionParams,
): RecordConsultationSuggestionResult {
  const incoming = Array.from(
    new Set(params.reasons.filter(isValidReason)),
  );

  // Один запрос в начале — проверяем, что попытка существует и привязана
  // именно к этой задаче. Без этого вызов с чужим или выдуманным
  // attempt_id молча возвращал 200 — а должен 404, иначе это тихая
  // дыра для пустых событий в ленте.
  const existingRow = db
    .prepare(
      "SELECT consultation_suggested_reasons FROM attempts WHERE id = ? AND task_id = ?",
    )
    .get(params.attemptId, params.taskId) as
    | { consultation_suggested_reasons: string | null }
    | undefined;
  if (!existingRow) {
    return {
      reasons: [],
      added: false,
      attemptFound: false,
    };
  }

  if (incoming.length === 0) {
    // Пусто — ничего не пишем, читаем текущее состояние как есть.
    return {
      reasons: parseReasons(existingRow.consultation_suggested_reasons),
      added: false,
      attemptFound: true,
    };
  }

  const tx = db.transaction(() => {
    const existing = parseReasons(existingRow.consultation_suggested_reasons);
    const merged = Array.from(new Set([...existing, ...incoming]));
    const added = merged.length > existing.length;

    if (added) {
      db.prepare(
        "UPDATE attempts SET consultation_suggested_reasons = ? WHERE id = ? AND task_id = ?",
      ).run(JSON.stringify(merged), params.attemptId, params.taskId);
      logEvent({
        taskId: params.taskId,
        actorId: params.actorId ?? null,
        kind: "consultation_suggested",
        field: incoming.length === 1 ? incoming[0] : "multiple",
        toValue: JSON.stringify(merged),
      });
    }
    return { reasons: merged, added };
  });
  return { ...tx(), attemptFound: true };
}

/**
 * Снимок текущих причин на попытке (для ответов API). Возвращает [] если
 * столбец NULL, попытки нет, или JSON сломан — это «нет пометки», а не
 * «ошибка чтения».
 */
export function getConsultationSuggestionReasons(
  taskId: string,
  attemptId: string,
): ConsultationReason[] {
  const row = db
    .prepare(
      "SELECT consultation_suggested_reasons FROM attempts WHERE id = ? AND task_id = ?",
    )
    .get(attemptId, taskId) as
    | { consultation_suggested_reasons: string | null }
    | undefined;
  return parseReasons(row?.consultation_suggested_reasons);
}

function parseReasons(raw: string | null | undefined): ConsultationReason[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidReason);
  } catch {
    return [];
  }
}
