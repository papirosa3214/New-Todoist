/**
 * Устойчивая доставка сообщений в слот плана (карточка 6f180f38, шаг 3
 * «Устойчивая доставка сообщений и результатов ролям»). Закрывает
 * подтверждённый аудитом (карточка 57d045eb, пробел №5) пробел: строки
 * `slot_topic_inbox` с `delivered_at IS NULL` копятся на закрытых и
 * прерванных слотах, пока владелец не вмешается руками.
 *
 * Раньше хвосты образовывались двумя путями:
 * 1) `deliverTopicToWork` (inProcessRun.ts:759) делал `INSERT OR IGNORE`
 *    без `delivered_at` для пар (chat_message, subtask), когда активной
 *    сессии не было, а слот ещё не стартовал — так и висело;
 * 2) после прерывания хода (`recoverInterruptedPlanSubtasks`,
 *    `interrupted` outcome) старая попытка закрывалась, новый запуск
 *    начинался с нуля, а инбокс оставался нетронутым.
 *
 * Эти пути теперь закрываются явным `closeStaleInboxForSubtask` на двух
 * границах: успешная сдача слота (`taskflow_subtask_done`) и снятие
 * `in_progress` при восстановлении после обрыва. Идемпотентно — повторный
 * вызов не делает ничего, если все строки уже доставлены.
 *
 * Что НЕ делается здесь:
 *   — повтор самой доставки (это работает существующий
 *     `slotConversation` / `deliverTopicToWork`); модуль только закрывает
 *     «зависшие» строки, чтобы инбокс не рос бесконечно;
 *   — изменение схемы `slot_topic_inbox` (расширение полями статуса/причины
 *     выходит за границы карточки — для владельца достаточно факта, что
 *     хвостов больше нет).
 */
import db from "../db.js";

/**
 * Закрывает все `delivered_at IS NULL` строки указанного слота. Возвращает
 * число закрытых строк. Повторный вызов — no-op: `WHERE delivered_at IS NULL`
 * гарантирует идемпотентность на повторе и на частично закрытом инбоксе.
 */
export function closeStaleInboxForSubtask(subtaskId: string): number {
  const result = db
    .prepare(
      "UPDATE slot_topic_inbox SET delivered_at = datetime('now') " +
        "WHERE subtask_id = ? AND delivered_at IS NULL",
    )
    .run(subtaskId);
  return Number(result.changes ?? 0);
}

/**
 * Сколько сообщений темы ещё не доставлено в этот слот. Используется
 * тестами и диагностикой; на горячем пути доставки не нужен.
 */
export function pendingInboxCountForSubtask(subtaskId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM slot_topic_inbox " +
        "WHERE subtask_id = ? AND delivered_at IS NULL",
    )
    .get(subtaskId) as { n: number };
  return Number(row.n);
}

/**
 * Диагностический хвост для задачи: сколько pending-сообщений осталось
 * во всех её слотах. Полезно после миграций и в изолированных сценариях.
 */
export function pendingInboxCountsByTask(taskId: string): Array<{
  subtask_id: string;
  pending: number;
}> {
  return db
    .prepare(
      "SELECT subtask_id, COUNT(*) AS pending FROM slot_topic_inbox " +
        "WHERE delivered_at IS NULL AND subtask_id IN " +
        "(SELECT id FROM subtasks WHERE task_id = ?) " +
        "GROUP BY subtask_id ORDER BY subtask_id",
    )
    .all(taskId) as Array<{ subtask_id: string; pending: number }>;
}