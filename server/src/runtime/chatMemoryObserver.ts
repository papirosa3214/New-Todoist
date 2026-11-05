// Наблюдатель личного чата (владелец 05.11.2026): урок из разговора с ролью пишется в её
// личную память. Запускается после тишины и при закрытии сессии. Чат карточки сюда не входит:
// там работает наблюдатель сдачи шага (slotMemoryObserver.ts). Модель, порог и журнал общие.
import db from "../db.js";
import { getSetting } from "../lib/serverSettings.js";
import { recordMemoryObserverEvent } from "../lib/memoryObserverLog.js";
import { observeAndRemember } from "./slotMemoryObserver.js";

/** Меньше этого в разговоре не бывает устойчивого урока: не тратим модель. */
const MIN_TRANSCRIPT_CHARS = 200;
const MAX_TRANSCRIPT_CHARS = 12_000;
const PASS_LIMIT = 3;

/** Какие сообщения считаются разговором: без системных строк и чипов. */
const TALK = "m.channel = 'chat' AND m.message_type IS NULL AND COALESCE(m.is_session_marker, 0) = 0";
const SESSION = "c.task_id IS NULL AND c.archived_at IS NULL AND c.subagent_role_id IS NULL AND (c.room_kind IS NULL OR c.room_kind = 'personal')";

const inFlight = new Set<string>();

type TalkRow = { rowid: number; from_user_id: string; text: string; type: string | null; role_key: string | null; name: string | null };

function stripEnvelope(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.output === "string") return parsed.output;
  } catch {
    /* обычный текст */
  }
  return text;
}

/** Прочитать новые сообщения сессии и вынести уроки. Сессия читается с места прошлого запуска. */
export async function observeChatMemory(chatId: string): Promise<{ observed: number }> {
  if (inFlight.has(chatId) || !getSetting("memory_observer_enabled")) return { observed: 0 };
  inFlight.add(chatId);
  try {
    const session = db.prepare(`SELECT c.id FROM chats c WHERE c.id = ? AND ${SESSION}`).get(chatId);
    if (!session) return { observed: 0 };
    const cursor = db.prepare("SELECT last_rowid FROM chat_memory_cursor WHERE chat_id = ?").get(chatId) as { last_rowid: number } | undefined;
    const rows = db
      .prepare(
        `SELECT m.rowid AS rowid, m.from_user_id, m.text, u.type, u.role_key, u.name
           FROM chat_messages m LEFT JOIN users u ON u.id = m.from_user_id
          WHERE m.chat_id = ? AND m.rowid > ? AND ${TALK} ORDER BY m.rowid`,
      )
      .all(chatId, cursor?.last_rowid ?? 0) as TalkRow[];
    if (!rows.length) return { observed: 0 };
    const last = rows[rows.length - 1].rowid;
    // Курсор сдвигается до вызова модели: сбой остаётся в журнале и не крутится по кругу.
    db.prepare(
      `INSERT INTO chat_memory_cursor(chat_id, last_rowid, observed_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET last_rowid = excluded.last_rowid, observed_at = excluded.observed_at`,
    ).run(chatId, last);

    const hasOwner = rows.some((row) => row.type !== "ai");
    const authors = new Map<string, string>();
    for (const row of rows) if (row.type === "ai" && row.role_key) authors.set(row.role_key, row.from_user_id);
    if (!hasOwner || !authors.size) return { observed: 0 };

    const lines = rows.map((row) => `${row.type === "ai" ? (row.name ?? row.role_key ?? "Роль") : "Владелец"}: ${stripEnvelope(row.text).trim()}`);
    const transcript = lines.join("\n").slice(-MAX_TRANSCRIPT_CHARS);
    let observed = 0;
    for (const [roleKey, authorId] of authors) {
      const sourceRef = `chatobs:${chatId}:${last}`.slice(0, 100);
      const base = { role_key: roleKey, task_id: null, subtask_id: null };
      if (transcript.length < MIN_TRANSCRIPT_CHARS) {
        recordMemoryObserverEvent({ ...base, outcome: "skip", source_ref: sourceRef, detail: "short_chat" });
        continue;
      }
      observed += 1;
      await observeAndRemember({
        base,
        sourceRef: authors.size > 1 ? `${sourceRef}:${roleKey}`.slice(0, 100) : sourceRef,
        authorId,
        chip: { author_id: authorId, role_key: roleKey, task_id: null },
        userPrompt: [`Роль: ${roleKey}`, "Это разговор владельца с ролью в чате, а не итог шага. Урок ищи для этой роли.", transcript].join("\n"),
      });
    }
    return { observed };
  } finally {
    inFlight.delete(chatId);
  }
}

/** Один проход: сессии, где тишина дольше порога и роль не отвечает прямо сейчас. */
export async function chatMemoryObserverPass(limit = PASS_LIMIT): Promise<number> {
  if (!getSetting("memory_observer_enabled")) return 0;
  const idle = Math.max(1, Number(getSetting("memory_observer_chat_idle_min")) || 15);
  const rows = db
    .prepare(
      `SELECT c.id FROM chats c
         JOIN (SELECT m.chat_id, MAX(m.rowid) AS last_row, MAX(m.created_at) AS last_at FROM chat_messages m
                WHERE ${TALK} AND m.created_at >= datetime('now', '-7 days') GROUP BY m.chat_id) t ON t.chat_id = c.id
         LEFT JOIN chat_memory_cursor k ON k.chat_id = c.id
        WHERE ${SESSION}
          AND t.last_row > COALESCE(k.last_rowid, 0)
          AND julianday(t.last_at) <= julianday('now', ?)
          AND NOT EXISTS (SELECT 1 FROM chat_message_queue q WHERE q.chat_id = c.id AND q.status IN ('pending', 'picked'))
        ORDER BY t.last_at LIMIT ?`,
    )
    .all(`-${idle} minutes`, limit) as Array<{ id: string }>;
  let observed = 0;
  for (const row of rows) observed += (await observeChatMemory(row.id)).observed;
  return observed;
}

export function startChatMemoryObserver(intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    chatMemoryObserverPass().catch((error) => console.warn("[chat-memory-observer]", error instanceof Error ? error.message : error));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
