import db from "../db.js";

/**
 * История чата для модели (владелец 08.11.2026; спецификация
 * `docs/2026-11-08-role-slot-chat-branches-spec.md` §5 «Изоляция личного
 * контекста»).
 *
 * В историю входа модели НЕ попадают:
 *  • карточки обращения (`steps.coordination`) — переговоры другой сессии или
 *    дочернего слота, это отображение, а не разговор этой комнаты;
 *  • служебные метки сессии (`is_session_marker`).
 *
 * До этого фильтра у обеих выборок истории карточка обращения попадала в
 * промпт строкой «Разработчик → Критик: вопрос в очереди» и личная сессия
 * роли начинала «помнить» чужие переговоры.
 */
export const HISTORY_SELECT = `SELECT m.task_id, m.id, m.from_user_id, m.text, m.created_at, m.recipient_subtask_id, m.subtask_id, f.name as from_name,
        (SELECT group_concat(a.file_name, ', ') FROM attachments a
          WHERE a.chat_message_id = m.id) as attachments
   FROM chat_messages m
   LEFT JOIN users f ON f.id = m.from_user_id`;

/**
 * Условие «это строка для модели, а не отображаемая карточка».
 *
 * Служебные сообщения (`message_type='system'`) — это карточки и уведомления
 * интерфейса: обращение роли к коллеге, чип «Память обновлена», «срок истёк».
 * Выжимка (`chatCheckpoint`) такие строки не берёт с самого начала; история
 * теперь по тому же правилу. Проверка координации по `steps` оставлена как
 * страховка на случай карточки, записанной без служебного типа.
 */
export function modelHistorySql(alias = "m"): string {
  const p = alias ? `${alias}.` : "";
  const coordination = `(CASE WHEN json_valid(${p}steps) THEN COALESCE(json_type(${p}steps, '$.coordination'), '') ELSE '' END)`;
  return `COALESCE(${p}is_session_marker, 0) = 0 AND COALESCE(${p}message_type, '') != 'system' AND ${coordination} <> 'object'`;
}

/** Что нового после последнего хода роли — продолжение сессии. */
export function historySince(chatId: string, triggerId: string, selfId: string, limit: number): unknown[] {
  return db
    .prepare(
      `${HISTORY_SELECT}
        WHERE m.chat_id = ? AND m.id != ? AND ${modelHistorySql("m")}
          AND m.rowid > COALESCE(
            (SELECT MAX(rowid) FROM chat_messages WHERE chat_id = ? AND from_user_id = ?), 0)
          AND m.rowid < (SELECT rowid FROM chat_messages WHERE id = ?)
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
    )
    .all(chatId, triggerId, chatId, selfId, triggerId, limit);
}

/** Первый ход сессии — история до сообщения-триггера. */
export function historyBefore(chatId: string, triggerId: string, limit: number): unknown[] {
  return db
    .prepare(
      `${HISTORY_SELECT}
        WHERE m.chat_id = ? AND m.id != ? AND ${modelHistorySql("m")}
          AND m.rowid < (SELECT rowid FROM chat_messages WHERE id = ?)
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
    )
    .all(chatId, triggerId, triggerId, limit);
}
