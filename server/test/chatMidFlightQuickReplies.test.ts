// Владелец 24.10.2026: «задавай, если что, мне вопрос с вариантами ответов,
// которые складываются, развилки эти». Развилка — кнопки быстрого ответа под
// сообщением роли (строка `БЫСТРО:` в конце текста). Раньше сервер разбирал её
// только в ФИНАЛЬНОМ ответе роли, и вопрос в середине хода оставался без
// кнопок: развилку было не нажать. Этот тест — промежуточное сообщение роли.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

let app: FastifyInstance;
const auth = (role: string) => ({ authorization: `Bearer ${app.jwt.sign({ id: "role_" + role })}` });

beforeAll(async () => {
  app = await buildApp();
  seedRoleAccounts(db);
});
afterAll(async () => {
  await app.close();
});

it("промежуточное сообщение роли с развилкой сохраняет кнопки и убирает строку из текста", async () => {
  const chat = await app.inject({
    method: "POST",
    url: "/api/chats",
    headers: auth("architect"),
    payload: { kind: "direct", member_ids: ["role_builder"] },
  });
  const chatId = chat.json().chat.id;
  const sent = await app.inject({
    method: "POST",
    url: `/api/chats/${chatId}/messages`,
    headers: auth("architect"),
    payload: {
      work_mode: "work",
      text: "Какой вариант верный?\nБЫСТРО: Только iOS | Только веб | Оба",
    },
  });
  expect(sent.statusCode).toBe(200);
  const row = db
    .prepare("SELECT text, quick_replies FROM chat_messages WHERE id=?")
    .get(sent.json().message.id) as { text: string; quick_replies: string | null };
  expect(row.quick_replies).toBeTruthy();
  expect(JSON.parse(row.quick_replies!)).toEqual([
    "Только iOS",
    "Только веб",
    "Оба",
  ]);
  expect(row.text).not.toContain("БЫСТРО:");
  expect(row.text).toContain("Какой вариант верный?");
});

it("сообщение роли без развилки остаётся без кнопок", async () => {
  const chat = await app.inject({
    method: "POST",
    url: "/api/chats",
    headers: auth("architect"),
    payload: { kind: "direct", member_ids: ["role_builder"] },
  });
  const chatId = chat.json().chat.id;
  const sent = await app.inject({
    method: "POST",
    url: `/api/chats/${chatId}/messages`,
    headers: auth("architect"),
    payload: { work_mode: "work", text: "Просто сообщение без вариантов." },
  });
  expect(sent.statusCode).toBe(200);
  const row = db
    .prepare("SELECT quick_replies FROM chat_messages WHERE id=?")
    .get(sent.json().message.id) as { quick_replies: string | null };
  expect(row.quick_replies).toBeNull();
});
