import { beforeAll, afterAll, it, expect } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { setInProcessApp } from "../src/runtime/inProcessRun.js";
import {
  CHAT_PLAN_MISSING_PROMPT,
  chatWorkPlanPrompt,
  chatWorkPlanPromptText,
  saveChatWorkPlan,
} from "../src/lib/subtaskWorkPlan.js";

const items = [
  { id: "inspect", title: "Изучить контракт", state: "done" as const },
  { id: "implement", title: "Реализовать", state: "in_progress" as const },
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

it("без плана — правило завести чек-лист, а не пустота", () => {
  expect(chatWorkPlanPromptText([], 0)).toBe(CHAT_PLAN_MISSING_PROMPT);
  expect(CHAT_PLAN_MISSING_PROMPT).toContain("taskflow_work_plan");
});

it("на закрытом плане сервер молчит: вести больше не по чему", () => {
  expect(chatWorkPlanPromptText(items.map((i) => ({ ...i, state: "done" as const })), 7)).toBe("");
});

it("выдаёт ровно текущий этап и его id, остальные не предлагает", () => {
  const text = chatWorkPlanPromptText(items, 3);
  expect(text).toContain("▶ Реализовать");
  expect(text).toContain("✓ Изучить контракт");
  expect(text).toContain("• Проверить");
  expect(text).toContain("Текущий этап — «Реализовать» (id implement)");
  expect(text).toContain("base_revision 3");
  expect(text).not.toContain("Текущий этап — «Проверить»");
});

it("ведущий этап берётся из сохранённого плана чата, а не из головы роли", () => {
  const chatId = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'direct','u1')").run(chatId);
  db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, "u1");
  db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, role);
  saveChatWorkPlan(chatId, role, 0, items);

  const text = chatWorkPlanPrompt(chatId, role);
  expect(text).toContain("Текущий этап — «Реализовать» (id implement)");
  expect(text).toContain("revision 1");

  // План для другой роли в том же чате не подмешивается.
  expect(chatWorkPlanPrompt(chatId, "role_critic_verifier")).toBe(CHAT_PLAN_MISSING_PROMPT);
});
