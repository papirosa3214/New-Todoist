// Обращение владельца к роли (владелец 29.10.2026).
//
// Сценарий: владелец спрашивает роль, которой нет в его чате (например
// Лайф-тестировщика). Ожидания:
//   1. Вопрос уходит в КОМНАТУ РОЛИ (личная переписка) — там у роли свой
//      контекст, лента владельца не засоряется.
//   2. В чате владельца появляется карточка «владелец → роль»: тот же
//      жизненный цикл, что у обращения роль→роль (статус, ответ, стоп).
//   3. Карточка лежит в чате владельца, а child_chat_id указывает на комнату
//      роли — там идёт работа, там и нужно останавливать ход.
//   4. Ответ роли закрывает карточку в чате владельца.
//
// Pi замокан: живой модели и сети нет.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";

const { startChatRunMock } = vi.hoisted(() => ({
  startChatRunMock: vi.fn(async (_args: any) => ({ text: "Ответ роли: сценарий входа сломан." })),
}));

vi.mock("../src/runtime/PiRuntimeAdapter.js", async (orig) => {
  const actual = await orig<any>();
  return { ...actual, startChatRun: startChatRunMock };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts, demoteSeededOwner } from "./helpers/seedOwner.js";

const OWNER_NAME = "Владелец-тест";

const cardOf = (questionId: string) => {
  const row = db
    .prepare(
      "SELECT id,chat_id,steps FROM chat_messages WHERE message_type='system' AND json_valid(steps) AND json_extract(steps,'$.coordination.question_id')=?",
    )
    .get(questionId) as { id: string; chat_id: string; steps: string } | undefined;
  return row ? { id: row.id, chat_id: row.chat_id, ...(JSON.parse(row.steps).coordination ?? {}) } : undefined;
};

const waitFor = async (predicate: () => boolean, ms = 8000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

describe("обращение владельца к роли", () => {
  let app: FastifyInstance;
  let auth: { authorization: string };
  let ownerId: string;
  let chatId: string;

  beforeAll(async () => {
    app = (await buildApp()) as unknown as FastifyInstance;
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    ownerId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users(id,name,email,password_hash,role,type,task_intake_mode) VALUES(?,?,?,'!','owner','human','automatic')",
    ).run(ownerId, OWNER_NAME, `${ownerId}@test`);
    auth = { authorization: `Bearer ${(app as any).jwt.sign({ id: ownerId })}` };
    chatId = crypto.randomUUID();
    db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES(?,?,'group',?)").run(
      chatId,
      "Чат владельца",
      ownerId,
    );
    db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, ownerId);
  });

  afterAll(async () => {
    await app.close();
  });

  it("вопрос уходит в комнату роли, в чате владельца появляется карточка", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/role-requests`,
      headers: auth,
      payload: { role: "qa", text: "Проверь сценарий входа" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.role).toBe("qa");
    expect(body.question_id).toBeTruthy();

    // Комната роли: личная переписка, там вопрос и там ответ.
    const roomId = body.room_chat_id;
    expect(roomId).toBeTruthy();
    expect(roomId).not.toBe(chatId);
    const room = db.prepare("SELECT room_kind FROM chats WHERE id=?").get(roomId) as {
      room_kind: string;
    };
    expect(room.room_kind).toBe("personal");
    const question = db
      .prepare("SELECT text,from_user_id FROM chat_messages WHERE id=?")
      .get(body.question_id) as { text: string; from_user_id: string };
    expect(question.text).toBe("Проверь сценарий входа");
    expect(question.from_user_id).toBe(ownerId);

    // Карточка — в чате владельца, работа — в комнате роли.
    const card = cardOf(body.question_id);
    expect(card).toBeTruthy();
    expect(card!.chat_id).toBe(chatId);
    expect(card!.requester_name).toBe(OWNER_NAME);
    expect(card!.recipient_id).toBe("role_qa");
    expect(card!.question).toBe("Проверь сценарий входа");
    expect(card!.child_chat_id).toBe(roomId);
    // terminal зависит от того, успел ли ответ роли прийти до проверки
    // (в тесте Pi замокан и отвечает мгновенно) — сама жизнь карточки
    // проверяется вторым тестом.

    // Доставка роли стоит в очереди в комнате роли.
    const queued = db
      .prepare("SELECT status,role_id FROM chat_message_queue WHERE message_id=?")
      .get(body.question_id) as { status: string; role_id: string } | undefined;
    expect(queued?.role_id).toBe("role_qa");
    expect(queued?.status).not.toBe("superseded");

    // Ход роли действительно стартовал: с id строки очереди (а не с
    // delivery_id) доставка поднимается — с delivery_id она молчала.
    const started = await waitFor(() => startChatRunMock.mock.calls.length > 0);
    expect(started).toBe(true);
    expect(startChatRunMock.mock.calls[0][0]).toMatchObject({
      chatId: roomId,
      role: "qa",
    });
  });

  it("ответ роли закрывает карточку в чате владельца", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/role-requests`,
      headers: auth,
      payload: { role: "qa", text: "Ещё один вопрос" },
    });
    expect(response.statusCode).toBe(200);
    const questionId = response.json().question_id;
    const closed = await waitFor(() => cardOf(questionId)?.terminal === true);
    expect(closed).toBe(true);
    const card = cardOf(questionId);
    // Ответ лег в комнату РОЛИ, а карточка — в чат владельца: в нитке
    // владельца ответа нет, поэтому итог кладём в карточку (владелец
    // 29.10.2026: «итоговый ответ… парсится и ответом в эту табличку»).
    expect(card!.answer??"").toContain("сценарий входа сломан");
    expect(card!.activity).toBe("Ответ получен");
    const answer = db
      .prepare("SELECT text FROM chat_messages WHERE chat_id=? AND from_user_id='role_qa' ORDER BY rowid DESC LIMIT 1")
      .get(card!.child_chat_id) as { text: string } | undefined;
    expect(answer?.text).toContain("сценарий входа сломан");
  });

  it("не-владелец обращаться к роли не может", async () => {
    const stranger = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'!','agent','human')",
    ).run(stranger, "Чужой", `${stranger}@test`);
    db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, stranger);
    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/role-requests`,
      headers: { authorization: `Bearer ${(app as any).jwt.sign({ id: stranger })}` },
      payload: { role: "qa", text: "Проверь" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("чужой чат недоступен: 404, а не 403", async () => {
    const stranger = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'!','agent','human')",
    ).run(stranger, "Посторонний", `${stranger}@test`);
    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/role-requests`,
      headers: { authorization: `Bearer ${(app as any).jwt.sign({ id: stranger })}` },
      payload: { role: "qa", text: "Проверь" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("неизвестная роль и пустой вопрос отклоняются", async () => {
    const unknown = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/role-requests`,
      headers: auth,
      payload: { role: "лайф-тестировщик-из-будущего", text: "Привет" },
    });
    expect(unknown.statusCode).toBe(400);
    const empty = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/role-requests`,
      headers: auth,
      payload: { role: "qa", text: "   " },
    });
    expect(empty.statusCode).toBe(400);
  });
});
