import crypto from "node:crypto";
import db from "../db.js";
import { ownerId } from "../lib/ownerDraft.js";
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

/** Открытая тема задачи (или её чат); нет — тема в группе проекта, без проекта — чат
 *  задачи. Владелец и роль — участники: вопрос и файл должны дойти до владельца. */
export function resolveTaskChat(role: string, taskId: string): ChatContext {
  const owner = ownerId();
  const roleId = roleUserId(role);
  return db.transaction(() => {
    let chatId = (db.prepare(
      "SELECT id FROM chats WHERE task_id = ? AND closed_at IS NULL ORDER BY (parent_chat_id IS NULL), updated_at DESC LIMIT 1",
    ).get(taskId) as { id: string } | undefined)?.id;
    if (!chatId) {
      const task = db.prepare(
        "SELECT t.title, t.project_id, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
      ).get(taskId) as { title: string; project_id: string | null; project_name: string | null } | undefined;
      if (!task) throw new Error("Карточка не найдена — писать в её чат некуда.");
      const creator = owner ?? roleId;
      let parent: string | null = null;
      if (task.project_id) {
        parent = (db.prepare("SELECT id FROM chats WHERE project_id = ? AND parent_chat_id IS NULL").get(task.project_id) as { id: string } | undefined)?.id ?? null;
        if (!parent) {
          parent = crypto.randomUUID();
          db.prepare("INSERT INTO chats (id, title, kind, created_by, project_id) VALUES (?, ?, 'group', ?, ?)")
            .run(parent, task.project_name ?? "Проект", creator, task.project_id);
          db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(parent, creator);
        }
      }
      chatId = crypto.randomUUID();
      db.prepare("INSERT INTO chats (id, title, kind, created_by, task_id, project_id, parent_chat_id) VALUES (?, ?, 'group', ?, ?, ?, ?)")
        .run(chatId, task.title, creator, taskId, task.project_id, parent);
    }
    for (const member of [owner, roleId]) {
      if (member) db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(chatId, member);
    }
    return { chatId, messageId: null };
  })();
}
