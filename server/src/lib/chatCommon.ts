import crypto from "node:crypto";
import db from "../db.js";
import { broadcastToUsers } from "../ws.js";
import { loadChatMessage } from "./chatMessages.js";

/**
 * Общий групповой чат (карточка ca816271, документ проектирования
 * d748e4f4-f502-4002-b622-f070be0d8438, п. 2–3).
 *
 * Один чат на всю систему: все активные роли, Секретарь, владелец и
 * оркестратор. Здесь закреплён регламент работы. Сервер сам сюда не пишет
 * ничего, кроме первичного закреплённого регламента: единственные
 * источники сообщений — владелец из клиента и роль через свой инструмент.
 */

export const COMMON_CHAT_ID = "chat-common";
export const COMMON_REGULATOR_MESSAGE_ID = "chat-common-regulator";

/** Текст регламента из паспортов ролей — собирается при первичном посеве. */
function regulatorText(): string {
  const roles = db
    .prepare("SELECT key, title, summary FROM roles WHERE enabled = 1 ORDER BY position, key")
    .all() as Array<{ key: string; title: string; summary: string | null }>;
  return [
    "Регламент общего чата TaskFlow.",
    "Здесь все роли, Секретарь и владелец. Сервер сюда не пишет — только человек и роль по своей команде.",
    "Обращение к участнику — только через @; упоминание имени без @ никого не будит.",
    "Кто за что отвечает:",
    ...roles.map((r) => `@${r.key} — ${r.title}: ${r.summary ?? ""}`.trimEnd()),
    "Секретарь — личный помощник владельца: разговор, вопросы, разбор надиктовки.",
  ].join("\n");
}

/** Идемпотентно завести общий чат, состав и закреплённый регламент. */
export function ensureCommonChat(): string | null {
  const owner = (
    db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as
      | { id: string }
      | undefined
  )?.id;
  if (!owner) return null;
  return db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO chats (id, title, kind, created_by, project_id, parent_chat_id, task_id)
       VALUES (?, 'Общий чат', 'group', ?, NULL, NULL, NULL)`,
    ).run(COMMON_CHAT_ID, owner);
    db.prepare(
      "INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)",
    ).run(COMMON_CHAT_ID, owner);
    db.exec(`
      INSERT OR IGNORE INTO chat_members (chat_id, member_id)
      SELECT '${COMMON_CHAT_ID}', u.id FROM users u
       WHERE COALESCE(u.archived, 0) = 0 AND (
         (u.type = 'ai' AND u.role = 'agent' AND u.role_key IN (SELECT key FROM roles WHERE enabled = 1))
         OR (u.id = 'u-secretary')
         OR u.role = 'orchestrator'
       );
    `);
    const systemId = (
      db.prepare("SELECT id FROM users WHERE id = 'taskflow_system'").get() as
        | { id: string }
        | undefined
    )?.id;
    const pinned = (
      db.prepare("SELECT pinned_message_id FROM chats WHERE id = ?").get(COMMON_CHAT_ID) as
        | { pinned_message_id: string | null }
        | undefined
    )?.pinned_message_id;
    if (systemId && !pinned) {
      db.prepare(
        `INSERT OR IGNORE INTO chat_messages (id, from_user_id, text, channel, chat_id, message_type)
         VALUES (?, ?, ?, 'chat', ?, 'system')`,
      ).run(COMMON_REGULATOR_MESSAGE_ID, systemId, regulatorText(), COMMON_CHAT_ID);
      db.prepare("UPDATE chats SET pinned_message_id = ? WHERE id = ?").run(
        COMMON_REGULATOR_MESSAGE_ID,
        COMMON_CHAT_ID,
      );
    }
    return COMMON_CHAT_ID;
  })();
}

/** Закрепить за сообщением-регламентом общий чат (ручка владельца). */
export function pinCommonRegulator(): void {
  ensureCommonChat();
  db.prepare("UPDATE chats SET pinned_message_id = ? WHERE id = ?").run(
    COMMON_REGULATOR_MESSAGE_ID,
    COMMON_CHAT_ID,
  );
}

export type ChatWriteOrigin = "user" | "role_tool" | "bootstrap" | "system";

/**
 * Инвариант п. 3: в общий чат пишут только владелец, роль через инструмент и
 * первичный регламент. Любой другой путь (системные уведомления, события
 * плана, сводки, сообщения о сбое хода, typing-служебки) в общий чат
 * запрещён. Бросаем — вызывающая сторона обязана выбрать другой адресат.
 */
export function assertCommonChatWritable(chatId: string, origin: ChatWriteOrigin): void {
  if (chatId !== COMMON_CHAT_ID) return;
  if (origin === "user" || origin === "role_tool" || origin === "bootstrap") return;
  throw new Error("в общий чат пишут только владелец, роль через инструмент и регламент");
}

export function broadcastCommonMessage(messageId: string): void {
  const message = loadChatMessage(messageId);
  const members = (
    db.prepare("SELECT member_id FROM chat_members WHERE chat_id = ?").all(COMMON_CHAT_ID) as Array<{
      member_id: string;
    }>
  ).map((r) => r.member_id);
  broadcastToUsers(members, { type: "chat:new", message });
}

/** Уникальный id для регулятора при пересборке (не используется в миграции). */
export const newCommonMessageId = () => crypto.randomUUID();
