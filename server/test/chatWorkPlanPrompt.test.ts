import { beforeAll, afterAll, it, expect } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { setInProcessApp } from "../src/runtime/inProcessRun.js";
import {
  CHAT_PLAN_MISSING_PROMPT,
  chatPlanView,
  chatWorkPlanPrompt,
  chatWorkPlanPromptText,
  saveChatWorkPlan,
  stopChatWorkPlan,
  submitChatWorkItem,
} from "../src/lib/subtaskWorkPlan.js";

const items = [
  { id: "inspect", title: "Изучить контракт", state: "pending" as const },
  { id: "implement", title: "Реализовать", state: "pending" as const },
  { id: "verify", title: "Проверить", state: "pending" as const },
];

let app: any;
const role = "role_builder";

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  setInProcessApp(app);
  seedRoleAccounts(db);
});
afterAll(async () => { await app.close(); });

function chatWithRun() {
  const chatId = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'group','u1')").run(chatId);
  for (const member of ["u1", role])
    db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, member);
  db.prepare("INSERT INTO chat_session_generation(chat_id,role_id,generation) VALUES(?,?,1)").run(chatId, role);
  const messageId = crypto.randomUUID();
  db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,created_at) VALUES(?,?,'u1','Работай',datetime('now'))").run(messageId, chatId);
  const deliveryId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status,updated_at)
     VALUES(?,?,?,?,?,1,'{}','picked',datetime('now'))`,
  ).run(deliveryId, chatId, role, deliveryId, messageId);
  return { chatId, messageId };
}

it("без плана — правило завести чек-лист, а не пустота", () => {
  expect(chatWorkPlanPromptText(null)).toBe(CHAT_PLAN_MISSING_PROMPT);
  expect(CHAT_PLAN_MISSING_PROMPT).toContain("taskflow_work_plan");
  // Простая работа — один пункт: минимум «3–7 этапов» больше не требуется.
  expect(CHAT_PLAN_MISSING_PROMPT).toContain("один пункт для простой работы");
});

it("выдаёт ровно текущий пункт, его id и способ сдачи", () => {
  const { chatId, messageId } = chatWithRun();
  saveChatWorkPlan(chatId, role, 0, items as any);
  submitChatWorkItem({ chatId, roleId: role, itemId: "inspect", result: "Изучил.", outcome: "done", messageId });
  const text = chatWorkPlanPrompt(chatId, role);
  expect(text).toContain("✓ Изучить контракт");
  expect(text).toContain("▶ Реализовать");
  expect(text).toContain("• Проверить");
  expect(text).toContain("Текущий пункт — «Реализовать» (id implement)");
  expect(text).toContain("taskflow_work_item_submit с item_id implement");
  expect(text).not.toContain("Текущий пункт — «Проверить»");
  expect(text).toContain("revision 2");
});

it("на закрытом плане сервер молчит: вести больше не по чему", () => {
  const { chatId, messageId } = chatWithRun();
  saveChatWorkPlan(chatId, role, 0, [{ id: "only", title: "Сделать", state: "pending" }] as any);
  submitChatWorkItem({ chatId, roleId: role, itemId: "only", result: "Сделал.", outcome: "done", messageId });
  expect(chatPlanView(chatId, role)!.status).toBe("finished");
  expect(chatWorkPlanPrompt(chatId, role)).toBe("");
});

it("на закрытом стопом плане сервер молчит: роль ведёт только новый план", () => {
  const { chatId } = chatWithRun();
  saveChatWorkPlan(chatId, role, 0, items as any);
  stopChatWorkPlan(chatId, role, "owner_stop");
  // Стоп сразу закрывает план (11.11.2026): вести больше не по чему.
  expect(chatWorkPlanPrompt(chatId, role)).toBe("");
});

it("ведущий пункт берётся из сохранённого плана чата, а не из головы роли", () => {
  const { chatId } = chatWithRun();
  saveChatWorkPlan(chatId, role, 0, items as any);
  expect(chatWorkPlanPrompt(chatId, role)).toContain("Текущий пункт — «Изучить контракт» (id inspect)");
  // План для другой роли в том же чате не подмешивается.
  expect(chatWorkPlanPrompt(chatId, "role_critic_verifier")).toBe(CHAT_PLAN_MISSING_PROMPT);
});
