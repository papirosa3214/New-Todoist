// Признак доставки сообщения (карточка b504958a, контракт §10): владелец
// должен видеть, что его сообщение СОХРАНЕНО, что оно В ОЧЕРЕДИ и что оно
// ПЕРЕДАНО ИСПОЛНИТЕЛЮ, а у ответа роли такого признака нет вовсе.
//
// RED на старом коде: признак считался по (chat_id, role_id=отправителя,
// message_id), то есть по строке очереди, которой для сообщения владельца
// не существует. Итог: у сообщения владельца признака не было вовсе, а
// каждый ответ роли получал «Сохранено» — владелец читал это как «мой
// запрос ещё не дошёл».
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { loadChatMessage } from "../src/lib/chatMessages.js";

let app: any;
const role = "role_builder";

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  seedRoleAccounts(db);
});
afterAll(async () => {
  await app.close();
});

function chatWithRole(): string {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'group','u1')").run(id);
  db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(id, "u1");
  db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(id, role);
  return id;
}

function message(chatId: string, fromUserId: string, text: string): string {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text) VALUES(?,?,?,?)").run(
    id,
    chatId,
    fromUserId,
    text,
  );
  return id;
}

function delivery(chatId: string, messageId: string, status: string): void {
  db.prepare(
    `INSERT INTO chat_message_queue
       (id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status)
     VALUES (?,?,?,?,?,1,'{}',?)`,
  ).run(crypto.randomUUID(), chatId, role, `d-${crypto.randomUUID()}`, messageId, status);
}

it("сообщение владельца: сохранено, в очереди, передано исполнителю", () => {
  const chatId = chatWithRole();
  const saved = message(chatId, "u1", "Сделай вот это");
  // Записи доставки ещё нет — сообщение сохранено, но исполнителю не передано.
  expect(loadChatMessage(saved)!.queue_delivery_state).toBe("saved");

  delivery(chatId, saved, "pending");
  expect(loadChatMessage(saved)!.queue_delivery_state).toBe("queued");

  delivery(chatId, saved, "picked");
  expect(loadChatMessage(saved)!.queue_delivery_state).toBe("accepted");
});

it("ответ роли не несёт признака доставки: исполнителю его передавать некуда", () => {
  const chatId = chatWithRole();
  const answer = message(chatId, role, "Готово");
  expect(loadChatMessage(answer)!.queue_delivery_state).toBeUndefined();
});

it("отменённая доставка — «не передано», а не «передано исполнителю»", () => {
  const chatId = chatWithRole();
  const note = message(chatId, "u1", "Уточнение");
  delivery(chatId, note, "superseded");
  expect(loadChatMessage(note)!.queue_delivery_state).toBe("stale");
});
