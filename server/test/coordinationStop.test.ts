// Кнопка «Остановить обращение» на coordination-карточке.
//
// Проверяет три ветки маршрута POST /api/chats/:id/coordination/:messageId/stop:
//   1. Обращение субагента (question_id «subagent:<uuid>») — идёт мимо очереди
//      сообщений: строки в chat_message_queue нет, живого хода в ленте тоже
//      нет. Раньше маршрут отвечал 409, и кнопка была бесполезной. Теперь
//      ход роли гасится напрямую, карточка закрывается.
//   2. Обычное обращение без строки в очереди — прежний 409 (ветка не сломана).
//   3. Обычное обращение со строкой в очереди — очередь помечается
//      superseded, карточка закрывается (прежнее поведение сохранено).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { ensureSubagentCoordinationCard } from "../src/runtime/chatCoordination.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let ownerId: string;

const CHAT_ID = `stop_chat_${crypto.randomUUID()}`;
const REQUESTER = "role_secretary_stop";
const RECIPIENT = "role_architect_stop";

const cardRowId = (questionId: string): string | undefined =>
  (
    db
      .prepare(
        "SELECT id FROM chat_messages WHERE json_valid(steps) AND json_extract(steps,'$.coordination.question_id')=?",
      )
      .get(questionId) as { id: string } | undefined
  )?.id;

const cardOf = (questionId: string): any => {
  const row = db
    .prepare(
      "SELECT steps FROM chat_messages WHERE json_valid(steps) AND json_extract(steps,'$.coordination.question_id')=?",
    )
    .get(questionId) as { steps: string } | undefined;
  return row ? JSON.parse(row.steps).coordination : undefined;
};

/**
 * Обычная (не субагентская) карточка: как её заводит прежний механизм.
 * Две строки — сообщение-вопрос (его id и есть question_id, на него
 * ссылается очередь) и сама карточка (её id клиент шлёт в /stop).
 */
const insertPlainCard = (): { questionId: string; messageId: string } => {
  const questionId = `msg_${crypto.randomUUID()}`;
  const messageId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,message_type,reply_to_message_id,steps) VALUES(?,?,?,'chat',?,NULL,NULL,NULL)",
  ).run(questionId, REQUESTER, "Спроектируй схему", CHAT_ID);
  db.prepare(
    "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,message_type,reply_to_message_id,steps) VALUES(?,?,?,'chat',?,'system',NULL,?)",
  ).run(
    messageId,
    REQUESTER,
    "Секретарь → Архитектор: Вопрос принят",
    CHAT_ID,
    JSON.stringify({
      duration_ms: 0,
      items: [],
      coordination: {
        question_id: questionId,
        recipient_id: RECIPIENT,
        requester_name: "Секретарь",
        recipient_name: "Архитектор",
        question: "Спроектируй схему",
        child_chat_id: CHAT_ID,
        origin_message_id: "",
        status: "queued",
        activity: "Вопрос принят",
        created_at: now,
        last_activity_at: now,
        terminal: false,
      },
    }),
  );
  return { questionId, messageId };
};

const stop = (chatId: string, messageId: string) =>
  app.inject({
    method: "POST",
    url: `/api/chats/${chatId}/coordination/${messageId}/stop`,
    headers: { authorization: `Bearer ${token}` },
  });

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  // Сидим-учётка 'u1' не должна быть владельцем (общий приём, см.
  // test/coordination/api.test.ts).
  const u1 = db.prepare("SELECT id FROM users WHERE id = 'u1'").get() as { id: string } | undefined;
  if (u1) db.prepare("UPDATE users SET role = 'agent' WHERE id = ?").run("u1");

  const email = `stop-owner-${Date.now()}@test.local`;
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password: "test-password-strong-1", name: "Stop Owner" },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const regBody = reg.json() as { user: { id: string }; token: string };
  ownerId = regBody.user.id;
  token = regBody.token;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

  for (const [id, name] of [
    [REQUESTER, "Секретарь"],
    [RECIPIENT, "Архитектор"],
  ] as const) {
    db.prepare(
      "INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'!','agent','ai')",
    ).run(id, name, `${id}@test.local`);
  }
  db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES(?,?,'group',?)").run(
    CHAT_ID,
    "Остановка обращения",
    ownerId,
  );
  db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(CHAT_ID, ownerId);
});

afterAll(async () => {
  await app?.close();
});

describe("остановка обращения по coordination-карточке", () => {
  it("обращение субагента: останавливаем и закрываем карточку (было 409)", async () => {
    const questionId = ensureSubagentCoordinationCard({
      chatId: CHAT_ID,
      requesterId: REQUESTER,
      recipientId: RECIPIENT,
      question: "Спроектируй схему",
    });
    expect(questionId).toBeTruthy();
    expect(questionId!.startsWith("subagent:")).toBe(true);

    const messageId = cardRowId(questionId!);
    expect(messageId).toBeTruthy();

    const res = await stop(CHAT_ID, messageId!);
    expect(res.statusCode, res.body).toBe(200);
    // Живого хода роли в тесте нет — гасить нечего, но карточка закрывается.
    expect(res.json()).toEqual({ stopped: 0 });

    const card = cardOf(questionId!);
    expect(card.terminal).toBe(true);
    expect(card.status).toBe("cancelled");
  });

  it("обычное обращение без строки в очереди — прежний 409", async () => {
    const { messageId } = insertPlainCard();
    const res = await stop(CHAT_ID, messageId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatch(/остановить/i);
  });

  it("обычное обращение со строкой в очереди — очередь superseded, карточка закрыта", async () => {
    const { questionId, messageId } = insertPlainCard();
    db.prepare(
      "INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,payload_json,status) VALUES(?,?,?,?,?,?,'pending')",
    ).run(crypto.randomUUID(), CHAT_ID, RECIPIENT, `dlv_${crypto.randomUUID()}`, questionId, "{}");

    const res = await stop(CHAT_ID, messageId);
    expect(res.statusCode, res.body).toBe(200);

    const row = db
      .prepare("SELECT status FROM chat_message_queue WHERE message_id=?")
      .get(questionId) as { status: string };
    expect(row.status).toBe("superseded");

    const card = cardOf(questionId);
    expect(card.terminal).toBe(true);
    expect(card.status).toBe("cancelled");
  });
});
