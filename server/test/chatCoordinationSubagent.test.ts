// Карточка обращения субагента: вызов роли внутри хода не требует
// сообщения-вопроса в чате — карточка заводится по синтетическому
// question_id ("subagent:…").
//
// Покрывает:
//   1. Карточка появляется в chat_messages служебной строкой с
//      coordination.question_id, начинающимся на "subagent:".
//   2. В coordination лежат правильные имена ролей, вопрос, статус
//      "queued" и terminal=false.
//   3. Пустой вопрос (и пустой чат) — карточка не создаётся, функция
//      возвращает undefined, строки в базе нет.
//   4. Обычная ветка ensureCoordinationCard не затронута: для вопроса без
//      coordination_origin карточка по-прежнему не создаётся, а синтетический
//      question_id не путается с обычным.

import { beforeAll, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  ensureCoordinationCard,
  ensureSubagentCoordinationCard,
  hasCoordinationCard,
} from "../src/runtime/chatCoordination.js";

const CHAT_ID = "subagent_card_chat";
const REQUESTER_ID = "subagent_card_requester";
const RECIPIENT_ID = "subagent_card_recipient";

const coordinationOf = (questionId: string) => {
  const row = db
    .prepare(
      "SELECT steps FROM chat_messages WHERE message_type='system' AND json_valid(steps) AND json_extract(steps,'$.coordination.question_id')=?",
    )
    .get(questionId) as { steps: string } | undefined;
  return row ? JSON.parse(row.steps).coordination : undefined;
};

beforeAll(() => {
  migrate();
  runMigrations();
  db.prepare(
    "INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'!','agent','ai')",
  ).run(REQUESTER_ID, "Архитектор", "subagent-card-requester@test.local");
  db.prepare(
    "INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'!','agent','ai')",
  ).run(RECIPIENT_ID, "Разработчик", "subagent-card-recipient@test.local");
  db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES(?,?,'group',?)").run(
    CHAT_ID,
    "Обращения субагента",
    REQUESTER_ID,
  );
  db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(
    CHAT_ID,
    REQUESTER_ID,
  );
  db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(
    CHAT_ID,
    RECIPIENT_ID,
  );
});

describe("карточка обращения субагента", () => {
  it("заводит служебную строку с синтетическим question_id", () => {
    const questionId = ensureSubagentCoordinationCard({
      chatId: CHAT_ID,
      requesterId: REQUESTER_ID,
      recipientId: RECIPIENT_ID,
      question: "Нужен разбор контракта шага",
    });

    expect(questionId).toBeTruthy();
    expect(questionId!.startsWith("subagent:")).toBe(true);

    const row = db
      .prepare(
        "SELECT message_type,channel,from_user_id,chat_id,steps FROM chat_messages WHERE json_extract(steps,'$.coordination.question_id')=?",
      )
      .get(questionId!) as
      | { message_type: string; channel: string; from_user_id: string; chat_id: string; steps: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.message_type).toBe("system");
    expect(row!.channel).toBe("chat");
    expect(row!.from_user_id).toBe(REQUESTER_ID);
    expect(row!.chat_id).toBe(CHAT_ID);
  });

  it("кладёт в coordination правильные имена ролей, вопрос и статус", () => {
    const questionId = ensureSubagentCoordinationCard({
      chatId: CHAT_ID,
      requesterId: REQUESTER_ID,
      recipientId: RECIPIENT_ID,
      question: "Проверь границы контракта",
      originMessageId: undefined,
    })!;

    const c = coordinationOf(questionId);
    expect(c.question_id).toBe(questionId);
    expect(c.requester_name).toBe("Архитектор");
    expect(c.recipient_name).toBe("Разработчик");
    expect(c.recipient_id).toBe(RECIPIENT_ID);
    expect(c.question).toBe("Проверь границы контракта");
    expect(c.child_chat_id).toBe(CHAT_ID);
    expect(c.status).toBe("queued");
    expect(c.terminal).toBe(false);
    expect(c.activity).toBeTruthy();
  });

  it("пустой вопрос — карточка не создаётся", () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number };
    const questionId = ensureSubagentCoordinationCard({
      chatId: CHAT_ID,
      requesterId: REQUESTER_ID,
      recipientId: RECIPIENT_ID,
      question: "   ",
    });
    expect(questionId).toBeUndefined();
    const after = db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("пустой чат — карточка не создаётся", () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number };
    const questionId = ensureSubagentCoordinationCard({
      chatId: "",
      requesterId: REQUESTER_ID,
      recipientId: RECIPIENT_ID,
      question: "Вопрос без чата",
    });
    expect(questionId).toBeUndefined();
    const after = db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("обычная ветка ensureCoordinationCard не затронута", () => {
    const questionId = "subagent_card_plain_question";
    db.prepare(
      "INSERT OR REPLACE INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,?,'chat',?)",
    ).run(questionId, REQUESTER_ID, "Обычный вопрос", CHAT_ID);

    // Без coordination_origin обычная ветка карточку не заводит — так и было.
    ensureCoordinationCard(questionId, RECIPIENT_ID);
    expect(coordinationOf(questionId)).toBeUndefined();
    expect(hasCoordinationCard(questionId, RECIPIENT_ID)).toBe(false);

    // Синтетический идентификатор субагента обычный поиск карточек не цепляет.
    const subagentId = ensureSubagentCoordinationCard({
      chatId: CHAT_ID,
      requesterId: REQUESTER_ID,
      recipientId: RECIPIENT_ID,
      question: "Вопрос субагента",
    })!;
    expect(hasCoordinationCard(subagentId, RECIPIENT_ID)).toBe(true);
    expect(hasCoordinationCard(questionId, RECIPIENT_ID)).toBe(false);
  });
});
