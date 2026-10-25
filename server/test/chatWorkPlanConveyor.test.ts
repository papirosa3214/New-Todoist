// Чатовый конвейер чек-листа (карточка b504958a, контракт
// note://115ba2ac-6a1d-45ac-a92f-2081c6ecf0c2, §3 и §6).
//
// RED на старом коде: план с пометкой `done` без сдачи принимался, а текущим
// становился любой пункт, который роль назвала `in_progress`. После правки
// состояние пунктов считает сервер, и обойти сдачу записью плана нельзя.
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { ChatPlanWriteRejection, chatPlanView, readChatWorkPlan, saveChatWorkPlan } from "../src/lib/subtaskWorkPlan.js";

/** Код отказа записи плана: сообщение для роли меняется, код — контракт. */
function rejectionCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ChatPlanWriteRejection ? error.code : "other";
  }
}

let app: any;
const role = "role_builder";
const other = "role_critic_verifier";

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  seedRoleAccounts(db);
});
afterAll(async () => { await app.close(); });

function chat(members: string[] = [role]) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'group','u1')").run(id);
  db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(id, "u1");
  for (const member of members)
    db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(id, member);
  return id;
}
const plan = (states: string[]) => states.map((state, i) => ({ id: `p${i + 1}`, title: `Пункт ${i + 1}`, state }));

it("текущий пункт — первый несданный, и он один", () => {
  const id = chat();
  saveChatWorkPlan(id, role, 0, plan(["pending", "pending", "pending"]) as any);
  const view = chatPlanView(id, role)!;
  expect(view.current_item_id).toBe("p1");
  expect(view.items.map((i) => i.state)).toEqual(["in_progress", "pending", "pending"]);
});

it("пометка done без сдачи отклоняется: пункт закрывает сервер", () => {
  const id = chat();
  saveChatWorkPlan(id, role, 0, plan(["pending", "pending"]) as any);
  // RED (старый код): запись принималась и пункт 1 «закрывался» без результата.
  expect(rejectionCode(() => saveChatWorkPlan(id, role, 1, plan(["done", "pending"]) as any))).toBe("item_not_submitted");
  expect(chatPlanView(id, role)!.current_item_id).toBe("p1");
});

it("текущий пункт нельзя удалить: иначе пункт пропускается стиранием", () => {
  const id = chat();
  saveChatWorkPlan(id, role, 0, plan(["pending", "pending"]) as any);
  expect(rejectionCode(() => saveChatWorkPlan(id, role, 1, [{ id: "p2", title: "Пункт 2", state: "pending" }] as any))).toBe("current_item_locked");
});

it("начатый пункт нельзя переименовать, а новый в конец — можно", () => {
  const id = chat();
  saveChatWorkPlan(id, role, 0, plan(["pending", "pending"]) as any);
  expect(
    rejectionCode(() =>
      saveChatWorkPlan(id, role, 1, [
        { id: "p1", title: "Другое название", state: "pending" },
        { id: "p2", title: "Пункт 2", state: "pending" },
      ] as any),
    ),
  ).toBe("current_item_locked");
  const grown = saveChatWorkPlan(id, role, 1, [
    { id: "p1", title: "Пункт 1", state: "pending" },
    { id: "p2", title: "Пункт 2", state: "pending" },
    { id: "p3", title: "Новый пункт", state: "pending" },
  ] as any);
  expect(grown.items.map((i) => i.id)).toEqual(["p1", "p2", "p3"]);
  expect(grown.revision).toBe(2);
});

it("запись плана без свежей версии отклоняется, а чужой план не подмешивается", () => {
  const id = chat([role, other]);
  saveChatWorkPlan(id, role, 0, plan(["pending"]) as any);
  expect(rejectionCode(() => saveChatWorkPlan(id, role, 0, plan(["pending"]) as any))).toBe("revision_conflict");
  expect(chatPlanView(id, other)).toBeNull();
  expect(readChatWorkPlan(id, role)!.revision).toBe(1);
});

it("маршрут отдаёт представление плана и код ошибки записи", async () => {
  const id = chat();
  const token = app.jwt.sign({ id: role });
  const write = await app.inject({
    method: "PUT",
    url: `/api/chats/${id}/work-plan`,
    headers: { authorization: "Bearer " + token },
    payload: { base_revision: 0, items: plan(["pending", "pending"]) },
  });
  expect(write.statusCode, write.body).toBe(200);
  const created = JSON.parse(write.body);
  expect(created.current_item_id).toBe("p1");
  expect(created.items[0].state).toBe("in_progress");

  const bad = await app.inject({
    method: "PUT",
    url: `/api/chats/${id}/work-plan`,
    headers: { authorization: "Bearer " + token },
    payload: { base_revision: created.revision, items: plan(["done", "pending"]) },
  });
  expect(bad.statusCode).toBe(409);
  expect(JSON.parse(bad.body).code).toBe("item_not_submitted");

  const read = await app.inject({
    method: "GET",
    url: `/api/chats/${id}/work-plan`,
    headers: { authorization: "Bearer " + token },
  });
  expect(JSON.parse(read.body).current_item_id).toBe("p1");
});


it("перестановка будущего пункта перед текущим не обходит сдачу",()=>{
 const id=chat();saveChatWorkPlan(id,role,0,plan(["pending","pending"]) as any);
 const reordered=plan(["pending","pending"]).reverse();
 expect(rejectionCode(()=>saveChatWorkPlan(id,role,1,reordered as any))).toBe("current_item_locked");
 expect(chatPlanView(id,role)!.current_item_id).toBe("p1");
});
it("новый пункт перед текущим не меняет серверный допуск",()=>{
 const id=chat();saveChatWorkPlan(id,role,0,plan(["pending"]) as any);
 expect(rejectionCode(()=>saveChatWorkPlan(id,role,1,[{id:"new",title:"Обход",state:"pending"},...plan(["pending"])] as any))).toBe("current_item_locked");
 expect(chatPlanView(id,role)!.current_item_id).toBe("p1");
});
