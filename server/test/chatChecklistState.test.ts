// Карточка 21842242-9add-4628-8535-1ae3458fef40: «Отметки в виджете checklist
// должны доезжать до роли».
//
// До этой работы отметка пункта жила только в клиенте: в ленте taskflow_chat_read
// её не было, отдельной операции чтения — тоже. Здесь проверяем весь путь:
//   клиент (POST .../checklist) → строка в chat_checklist_items →
//   GET /api/chats/:id/checklist → операция роли taskflow_checklist_state,
// плюс отказ на несуществующем пункте, снятие отметки и права участника чата.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { taskflowTools } from "../src/runtime/inProcessRun.js";
import { isReadOperation } from "../src/runtime/universalTaskflow.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

let app: any;
let owner: string;
let auth: { authorization: string };
const roleAuth = (role: string) => ({
  authorization: `Bearer ${app.jwt.sign({ id: "role_" + role })}`,
});

const CHECKLIST_TEXT = [
  "Вот на вечер:",
  "```widget",
  JSON.stringify({
    type: "checklist",
    title: "Дела на вечер",
    items: [
      { key: "pay", text: "Оплатить карту", done: false },
      { text: "Отчёт по проекту", done: false },
    ],
  }),
  "```",
].join("\n");

/** Старый формат Помощника владельца: без type, checklists + checked. */
const LEGACY_TEXT = [
  "```widget",
  JSON.stringify({
    checklists: [
      { title: "Старое", items: [{ text: "Первый" }, { text: "Второй", checked: true }] },
    ],
  }),
  "```",
].join("\n");

function makeChat(text: string): { chatId: string; messageId: string } {
  const chatId = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'direct',?)").run(chatId, owner);
  const member = db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)");
  member.run(chatId, owner);
  member.run(chatId, SECRETARY_ID);
  const messageId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO chat_messages(id,from_user_id,chat_id,text,created_at) VALUES(?,?,?,?,datetime('now'))",
  ).run(messageId, SECRETARY_ID, chatId, text);
  return { chatId, messageId };
}

const invokeTool = async (role: string, name: string, params: any, chatId?: string) => {
  const tools = taskflowTools(role, null, undefined, undefined, false, chatId ? { chatId, messageId: "" } : undefined);
  const tool = tools.find((t: any) => t.name === name);
  expect(tool, `инструмент ${name} есть у роли`).toBeTruthy();
  const result = await tool!.execute("test", params);
  return JSON.parse((result as any).content[0].text);
};

const SECRETARY_ID = "u-secretary";

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  owner = crypto.randomUUID();
  db.prepare(
    "INSERT INTO users(id,name,email,password_hash,role,type) VALUES (?,'Owner',?,'!','owner','human')",
  ).run(owner, owner + "@test");
  auth = { authorization: "Bearer " + app.jwt.sign({ id: owner }) };
  // Помощник владельца — фиксированная учётка u-secretary (roleRouting.ts);
  // проверяем, что она есть: без неё тест молча схватил бы пустой чат.
  expect(db.prepare("SELECT id FROM users WHERE id=?").get(SECRETARY_ID)).toBeTruthy();
});

afterAll(async () => {
  await app.close();
});

const mark = (chatId: string, messageId: string, payload: any, headers = auth) =>
  app.inject({
    method: "POST",
    url: `/api/chats/${chatId}/messages/${messageId}/checklist`,
    headers,
    payload,
  });

describe("отметки checklist-виджета доезжают до роли", () => {
  it("клиент шлёт отметку, сервер её хранит и отдаёт в истории сообщений", async () => {
    const { chatId, messageId } = makeChat(CHECKLIST_TEXT);
    const res = await mark(chatId, messageId, { widget_key: "0", item_key: "pay", done: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().checklist_state).toEqual([
      { widget_key: "0", item_key: "pay", done: true },
    ]);

    const history = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages`,
      headers: auth,
    });
    const message = history.json().messages.find((m: any) => m.id === messageId);
    // Это то, что читает taskflow_chat_read: отметка видна в ленте роли.
    expect(message.checklist_state).toEqual([
      { widget_key: "0", item_key: "pay", done: true },
    ]);
  });

  it("роль читает состояние операцией и получает подпись пункта", async () => {
    const { chatId, messageId } = makeChat(CHECKLIST_TEXT);
    await mark(chatId, messageId, { widget_key: "0", item_key: "pay", done: true });

    const state = await invokeTool("secretary", "taskflow_checklist_state", { chat_id: chatId });
    expect(state.отмечено).toBe(1);
    expect(state.всего).toBe(2);
    const items = state.сообщения[0].widgets[0].items;
    expect(items).toEqual([
      { item_key: "pay", label: "Оплатить карту", done: true },
      { item_key: "1", label: "Отчёт по проекту", done: false },
    ]);

    const onlyDone = await invokeTool(
      "secretary",
      "taskflow_checklist_state",
      { chat_id: chatId, only_done: true },
    );
    expect(onlyDone.сообщения[0].widgets[0].items).toHaveLength(1);
  });

  it("операция объявлена чтением: request_id не нужен", () => {
    expect(isReadOperation("taskflow_checklist_state")).toBe(true);
  });

  it("снятие отметки возвращает пункт в неотмеченные", async () => {
    const { chatId, messageId } = makeChat(CHECKLIST_TEXT);
    await mark(chatId, messageId, { item_key: "pay", done: true });
    const off = await mark(chatId, messageId, { item_key: "pay", done: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().checklist_state).toEqual([
      { widget_key: "0", item_key: "pay", done: false },
    ]);
    const state = await invokeTool("secretary", "taskflow_checklist_state", { chat_id: chatId });
    expect(state.отмечено).toBe(0);
  });

  it("пункт ищется по ключу и по номеру, виджет — по id и по номеру блока", async () => {
    const { chatId, messageId } = makeChat(
      [
        "Два виджета:",
        "```widget",
        JSON.stringify({ type: "checklist", id: "w-morning", items: [{ text: "Утро" }] }),
        "```",
        "```widget",
        JSON.stringify({ type: "checklist", id: "w-evening", items: [{ text: "Вечер" }] }),
        "```",
      ].join("\n"),
    );
    // вечерний — по его id, утренний — по номеру блока (1-й, т.е. 0).
    expect((await mark(chatId, messageId, { widget_key: "w-evening", item_key: "0", done: true })).statusCode).toBe(200);
    expect((await mark(chatId, messageId, { widget_key: "0", item_key: "0", done: true })).statusCode).toBe(200);
    const state = await invokeTool("secretary", "taskflow_checklist_state", { chat_id: chatId });
    const widgets = state.сообщения[0].widgets;
    // Состояние хранится под настоящим id виджета, даже если клиент прислал номер.
    expect(widgets.map((w: any) => w.widget_key).sort()).toEqual(["w-evening", "w-morning"]);
    expect(state.отмечено).toBe(2);
  });

  it("старый формат Помощника владельца (checklists/checked) тоже находится", async () => {
    const { chatId, messageId } = makeChat(LEGACY_TEXT);
    const res = await mark(chatId, messageId, { widget_key: "0", item_key: "1", done: true });
    expect(res.statusCode, res.body).toBe(200);
    const state = await invokeTool("secretary", "taskflow_checklist_state", { chat_id: chatId });
    expect(state.сообщения[0].widgets[0].items[1]).toEqual({
      item_key: "1",
      label: "Второй",
      done: true,
    });
  });

  it("несуществующий пункт отвергается и в базу не попадает", async () => {
    const { chatId, messageId } = makeChat(CHECKLIST_TEXT);
    const res = await mark(chatId, messageId, { widget_key: "0", item_key: "нет-такого", done: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("нет пункта");
    const wrongWidget = await mark(chatId, messageId, { widget_key: "9", item_key: "pay", done: true });
    expect(wrongWidget.statusCode).toBe(400);
    expect(db.prepare("SELECT count(*) n FROM chat_checklist_items WHERE message_id=?").get(messageId)).toEqual({ n: 0 });
  });

  it("без поля done запрос отвергается", async () => {
    const { chatId, messageId } = makeChat(CHECKLIST_TEXT);
    const res = await mark(chatId, messageId, { item_key: "pay" });
    expect(res.statusCode).toBe(400);
  });

  it("чужой в чате не может отмечать и не читает состояние", async () => {
    const { chatId, messageId } = makeChat(CHECKLIST_TEXT);
    const res = await mark(chatId, messageId, { item_key: "pay", done: true }, roleAuth("architect"));
    expect(res.statusCode).toBe(404);
    const read = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/checklist`,
      headers: roleAuth("architect"),
    });
    expect(read.statusCode).toBe(404);
    expect(db.prepare("SELECT count(*) n FROM chat_checklist_items WHERE message_id=?").get(messageId)).toEqual({ n: 0 });
  });

  it("сообщение из чужого чата не принимается", async () => {
    const a = makeChat(CHECKLIST_TEXT);
    const b = makeChat(CHECKLIST_TEXT);
    const res = await mark(b.chatId, a.messageId, { item_key: "pay", done: true });
    expect(res.statusCode).toBe(404);
  });

  it("в чате без отметок роль получает пустой, но понятный ответ", async () => {
    const { chatId } = makeChat(CHECKLIST_TEXT);
    const state = await invokeTool("secretary", "taskflow_checklist_state", { chat_id: chatId });
    expect(state.отмечено).toBe(0);
    expect(state.подсказка).toContain("не отмечал");
  });
});