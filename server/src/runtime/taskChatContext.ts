import db from "../db.js";
import { ownerId } from "../lib/ownerDraft.js";
import { ensureTaskRoom } from "../lib/projectTopics.js";
import { roleUserId } from "../roleRouting.js";

/** Куда инструмент «в чат» пишет: чат и сообщение, на которое отвечает (в карточке — нет). */
export type ChatContext = { chatId: string; messageId: string | null };

/** Чат задачи для инструментов «в чат» из карточки (владелец 07.11.2026: «не должно быть
 *  только из чата»). Находится или заводится при первом обращении к chatId — сборка набора
 *  инструментов чатов не создаёт. */
export function lazyTaskChatContext(role: string, taskId: string): ChatContext {
  let resolved: ChatContext | undefined;
  const get = () => (resolved ??= resolveTaskChat(role, taskId));
  return {
    get chatId() { return get().chatId; },
    get messageId() { return get().messageId; },
  };
}

/** Открытая комната задачи; нет — сервер заводит штатную (lib/projectTopics.ts).
 *  Проект с 08.11.2026 к этому не причастен: комната задачи заводится независимо
 *  от него, а своих разговорных чатов у проектов больше не существует.
 *  Владелец и роль — участники: вопрос и файл должны дойти до владельца. */
export function resolveTaskChat(role: string, taskId: string): ChatContext {
  const owner = ownerId();
  const roleId = roleUserId(role);
  return db.transaction(() => {
    let chatId = (db.prepare(
      "SELECT id FROM chats WHERE task_id = ? AND room_kind = 'task' AND closed_at IS NULL ORDER BY updated_at DESC LIMIT 1",
    ).get(taskId) as { id: string } | undefined)?.id;
    if (!chatId) {
      const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as
        | { title: string }
        | undefined;
      if (!task) throw new Error("Карточка не найдена — писать в её чат некуда.");
      chatId = ensureTaskRoom(taskId) ?? undefined;
      if (!chatId) throw new Error("Комната задачи не завелась — писать некуда.");
    }
    for (const member of [owner, roleId]) {
      if (member) db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(chatId, member);
    }
    return { chatId, messageId: null };
  })();
}
