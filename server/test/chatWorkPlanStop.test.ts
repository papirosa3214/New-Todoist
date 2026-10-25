// Стоп плана, блокировка и исчерпание бюджета (карточка b504958a, контракт §7).
//
// RED на старом коде: остановки плана не существовало — после «стоп» пункт
// продолжал приниматься, а повтор доставки шёл молча.
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { chatPlanView, saveChatWorkPlan, stopChatWorkPlan, submitChatWorkItem } from "../src/lib/subtaskWorkPlan.js";
import { restartDelivery } from "../src/runtime/chatDeliveryRetryBudget.js";

let app: any;
const role = "role_builder";
const planItems = [
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

function chatWithRun(generation = 1) {
  const chatId = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'group','u1')").run(chatId);
  for (const member of ["u1", role])
    db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, member);
  db.prepare("INSERT INTO chat_session_generation(chat_id,role_id,generation) VALUES(?,?,?)").run(chatId, role, generation);
  const messageId = crypto.randomUUID();
  db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,created_at) VALUES(?,?,'u1','Работай',datetime('now'))").run(messageId, chatId);
  const deliveryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status,updated_at)
     VALUES(?,?,?,?,?,?,'{}','picked',datetime('now'))`,
  ).run(deliveryId, chatId, role, deliveryId, messageId, generation);
  saveChatWorkPlan(chatId, role, 0, planItems as any);
  return { chatId, messageId, deliveryId };
}

it("стоп останавливает план, а не ставит на паузу: сдачи не принимаются", () => {
  const { chatId, messageId } = chatWithRun();
  submitChatWorkItem({ chatId, roleId: role, itemId: "one", result: "Первый готов.", outcome: "done", messageId });
  const view = stopChatWorkPlan(chatId, role, "owner_stop")!;
  expect(view.status).toBe("stopped");
  expect(view.stop_reason).toBe("owner_stop");
  expect(view.current_item_id).toBeNull();
  expect(view.items.map((i) => i.state)).toEqual(["done", "stopped", "pending"]);
  // Третий пункт не допускается: остановленный план сдачу не принимает.
  expect(() =>
    submitChatWorkItem({ chatId, roleId: role, itemId: "two", result: "Второй готов.", outcome: "done", messageId }),
  ).toThrow(/остановлен/);
  expect(chatPlanView(chatId, role)!.items[1].state).toBe("stopped");
});

it("остановленный план заменяется новым без сверки версии, старые сдачи не возвращаются", () => {
  const { chatId, messageId } = chatWithRun();
  submitChatWorkItem({ chatId, roleId: role, itemId: "one", result: "Первый готов.", outcome: "done", messageId });
  stopChatWorkPlan(chatId, role, "owner_stop");
  const fresh = saveChatWorkPlan(chatId, role, 0, [{ id: "new", title: "Новая работа", state: "pending" }] as any);
  expect(fresh.status).toBe("active");
  expect(fresh.outcomes).toEqual({});
  expect(fresh.items).toHaveLength(1);
  expect(chatPlanView(chatId, role)!.current_item_id).toBe("new");
});

it("маршрут стопа гасит план и отвечает остановленным представлением", async () => {
  const { chatId } = chatWithRun();
  const token = app.jwt.sign({ id: "u1" });
  const response = await app.inject({
    method: "POST",
    url: `/api/chats/${chatId}/work-plan/stop`,
    headers: { authorization: "Bearer " + token },
    payload: { role_id: role },
  });
  expect(response.statusCode, response.body).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.plan.status).toBe("stopped");
  expect(body.plan.items[0].state).toBe("stopped");
});

it("исчерпание бюджета повторов останавливает план с явной причиной", () => {
  const { chatId, deliveryId } = chatWithRun();
  const previous = process.env.TASKFLOW_CHAT_DELIVERY_MAX_RESTARTS;
  process.env.TASKFLOW_CHAT_DELIVERY_MAX_RESTARTS = "0";
  try {
    const outcome = restartDelivery(deliveryId, "execution_failed", "picked");
    expect(outcome).toBe("exhausted");
  } finally {
    if (previous === undefined) delete process.env.TASKFLOW_CHAT_DELIVERY_MAX_RESTARTS;
    else process.env.TASKFLOW_CHAT_DELIVERY_MAX_RESTARTS = previous;
  }
  const view = chatPlanView(chatId, role)!;
  expect(view.status).toBe("stopped");
  expect(view.stop_reason).toBe("budget_exhausted");
  expect(view.items[0].state).toBe("stopped");
});

it("заблокированный пункт держит очередь: следующий не становится текущим", () => {
  const { chatId, messageId } = chatWithRun();
  const blocked = submitChatWorkItem({
    chatId, roleId: role, itemId: "one", outcome: "blocked", blockType: "dependency", reason: "Жду ответ", messageId,
  });
  expect(blocked.item.state).toBe("blocked");
  expect(blocked.current_item_id).toBe("one");
  expect(blocked.view.items[1].state).toBe("pending");
  // Ответ пришёл: тот же пункт можно сдать, и только тогда идём дальше.
  const done = submitChatWorkItem({ chatId, roleId: role, itemId: "one", result: "Разблокировали.", outcome: "done", messageId });
  expect(done.current_item_id).toBe("two");
});
