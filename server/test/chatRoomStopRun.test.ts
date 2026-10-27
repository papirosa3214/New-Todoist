// «Новая сессия», закрытие и удаление комнаты обрывают идущий ход роли
// (владелец 27.10.2026). RED на старом коде: обработчики только сбрасывали
// контекст / ставили closed_at, ход доживал вхолостую, а новый ход получал
// немую живую ленту — владелец не видел «думает» до готового ответа.
import crypto from "node:crypto";
import { vi, beforeAll, afterAll, beforeEach, it, expect } from "vitest";

const cancelled: Array<[string, string | undefined]> = [];
vi.mock("../src/runtime/PiRuntimeAdapter.js", async (original) => ({
  ...(await original<any>()),
  cancelChatRunsFor: vi.fn(async (chatId: string, roleId?: string) => {
    cancelled.push([chatId, roleId]);
    return 1;
  }),
}));

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

let app: any;
const role = "role_builder";

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  seedRoleAccounts(db);
});
afterAll(async () => { await app.close(); });
beforeEach(() => { cancelled.length = 0; });

function room(kind: "direct" | "group" = "group") {
  const chatId = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,?,'u1')").run(chatId, kind);
  for (const member of ["u1", role])
    db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, member);
  return chatId;
}

const auth = () => ({ authorization: "Bearer " + app.jwt.sign({ id: "u1" }) });

it("новая сессия обрывает идущий ход роли в этой комнате", async () => {
  const chatId = room();
  const r = await app.inject({ method: "POST", url: `/api/chats/${chatId}/new-session`, headers: auth(), payload: { role_id: role } });
  expect(r.statusCode, r.body).toBe(200);
  expect(cancelled).toContainEqual([chatId, role]);
});

it("закрытие комнаты обрывает ходы ролей в ней", async () => {
  const chatId = room();
  const r = await app.inject({ method: "POST", url: `/api/chats/${chatId}/close`, headers: auth(), payload: {} });
  expect(r.statusCode, r.body).toBe(200);
  expect(cancelled).toContainEqual([chatId, role]);
});

it("повторное открытие комнаты ходы не трогает", async () => {
  const chatId = room();
  const r = await app.inject({ method: "POST", url: `/api/chats/${chatId}/close`, headers: auth(), payload: { closed: false } });
  expect(r.statusCode, r.body).toBe(200);
  expect(cancelled).toEqual([]);
});

it("удаление комнаты обрывает ходы ролей в ней", async () => {
  const chatId = room();
  const r = await app.inject({ method: "DELETE", url: `/api/chats/${chatId}`, headers: auth() });
  expect(r.statusCode, r.body).toBe(200);
  expect(cancelled).toContainEqual([chatId, role]);
});
