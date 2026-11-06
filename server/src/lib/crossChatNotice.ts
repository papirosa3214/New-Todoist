// Сообщение пришло в ход роли из другого чата: одна строка с готовыми значениями прямо в тексте хода
// (вместо постоянного правила R015 в инструкции, решение владельца 06.11.2026).
import db from "../db.js";

export function crossChatNotice(messageId: string, turnChatId: string): string {
  const row = db
    .prepare(
      `SELECT m.chat_id AS chat_id, m.from_user_id AS from_user_id, u.name AS author, c.title AS title
         FROM chat_messages m
         LEFT JOIN users u ON u.id = m.from_user_id
         LEFT JOIN chats c ON c.id = m.chat_id
        WHERE m.id = ?`,
    )
    .get(messageId) as { chat_id: string; from_user_id: string; author: string | null; title: string | null } | undefined;
  if (!row || row.chat_id === turnChatId) return "";
  const title = (row.title ?? "").trim() || row.chat_id;
  const author = row.author || row.from_user_id;
  return `Сообщение пришло из чата «${title}» от ${author}. Ответ автору — taskflow_chat_reply(message_id="${messageId}", text=…).`;
}
