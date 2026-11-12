import crypto from "node:crypto";
import db from "../db.js";
import { taskRoomOf } from "./projectTopics.js";

/**
 * Архив комнаты задачи по окончательному закрытию (владелец 08.11.2026;
 * спецификация `docs/2026-11-08-role-slot-chat-branches-spec.md` §8).
 *
 * До этого закрытие задачи ставило комнате только `closed_at`: комната
 * переставала быть «открытой», но доставка в неё продолжалась — очередь
 * сообщений, карточки передач, рабочие дочерние связи слотов. После
 * окончательного закрытия работа уже никому не нужна, а содержимое архива не
 * должно приходить на телефон в фоне.
 *
 * Что делает `archiveTaskRoom`:
 *  • ставит комнате `archived_at` (и `closed_at`, если его ещё нет) — один раз;
 *  • снимает недоставленные доставки: строки `chat_message_queue` в статусах
 *    `pending`/`picked` становятся `superseded`, неотданные сообщения
 *    `slot_topic_inbox` удаляются;
 *  • переводит рабочие дочерние связи комнаты в `archived` — доставка работы
 *    слоту прекращается (`lib/chatChildren.ts` её больше не создаёт);
 *  • кладёт владельцам минимальное событие о закрытии (`task_room_archived`):
 *    строка и заголовок задачи, без содержимого переписки.
 *
 * Личные комнаты ролей не трогаются: архив — только у комнаты задачи.
 */

/**
 * Работа по слоту не началась, потому что комната задачи в архиве. Владелец
 * (08.11.2026): восстанавливать архивную комнату не надо — пусть будет сказано
 * прямо, что делать дальше, вместо тихого молчания.
 */
export function refuseArchivedWork(taskId: string): void {
  const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title?: string } | undefined;
  const text = `Сессия не создалась: комната задачи «${task?.title ?? taskId}» в архиве. Пересоздайте задачу заново.`;
  const stmt = db.prepare(
    "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, ?, ?, ?, NULL)",
  );
  for (const userId of owners()) {
    const exists = db
      .prepare(
        `SELECT 1 FROM notifications WHERE user_id = ? AND type = ? AND task_id = ? AND text = ? AND read = 0 LIMIT 1`,
      )
      .get(userId, TASK_ROOM_ARCHIVED_TYPE, taskId, text);
    if (exists) continue;
    stmt.run(crypto.randomUUID(), userId, TASK_ROOM_ARCHIVED_TYPE, taskId, text);
  }
}

export interface TaskRoomArchive {
  roomId: string | null;
  archived: boolean;
  queue: number;
  inbox: number;
  children: number;
  notices: number;
}

export const TASK_ROOM_ARCHIVED_TYPE = "task_room_archived";

/** Архивная комната или нет. Один запрос — чтобы не тянуть всю строку чата. */
export function roomArchivedAt(chatId: string): string | null {
  const row = db.prepare("SELECT archived_at FROM chats WHERE id = ?").get(chatId) as
    | { archived_at: string | null }
    | undefined;
  return row?.archived_at ?? null;
}

function owners(): string[] {
  return (
    db
      .prepare("SELECT id FROM users WHERE role = 'owner' AND COALESCE(archived, 0) = 0")
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function notifyArchived(taskId: string, roomId: string, reason: string | null): number {
  const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title?: string } | undefined;
  const text = `Задача «${task?.title ?? taskId}» закрыта: комната в архиве, новых сообщений в ней не будет.${reason ? ` Причина: ${reason}.` : ""}`;
  const stmt = db.prepare(
    "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, ?, ?, ?, NULL)",
  );
  let count = 0;
  for (const userId of owners()) {
    const exists = db
      .prepare(
        `SELECT 1 FROM notifications WHERE user_id = ? AND type = ? AND task_id = ? AND text = ?
           AND read = 0 LIMIT 1`,
      )
      .get(userId, TASK_ROOM_ARCHIVED_TYPE, taskId, text);
    if (exists) continue;
    stmt.run(crypto.randomUUID(), userId, TASK_ROOM_ARCHIVED_TYPE, taskId, text);
    count += 1;
  }
  void roomId;
  return count;
}

/**
 * Окончательное закрытие: комната в архив, фоновая доставка снята, владельцу —
 * минимальное событие. Повтор ничего не меняет и не плодит уведомлений.
 */
export function archiveTaskRoom(
  taskId: string,
  options: { reason?: string | null } = {},
): TaskRoomArchive {
  const roomId = taskRoomOf(taskId);
  if (!roomId) return { roomId: null, archived: false, queue: 0, inbox: 0, children: 0, notices: 0 };

  let archived = false;
  let queue = 0;
  let inbox = 0;
  let children = 0;
  let notices = 0;

  db.transaction(() => {
    const row = db.prepare("SELECT archived_at, closed_at FROM chats WHERE id = ?").get(roomId) as
      | { archived_at: string | null; closed_at: string | null }
      | undefined;
    if (!row) return;
    if (!row.archived_at) {
      db.prepare(
        `UPDATE chats SET archived_at = datetime('now'),
                closed_at = COALESCE(closed_at, datetime('now')),
                updated_at = datetime('now')
          WHERE id = ?`,
      ).run(roomId);
      archived = true;
    } else if (!row.closed_at) {
      db.prepare("UPDATE chats SET closed_at = datetime('now') WHERE id = ?").run(roomId);
    }

    queue = db
      .prepare(
        `UPDATE chat_message_queue SET status = 'superseded', finished_at = datetime('now')
          WHERE chat_id = ? AND status IN ('pending', 'picked')`,
      )
      .run(roomId).changes;

    inbox = db
      .prepare(
        `DELETE FROM slot_topic_inbox
          WHERE delivered_at IS NULL
            AND subtask_id IN (SELECT id FROM subtasks WHERE task_id = ?)`,
      )
      .run(taskId).changes;

    children = db
      .prepare(
        `UPDATE chat_child_sessions SET status = 'archived', updated_at = datetime('now')
          WHERE talk_chat_id = ? AND status != 'archived'`,
      )
      .run(roomId).changes;

    if (archived) notices = notifyArchived(taskId, roomId, options.reason ?? null);
  })();

  return { roomId, archived, queue, inbox, children, notices };
}
