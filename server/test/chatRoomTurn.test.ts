// Ход роли в строке комнаты (владелец 27.10.2026): идёт ход — анимация
// аватарки; после хода точка: ответила — зелёная, отвалилась — жёлтая,
// кончился лимит — красная; открыл комнату — точка гаснет.
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { roomTurn } from "../src/lib/chatRooms.js";
import { chatRunStopReason } from "../src/runtime/chatLiveTurn.js";

const role = "role_builder";
let app: any;
beforeAll(async () => { app = await buildApp(); await app.ready(); seedRoleAccounts(db); });
afterAll(async () => { await app.close(); });

function room(readAt: string | null = "2026-10-27 10:00:00") {
  const chatId = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'direct','u1')").run(chatId);
  db.prepare("INSERT INTO chat_members(chat_id,member_id,last_read_at) VALUES(?,'u1',?)").run(chatId, readAt);
  db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, role);
  return chatId;
}
function reply(chatId: string, stopReason: string | null, at = "2026-10-27 11:00:00") {
  db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,stop_reason,created_at) VALUES(?,?,?,?,?,?)")
    .run(crypto.randomUUID(), chatId, role, "Ответ", stopReason, at);
}

it("идёт ход — running, итога нет", () => {
  const chatId = room();
  reply(chatId, null);
  db.prepare(`INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,payload_json,status) VALUES(?,?,?,?,'{}','picked')`)
    .run(crypto.randomUUID(), chatId, role, crypto.randomUUID());
  expect(roomTurn(chatId, "u1")).toEqual({ running: true, outcome: null });
});

it("ответ после прочтения — зелёная", () => {
  const chatId = room();
  reply(chatId, null);
  expect(roomTurn(chatId, "u1")).toEqual({ running: false, outcome: "answered" });
});

it("отвалился — жёлтая, лимит — красная", () => {
  const failed = room();
  reply(failed, "error");
  expect(roomTurn(failed, "u1").outcome).toBe("failed");
  const limit = room();
  reply(limit, "limit");
  expect(roomTurn(limit, "u1").outcome).toBe("limit");
});

it("зашёл в комнату — точка гаснет", () => {
  const chatId = room("2026-10-27 12:00:00");
  reply(chatId, "error");
  expect(roomTurn(chatId, "u1")).toEqual({ running: false, outcome: null });
});

it("причина обрыва: лимит отдельно от сбоя", () => {
  expect(chatRunStopReason(false, null)).toBeNull();
  expect(chatRunStopReason(true, null)).toBe("owner_interrupt");
  expect(chatRunStopReason(false, Object.assign(new Error("x"), { code: "CHAT_ACTION_BUDGET" }))).toBe("limit");
  expect(chatRunStopReason(false, Object.assign(new Error("x"), { code: "CHAT_RUN_CEILING" }))).toBe("limit");
  expect(chatRunStopReason(false, new Error("429 Too Many Requests: rate limit exceeded"))).toBe("limit");
  expect(chatRunStopReason(false, Object.assign(new Error("x"), { code: "CHAT_RUN_IDLE" }))).toBe("error");
});
