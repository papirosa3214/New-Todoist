// Чип «Память обновлена» в личной комнате владельца с ролью.
// Отдельно от slotMemoryObserver: тот пишет только в memories (владелец
// 03.11.2026 — роль вызов не видит; чип — уведомление человеку).
import crypto from "node:crypto";
import db from "../db.js";
import { ensurePersonalRoom } from "../lib/chatRooms.js";
import { loadChatMessage } from "../lib/chatMessages.js";
import { broadcastToUsers } from "../ws.js";
import type { SlotSnapshotRow } from "./slotWorkSnapshot.js";

const SYSTEM_USER_ID = "taskflow_system";

/** Только personal owner↔role. Не тема задачи и не dm ролей. */
function resolveMemoryChipChatId(snapshot: SlotSnapshotRow): string | null {
  const roleId =
    snapshot.author_id ??
    (
      db
        .prepare(
          "SELECT id FROM users WHERE role_key = ? AND type = 'ai' AND COALESCE(archived, 0) = 0 ORDER BY id LIMIT 1",
        )
        .get(snapshot.role_key) as { id: string } | undefined
    )?.id ??
    (snapshot.role_key ? `role_${snapshot.role_key}` : null);
  if (!roleId) return null;
  const chatId = ensurePersonalRoom(roleId);
  if (!chatId) return null;
  const kind = db.prepare("SELECT room_kind FROM chats WHERE id = ?").get(chatId) as
    | { room_kind: string | null }
    | undefined;
  if (kind?.room_kind !== "personal") return null;
  return chatId;
}

export function postMemoryUpdateChip(
  snapshot: SlotSnapshotRow,
  update: { title: string | null; kind: string; confidence: number | null },
): void {
  const chatId = resolveMemoryChipChatId(snapshot);
  if (!chatId) return;
  const title = update.title?.trim() || null;
  const text = title ? `Память обновлена · ${title}` : "Память обновлена";
  const id = crypto.randomUUID();
  const steps = JSON.stringify({
    duration_ms: 0,
    items: [],
    memory_update: {
      title,
      kind: update.kind,
      confidence: update.confidence,
    },
  });
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, task_id, message_type, steps)
         VALUES (?, ?, ?, 'chat', ?, ?, 'system', ?)`,
      ).run(id, SYSTEM_USER_ID, text, chatId, snapshot.task_id, steps);
      db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(chatId);
    })();
  } catch (error) {
    console.warn(
      "[slot-memory-observer] чип в чат не записан:",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  const message = loadChatMessage(id);
  if (!message) return;
  const audience = (
    db
      .prepare(
        `SELECT m.member_id FROM chat_members m
          JOIN users u ON u.id = m.member_id
         WHERE m.chat_id = ? AND COALESCE(u.type, '') != 'ai'`,
      )
      .all(chatId) as { member_id: string }[]
  ).map((row) => row.member_id);
  if (audience.length) broadcastToUsers(audience, { type: "chat:new", message });
}
