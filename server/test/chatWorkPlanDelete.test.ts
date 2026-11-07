// Владелец 06.11.2026: «дай, чтобы я по долгому нажатию удалял чек-листы в
// чатах». Чек-лист — рабочий план роли над полем ввода (chat_work_plans).
// Удалить его может только владелец; роль свой план ведёт инструментом.
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { readChatWorkPlans, saveChatWorkPlan } from "../src/lib/subtaskWorkPlan.js";

let app: any;
const role = "role_builder";
const items = [
  { id: "one", title: "Первый", state: "pending" as const },
  { id: "two", title: "Второй", state: "pending" as const },
  { id: "three", title: "Третий", state: "pending" as const },
];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  seedRoleAccounts(db);
});
afterAll(async () => { await app.close(); });

function chatWithPlan(): string {
  const chatId = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'group','u1')").run(chatId);
  for (const member of ["u1", role]) db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, member);
  saveChatWorkPlan(chatId, role, 0, items as any);
  return chatId;
}

const del = (chatId: string, roleId: string, userId: string) =>
  app.inject({ method: "DELETE", url: `/api/chats/${chatId}/work-plans/${roleId}`,
    headers: { authorization: `Bearer ${app.jwt.sign({ id: userId })}` } });

it("владелец удаляет чек-лист роли — его больше нет и в ленте планов", async () => {
  const chatId = chatWithPlan();
  expect(readChatWorkPlans(chatId).map((p) => p.role_id)).toEqual([role]);
  const res = await del(chatId, role, "u1");
  expect(res.statusCode).toBe(200);
  expect(readChatWorkPlans(chatId)).toEqual([]);
  const list = await app.inject({ method: "GET", url: `/api/chats/${chatId}/work-plans`,
    headers: { authorization: `Bearer ${app.jwt.sign({ id: "u1" })}` } });
  expect(list.json().plans).toEqual([]);
});

it("роль чужой и свой чек-лист так не удаляет", async () => {
  const chatId = chatWithPlan();
  const res = await del(chatId, role, role);
  expect(res.statusCode).toBe(403);
  expect(readChatWorkPlans(chatId)).toHaveLength(1);
});

it("несуществующий чат — 404", async () => {
  const res = await del(crypto.randomUUID(), role, "u1");
  expect(res.statusCode).toBe(404);
});
