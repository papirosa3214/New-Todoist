// MAK-77: запись модели и провайдера в открытую попытку при запуске роли.
//
// Попытки (`attempts`) заводятся в момент захвата задачи/шага, но `model`
// там часто пуст: роль знает, на какой модели её реально запускают, только
// внутри `runRoleInProcessUnserialized` (после резолва routing). Отсюда
// нельзя посчитать расход по моделям и собрать экран лимитов.
//
// Вызываем это сразу после того, как модель проверена и доступна: находим
// ТЕКУЩУЮ открытую попытку (для шага — `subtasks.current_attempt_id`, для
// задачи целиком — `tasks.current_attempt_id`) и проставляем `model`/
// `provider`, если `model` у неё ещё пустой. Первая запись выигрывает —
// повторные заходы (resume/continuation) не перетирают то, что уже стоит.
//
// Возвращаем число обновлённых строк (0 или 1): 0 — попытки нет, она уже
// закрыта (`ended_at` заполнен) или модель в ней уже записана.
import db from "../db.js";

export function recordAttemptModel(params: {
  taskId: string;
  subtaskId?: string | null;
  modelId: string;
  provider: string;
}): number {
  // Открытая попытка привязана либо к шагу, либо к задаче целиком.
  const attemptId = params.subtaskId
    ? (db.prepare("SELECT current_attempt_id FROM subtasks WHERE id = ?").get(params.subtaskId) as { current_attempt_id: string | null } | undefined)?.current_attempt_id
    : (db.prepare("SELECT current_attempt_id FROM tasks WHERE id = ?").get(params.taskId) as { current_attempt_id: string | null } | undefined)?.current_attempt_id;
  if (!attemptId) return 0;
  // Пишем только в живую попытку (ended_at IS NULL) и только пока model
  // пустая. Иначе — не трогаем и возвращаем 0.
  const changed = db.prepare(
    "UPDATE attempts SET model = ?, provider = ? WHERE id = ? AND ended_at IS NULL AND (model IS NULL OR model = '')",
  ).run(params.modelId, params.provider, attemptId);
  return changed.changes;
}
