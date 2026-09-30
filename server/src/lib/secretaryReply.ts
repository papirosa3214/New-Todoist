import { type ChatWorkMode } from "../runtime/chatWorkMode.js";
import { renderInstruction } from "./roleContextResolver.js";
// «Супер Секретарь» (владелец 25.09.2026, docs/ПЛАН Супер Секретарь/):
// настоящий ИИ-ответ в комнате `chat-secretary` — по образцу
// deliverAgentReply (server/src/routes/chats.ts), но отдельной функцией:
// стандартный chatMemberRoles/pickRoleForChat/roleAccountId завязан на
// users.role_key, а Секретарь его иметь не может — БД-триггер
// users_role_key_update_guard требует id = 'role_' + role_key, у Секретаря
// фиксированный id u-secretary (см. roleUserId() в roleRouting.ts).
//
// Роль `secretary` включается в roles вместе с этим переносом (миграция
// 063) — если по какой-то причине выключена, startChatRun бросит
// «неизвестная роль», это ловится и тихо игнорируется.
import crypto from "node:crypto";
import db from "../db.js";
import { broadcastToUsers } from "../ws.js";
import { rolePromptText } from "../roleRouting.js";
import { composeLayer } from "./roleContextResolver.js";
import { startChatRun } from "../runtime/PiRuntimeAdapter.js";
import { getChatSessionId, upsertChatSession } from "../runtime/chatSession.js";
import {
  chatRunFailureText,
  startLiveTurn,
  type SavedSteps,
} from "../runtime/chatLiveTurn.js";
import { loadChatMessage } from "./chatMessages.js";

import { mayRequestSummary, parseSummaryRequest, collectTaskSummary, sendSummaryToSecretaryChat } from "./secretaryTaskSummary.js";

const uid = () => crypto.randomUUID();

export const SECRETARY_CHAT_ID = "chat-secretary";
const SECRETARY_ROLE = "secretary";
const SECRETARY_ID = "u-secretary";
export const SECRETARY_USER_ID = SECRETARY_ID;
const CONTEXT_MESSAGES = 20;

/// Быстрые ответы (владелец 25.09.2026, docs/ПЛАН Супер Секретарь/): модель
/// заканчивает ответ строкой `БЫСТРО: вариант1 | вариант2 | вариант3` —
/// разбираем и убираем из текста, который реально ложится в ленту.
function extractQuickReplies(text: string): { clean: string; replies: string[] | null } {
  const lines = text.split("\n");
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx].trim() === "") lastIdx--;
  if (lastIdx < 0) return { clean: text, replies: null };
  const match = lines[lastIdx].trim().match(/^БЫСТРО:\s*(.+)$/i);
  if (!match) return { clean: text, replies: null };
  const replies = match[1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!replies.length) return { clean: text, replies: null };
  const clean = lines.slice(0, lastIdx).join("\n").trimEnd();
  return { clean, replies };
}

function memberIds(chatId: string): string[] {
  return (
    db
      .prepare("SELECT member_id FROM chat_members WHERE chat_id = ?")
      .all(chatId) as Array<{ member_id: string }>
  ).map((r) => r.member_id);
}

export async function deliverSecretaryReply(userText: string, mode: ChatWorkMode = "work"): Promise<string | null> {
  const chatId = SECRETARY_CHAT_ID;
  // Сводка использует тот же серверный разбор и факты, что голосовой инструмент.
  // Свободный разговор продолжает существующую сессию роли.
  if (mayRequestSummary(userText)) {
    const owner = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as {id:string}|undefined;
    if (owner) {
      try {
        const filter = await parseSummaryRequest(userText);
        if (filter.is_summary) return sendSummaryToSecretaryChat(owner.id,filter.question || collectTaskSummary(owner.id,filter).text);
      } catch (error) {
        console.warn("[secretaryReply] сводка не получена:",error);
        return sendSummaryToSecretaryChat(owner.id,"Не удалось получить сводку задач. Уточни исполнителя и период или повтори запрос.");
      }
    }
  }
  const history = db
    .prepare(
      `SELECT m.from_user_id, m.text, m.created_at, f.name as from_name
         FROM chat_messages m
         LEFT JOIN users f ON f.id = m.from_user_id
        WHERE m.chat_id = ?
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
    )
    .all(chatId, CONTEXT_MESSAGES) as Array<{
    from_user_id: string;
    text: string;
    created_at: string;
    from_name: string | null;
  }>;
  history.reverse();
  const historyLines = history
    .map((row) => `- [${row.created_at}] ${row.from_name || row.from_user_id}: ${row.text}`)
    .join("\n");

  const instruction =
    composeLayer(SECRETARY_ROLE, "role.prompt")?.effective
      || rolePromptText(SECRETARY_ROLE)
      || "Ты — Секретарь, личный помощник владельца в TaskFlow.";
  const prompt = renderInstruction(SECRETARY_ROLE, "secretary.chat", { roleInstruction: instruction, history: historyLines || "(пусто)", userText });

  const previousSessionId = getChatSessionId(chatId, SECRETARY_ID);
  // SQL-время, не JS Date().toISOString() — формат должен совпасть с
  // tasks.created_at ('YYYY-MM-DD HH:MM:SS', см. datetime('now') в схеме),
  // иначе строковое сравнение ниже врёт.
  const turnStartedAt = (db.prepare("SELECT datetime('now') as ts").get() as { ts: string }).ts;

  const typing = (active: boolean, tool?: string) => {
    broadcastToUsers(memberIds(chatId), {
      type: "chats:typing",
      chat_id: chatId,
      user_id: SECRETARY_ID,
      name: "Секретарь",
      active,
      ...(tool ? { tool } : {}),
    });
  };

  // Живой ход (владелец 27.09.2026): текст растёт по словам, над ним шаги.
  const live = startLiveTurn({
    chatId,
    userId: SECRETARY_ID,
    name: "Секретарь",
    audience: () => memberIds(chatId),
  });

  let reply: { sessionId: string | null; text: string } | null = null;
  let failure: unknown = null;
  let steps: SavedSteps | null = null;
  typing(true);
  try {
    reply = await startChatRun({
      mode,
      chatId,
      role: SECRETARY_ROLE,
      roleId: SECRETARY_ID,
      prompt,
      sessionId: previousSessionId,
      onStep: (tool) => typing(true, tool),
      onEvent: live.onEvent,
    });
  } catch (error) {
    // Сорванный ход — сообщение с причиной в чат, а не тишина.
    console.warn(
      "[secretaryReply] startChatRun не удался:",
      error instanceof Error ? error.message : error,
    );
    failure = error;
  }
  // «Ход закончен» разошлём после готового сообщения — см. deliverAgentReply.
  const partial = live.partialText();
  steps = live.finish({ deferAnnounce: true });

  if (reply?.sessionId) upsertChatSession(chatId, SECRETARY_ID, reply.sessionId);

  const cancelled = (failure as { code?: string } | null)?.code === "CHAT_RUN_CANCELLED";
  const rawReplyText = cancelled && partial
    ? `${partial}\n\n_Остановлено._`
    : failure
      ? chatRunFailureText(failure)
      : (reply?.text || "").trim();
  if (!rawReplyText) {
    live.announceEnd(null);
    typing(false);
    return null;
  }
  const { clean: replyText, replies: quickReplies } = failure
    ? { clean: rawReplyText, replies: null }
    : extractQuickReplies(rawReplyText);

  // Карточка задачи (владелец 25.09.2026, docs/ПЛАН Супер Секретарь/,
  // этап 2): если за этот ход Секретарь создал задачу инструментом
  // (taskflow_create_task), находим её по времени и авторству и вешаем
  // на ответное сообщение — клиент отрисует карточку вместо простого
  // текста. Эвристика по времени, не по прямому сигналу от инструмента:
  // startChatRun отдаёт только финальный текст, отдельного канала
  // «какие инструменты вызывались» у него нет.
  const createdTask = db
    .prepare(
      `SELECT id FROM tasks WHERE creator_id = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(SECRETARY_ID, turnStartedAt) as { id: string } | undefined;

  const replyId = uid();
  db.prepare(
    `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, task_id, quick_replies, steps)
     VALUES (?, ?, ?, 'chat', ?, ?, ?, ?)`,
  ).run(
    replyId,
    SECRETARY_ID,
    replyText,
    chatId,
    createdTask?.id ?? null,
    quickReplies ? JSON.stringify(quickReplies) : null,
    steps ? JSON.stringify(steps) : null,
  );
  db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(chatId);

  broadcastToUsers(memberIds(chatId), { type: "chat:new", message: loadChatMessage(replyId) });
  live.announceEnd(replyId);
  typing(false);
  return replyId;
}
