// Лесенка моделей для спек 1.2 (1.2.2, 1.2.3). Один источник правды для
// порядка ступеней — attempt_policies; читаем и для /api/agent/attempt-
// policies, и для расчёта next_attempt_template в /stop, и для валидации
// шаблона в /retry.
//
// Почему рекурсивный CTE, а не ORDER BY from_model или ORDER BY id:
// attempt_policies хранит «рёбра» лесенки (from_model → to_model), и
// строки лежат в порядке вставки миграции (haiku_sonnet, opus_null,
// sonnet_opus). Алфавитная сортировка по from_model даёт
// [haiku, opus, sonnet] — не лесенка; сортировка по id даёт тот же
// порядок, что и вставка. Реальный порядок ступеней — это путь от первой
// ступени (нет входящего ребра) к последней (to_model IS NULL), и
// рекурсивный CTE тут естественен.
//
// Если миграция когда-нибудь введёт нелинейную структуру (например,
// два пути на разные роли), запрос нужно будет расширять (фильтр по
// routing_role и т.п.); на текущих данных лесенка линейна.
import db from "../db.js";

/**
 * Следующая ступень лесенки для reason_code='insufficient_capability'.
 * Возвращает `{ model, runner }` или `null`, если:
 *   - reason_code не insufficient_capability (R4 спеки 1.2: лесенка
 *     работает только на эту причину),
 *   - текущая модель не входит в лесенку,
 *   - текущая модель уже на верхней ступени (to_model IS NULL).
 */
export function nextAttemptTemplate(params: {
  reasonCode: string;
  currentModel: string | null;
  runner: string | null;
}): { model: string; runner: string | null } | null {
  if (params.reasonCode !== "insufficient_capability") return null;
  if (!params.currentModel) return null;
  const next = nextStep(params.reasonCode, params.currentModel);
  if (!next) return null;
  return { model: next, runner: params.runner ?? null };
}

/**
 * Только имя следующей модели, без runner'а. Удобно в местах, где runner
 * вычисляется отдельно (тесты / next_step_for в trigger.py).
 */
export function nextStep(
  reasonCode: string,
  currentModel: string,
): string | null {
  if (reasonCode !== "insufficient_capability") return null;
  const rows = ladderModels(reasonCode);
  const idx = rows.indexOf(currentModel);
  if (idx === -1) return null;
  if (idx + 1 >= rows.length) return null;
  return rows[idx + 1];
}

/**
 * Полный упорядоченный список ступеней лесенки. Публикуется также в
 * /api/agent/attempt-policies — единая правда для всех консьюмеров.
 */
export function ladderModels(reasonCode: string): string[] {
  // Рекурсивный CTE: первая ступень — from_model без входящего ребра
  // (никто не указывает её как to_model). Дальше — от to_model текущей
  // ступени к её from_model. ORDER BY depth даёт путь по лесенке.
  const rows = db
    .prepare(
      `WITH RECURSIVE ladder(from_model, to_model, depth) AS (
         SELECT from_model, to_model, 0
           FROM attempt_policies
          WHERE reason_code = @rc
            AND from_model IS NOT NULL
            AND from_model NOT IN (
              SELECT to_model FROM attempt_policies
               WHERE reason_code = @rc AND to_model IS NOT NULL
            )
         UNION ALL
         SELECT p.from_model, p.to_model, l.depth + 1
           FROM attempt_policies p
           JOIN ladder l ON p.from_model = l.to_model
          WHERE p.reason_code = @rc
       )
       SELECT from_model FROM ladder ORDER BY depth`,
    )
    .all({ rc: reasonCode }) as Array<{ from_model: string }>;
  return rows.map((r) => r.from_model);
}

export interface AttemptLadderHistoryItem {
  id: string;
  model: string | null;
  outcome: string | null;
  reason_code: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface AttemptLadderState {
  current_step: number;
  total_steps: number;
  current_model: string | null;
  history: AttemptLadderHistoryItem[];
}

/** Read model-attempt progress for the task detail contract. */
export function attemptLadderForTask(taskId: string): AttemptLadderState {
  const models = ladderModels("insufficient_capability");
  const history = db
    .prepare(
      `SELECT id, model, outcome, reason_code, started_at, ended_at
         FROM attempts
        WHERE task_id = ? AND subtask_id IS NULL
        ORDER BY started_at ASC, rowid ASC`,
    )
    .all(taskId) as AttemptLadderHistoryItem[];
  // Проект компилируется с target ES2022, где Array.findLast ещё нет.
  // Идём с конца вручную: последний незавершённый attempt приоритетнее,
  // иначе берём последний элемент истории, как и раньше.
  let current = history.at(-1) ?? null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].ended_at === null) {
      current = history[index];
      break;
    }
  }
  const modelStep = current?.model ? models.indexOf(current.model) + 1 : 0;
  return {
    current_step: modelStep > 0 ? modelStep : Math.min(history.length, models.length),
    total_steps: models.length,
    current_model: current?.model ?? null,
    history,
  };
}
