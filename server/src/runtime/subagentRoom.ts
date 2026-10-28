// Комната субагента (владелец 28.10.2026): роль, которую позвали
// инструментом taskflow_call_role, работает не невидимо внутри чужого хода,
// а в своей комнате-ветке исходного чата. Там первым сообщением лежит вопрос,
// идёт обычный живой ход (шаги, инструменты, текст), а ответ ложится
// сообщением со шагами — владелец открывает комнату с портрета роли и
// смотрит, как она работает.

import crypto from "node:crypto";
import db from "../db.js";
import { broadcastToUsers } from "../ws.js";
import { loadChatMessage } from "../lib/chatMessages.js";
import { trimThinkingItems } from "../lib/dataRetention.js";
import { startLiveTurn } from "./chatLiveTurn.js";

export type SubagentRoom = {
  chatId: string;
  questionMessageId: string;
  onEvent: (event: unknown) => void;
  /** Закрыть живой ход и положить ответ (или причину сбоя) в комнату. */
  finish: (text: string, failed: boolean) => void;
};

function memberIds(chatId: string): string[] {
  return (db.prepare("SELECT member_id FROM chat_members WHERE chat_id=?").all(chatId) as Array<{ member_id: string }>)
    .map((row) => row.member_id);
}

function userName(id: string): string {
  return (db.prepare("SELECT name FROM users WHERE id=?").get(id) as { name?: string } | undefined)?.name ?? id;
}

function announce(chatId: string, messageId: string): void {
  broadcastToUsers(memberIds(chatId), { type: "chat:new", message: loadChatMessage(messageId) });
}

/** Завести комнату и начать в ней живой ход роли. undefined — комнату завести не удалось. */
export function openSubagentRoom(input: {
  originChatId: string;
  originMessageId?: string;
  requesterId: string;
  recipientId: string;
  question: string;
}): SubagentRoom | undefined {
  const origin = db.prepare("SELECT kind FROM chats WHERE id=?").get(input.originChatId) as { kind: string } | undefined;
  if (!origin) return undefined;
  const chatId = crypto.randomUUID();
  const questionMessageId = crypto.randomUUID();
  const recipientName = userName(input.recipientId);
  const title = `${userName(input.requesterId)} → ${recipientName}: ${input.question.replace(/\s+/g, " ").slice(0, 60)}`;
  db.transaction(() => {
    db.prepare("INSERT INTO chats (id, title, kind, created_by, branch_of_chat_id, branch_of_message_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(chatId, title, origin.kind, input.requesterId, input.originChatId, input.originMessageId ?? null);
    db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) SELECT ?, member_id FROM chat_members WHERE chat_id = ?")
      .run(chatId, input.originChatId);
    for (const member of [input.requesterId, input.recipientId]) {
      db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(chatId, member);
    }
    db.prepare("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, 'chat', ?)")
      .run(questionMessageId, input.requesterId, input.question, chatId);
  })();
  announce(chatId, questionMessageId);

  const replyId = crypto.randomUUID();
  const live = startLiveTurn({
    chatId,
    userId: input.recipientId,
    name: recipientName,
    triggerMessageId: questionMessageId,
    messageId: replyId,
    audience: () => memberIds(chatId),
  });
  let finished = false;
  return {
    chatId,
    questionMessageId,
    onEvent: (event) => live.onEvent(event),
    finish: (text, failed) => {
      if (finished) return;
      finished = true;
      let saved: string | null = null;
      try {
        if (!failed) live.replaceFinalText(text);
        const steps = live.finish({ deferAnnounce: true });
        db.prepare(
          "INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, steps, reply_to_message_id, stop_reason) VALUES (?, ?, ?, 'chat', ?, ?, ?, ?)",
        ).run(replyId, input.recipientId, text, chatId, steps ? JSON.stringify(trimThinkingItems(steps)) : null, questionMessageId, failed ? "error" : null);
        db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(chatId);
        saved = replyId;
        announce(chatId, replyId);
      } finally {
        live.finish({ deferAnnounce: true });
        live.announceEnd(saved);
      }
    },
  };
}
