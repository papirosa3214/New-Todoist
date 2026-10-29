// Комнаты субагента в боковой панели сессии (владелец 28.10.2026).
//
// Проверяет:
//   1. Комната субагента НЕ попадает в список сессий владельца (GET /api/chats)
//      — она живёт в боковой панели сессии, а не в общем списке.
//   2. GET /api/chats/:id/subagent-rooms отдаёт комнату этой сессии: роль,
//      статус, вопрос, ответ.
//   3. Статус комнаты меняется: open → finished, когда выжимка ушла в главную
//      сессию (room.close) и → failed, когда ход роли не состоялся.
//   4. Обычный чат в списке остаётся (фильтр не зацепил лишнего).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { openSubagentRoom } from "../src/runtime/subagentRoom.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let ownerId: string;

const SESSION_ID = `rooms_session_${crypto.randomUUID()}`;
const REQUESTER = "role_secretary_rooms";
const RECIPIENT = "role_architect_rooms";

const roomsOf = async (chatId: string) => {
  const res = await app.inject({
    method: "GET",
    url: `/api/chats/${chatId}/subagent-rooms`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json() as { rooms: any[] } };
};

const chatIdsInList = async (): Promise<string[]> => {
  const res = await app.inject({
    method: "GET",
    url: "/api/chats",
    headers: { authorization: `Bearer ${token}` },
  });
  return ((res.json() as { chats: { id: string }[] }).chats ?? []).map((c) => c.id);
};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const u1 = db.prepare("SELECT id FROM users WHERE id = 'u1'").get() as { id: string } | undefined;
  if (u1) db.prepare("UPDATE users SET role = 'agent' WHERE id = ?").run("u1");

  const email = `rooms-owner-${Date.now()}@test.local`;
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password: "test-password-strong-1", name: "Rooms Owner" },
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
    SESSION_ID,
    "Сессия с комнатами субагента",
    ownerId,
  );
  db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(SESSION_ID, ownerId);
});

afterAll(async () => {
  await app?.close();
});

describe("комнаты субагента в боковой панели сессии", () => {
  it("комната не попадает в список сессий, но видна в панели сессии", async () => {
    const room = openSubagentRoom({
      originChatId: SESSION_ID,
      requesterId: REQUESTER,
      recipientId: RECIPIENT,
      question: "Спроектируй схему хранения карточек",
    });
    expect(room).toBeTruthy();

    // В общем списке сессий её нет.
    expect(await chatIdsInList()).not.toContain(room!.chatId);

    // В панели сессии — есть, со статусом и ролью.
    const listed = await roomsOf(SESSION_ID);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const entry = listed.body.rooms.find((r) => r.id === room!.chatId);
    expect(entry).toBeTruthy();
    expect(entry!.role_id).toBe(RECIPIENT);
    expect(entry!.role_name).toBe("Архитектор");
    expect(entry!.state).toBe("open");
    expect(entry!.question).toContain("Спроектируй схему");
  });

  it("обычная сессия в списке остаётся", async () => {
    expect(await chatIdsInList()).toContain(SESSION_ID);
  });

  it("статус комнаты: завершена после выжимки в главную сессию, сбой после неудачи", async () => {
    const finished = openSubagentRoom({
      originChatId: SESSION_ID,
      requesterId: REQUESTER,
      recipientId: RECIPIENT,
      question: "Закрытая комната",
    })!;
    finished.close("finished");
    let entry = (await roomsOf(SESSION_ID)).body.rooms.find((r) => r.id === finished.chatId);
    expect(entry!.state).toBe("finished");
    expect(entry!.closed_at).toBeTruthy();

    const failed = openSubagentRoom({
      originChatId: SESSION_ID,
      requesterId: REQUESTER,
      recipientId: RECIPIENT,
      question: "Сбойная комната",
    })!;
    failed.close("failed");
    entry = (await roomsOf(SESSION_ID)).body.rooms.find((r) => r.id === failed.chatId);
    expect(entry!.state).toBe("failed");
  });

  it("чужая сессия — 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/chats/chat_nonexistent_rooms/subagent-rooms",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
