// Явная сдача текущего пункта чатового чек-листа (карточка b504958a,
// контракт §5): идемпотентность, устаревший ход, отказ прямого перехода.
//
// RED на старом коде: маршрута сдачи не было вовсе — пункт закрывался
// переписыванием плана, а поздний ответ старого хода двигал состояние.
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { chatPlanView, saveChatWorkPlan, submitChatWorkItem } from "../src/lib/subtaskWorkPlan.js";

let app: any;
const role = "role_builder";
const planItems = [
  { id: "impl", title: "Реализовать", state: "pending" as const },
  { id: "verify", title: "Проверить", state: "pending" as const },
  { id: "report", title: "Рассказать", state: "pending" as const },
];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  seedRoleAccounts(db);
});
afterAll(async () => { await app.close(); });

/** Чат + живой ход роли: без живой доставки сдача не принимается. */
function chatWithRun(generation = 1) {
  const chatId = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'group','u1')").run(chatId);
  for (const member of ["u1", role])
    db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, member);
  db.prepare("INSERT INTO chat_session_generation(chat_id,role_id,generation) VALUES(?,?,?)").run(chatId, role, generation);
  const messageId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO chat_messages(id,chat_id,from_user_id,text,created_at) VALUES(?,?,'u1','Сделай работу',datetime('now'))",
  ).run(messageId, chatId);
  const deliveryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status,updated_at)
     VALUES(?,?,?,?,?,?,'{}','picked',datetime('now'))`,
  ).run(deliveryId, chatId, role, deliveryId, messageId, generation);
  saveChatWorkPlan(chatId, role, 0, planItems as any);
  return { chatId, messageId, deliveryId };
}

/** Следующий ход той же роли в том же чате. */
function anotherRun(chatId: string) {
  const messageId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO chat_messages(id,chat_id,from_user_id,text,created_at) VALUES(?,?,'u1','Продолжай',datetime('now'))",
  ).run(messageId, chatId);
  const deliveryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status,updated_at)
     VALUES(?,?,?,?,?,1,'{}','picked',datetime('now'))`,
  ).run(deliveryId, chatId, role, deliveryId, messageId);
  return messageId;
}

it("сдача текущего пункта открывает следующий и повышает версию", () => {
  const { chatId, messageId } = chatWithRun();
  const result = submitChatWorkItem({ chatId, roleId: role, itemId: "impl", result: "Сделал.", outcome: "done", messageId });
  expect(result.current_item_id).toBe("verify");
  expect(result.next_item?.id).toBe("verify");
  expect(result.item.state).toBe("done");
  expect(result.plan_revision).toBe(2);
  expect(chatPlanView(chatId, role)!.items.map((i) => i.state)).toEqual(["done", "in_progress", "pending"]);
});

it("прямой переход через несданный пункт отвергается и план не меняется", () => {
  const { chatId, messageId } = chatWithRun();
  expect(() =>
    submitChatWorkItem({ chatId, roleId: role, itemId: "report", result: "Готово.", outcome: "done", messageId }),
  ).toThrow(/только текущий пункт/);
  const view = chatPlanView(chatId, role)!;
  expect(view.current_item_id).toBe("impl");
  expect(view.revision).toBe(1);
  expect(view.items[0].state).toBe("in_progress");
});

it("повтор той же сдачи не создаёт второго эффекта, а другой итог отклоняется", () => {
  const { chatId, messageId } = chatWithRun();
  const first = submitChatWorkItem({ chatId, roleId: role, itemId: "impl", result: "Сделал.", outcome: "done", messageId });
  const again = submitChatWorkItem({ chatId, roleId: role, itemId: "impl", result: "Сделал.", outcome: "done", messageId });
  expect(again.idempotent).toBe(true);
  expect(again.plan_revision).toBe(first.plan_revision);
  expect(chatPlanView(chatId, role)!.revision).toBe(2);
  // Другой ход (новое сообщение) — другой ключ: пункт уже сдан, второй записи нет.
  const second = anotherRun(chatId);
  expect(() =>
    submitChatWorkItem({ chatId, roleId: role, itemId: "impl", result: "Другой итог.", outcome: "done", messageId: second }),
  ).toThrow(/уже сдан/);
  expect(chatPlanView(chatId, role)!.revision).toBe(2);
});

it("поздний ответ старого поколения пункт не двигает", () => {
  const { chatId, messageId } = chatWithRun();
  // Владелец прислал уточнение: поколение пары выросло, ход стал прежним.
  db.prepare("UPDATE chat_session_generation SET generation=? WHERE chat_id=? AND role_id=?").run(2, chatId, role);
  expect(() =>
    submitChatWorkItem({ chatId, roleId: role, itemId: "impl", result: "Сделал.", outcome: "done", messageId }),
  ).toThrow(/устаревшего|закрытого хода/);
  const view = chatPlanView(chatId, role)!;
  expect(view.current_item_id).toBe("impl");
  expect(view.items[0].state).toBe("in_progress");
});

it("блокировка без причины и сдача без итога отвергаются", () => {
  const { chatId, messageId } = chatWithRun();
  expect(() =>
    submitChatWorkItem({ chatId, roleId: role, itemId: "impl", result: "Сделал.", outcome: "done", messageId }),
  ).not.toThrow();
  expect(() =>
    submitChatWorkItem({ chatId, roleId: role, itemId: "verify", outcome: "blocked", messageId }),
  ).toThrow(/block_type/);
  const blocked = submitChatWorkItem({
    chatId, roleId: role, itemId: "verify", outcome: "blocked", blockType: "needs_input", reason: "Жду ответ", messageId,
  });
  expect(blocked.item.state).toBe("blocked");
  // Блокированный пункт остаётся текущим: следующий не допускается.
  expect(blocked.current_item_id).toBe("verify");
  expect(blocked.view.items[2].state).toBe("pending");
});

it("последняя сдача закрывает план целиком", () => {
  const { chatId, messageId } = chatWithRun();
  for (const [itemId, text] of [["impl", "Сделал."], ["verify", "Проверил."], ["report", "Рассказал."]] as const)
    submitChatWorkItem({ chatId, roleId: role, itemId, result: text, outcome: "done", messageId });
  const view = chatPlanView(chatId, role)!;
  expect(view.status).toBe("finished");
  expect(view.current_item_id).toBeNull();
  expect(view.items.map((i) => i.state)).toEqual(["done", "done", "done"]);
});

it("маршрут сдачи отвечает кодом отказа и отдаёт следующий пункт", async () => {
  const { chatId, messageId } = chatWithRun();
  const token = app.jwt.sign({ id: role });
  const early = await app.inject({
    method: "POST",
    url: `/api/chats/${chatId}/work-plan/submit`,
    headers: { authorization: "Bearer " + token },
    payload: { item_id: "report", result: "Готово", message_id: messageId },
  });
  expect(early.statusCode).toBe(409);
  expect(JSON.parse(early.body).code).toBe("item_not_current");

  const ok = await app.inject({
    method: "POST",
    url: `/api/chats/${chatId}/work-plan/submit`,
    headers: { authorization: "Bearer " + token },
    payload: { item_id: "impl", result: "Сделал.", message_id: messageId },
  });
  expect(ok.statusCode, ok.body).toBe(200);
  expect(JSON.parse(ok.body).next_item.id).toBe("verify");
});
