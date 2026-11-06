// Подсказка «сдай пункт» по смыслу промежуточного сообщения; модель эмбеддинга подменена.
import crypto from "node:crypto";
import { beforeAll, afterAll, afterEach, it, expect } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { saveChatWorkPlan, submitChatWorkItem } from "../src/lib/subtaskWorkPlan.js";
import { PlanHintGuard, assistantTextOf, setPlanHintEmbedder, cosine } from "../src/runtime/chatPlanHints.js";

let app: any;
const role = "role_builder";
beforeAll(async () => { app = await buildApp(); await app.ready(); seedRoleAccounts(db); });
afterAll(async () => { await app.close(); });
afterEach(() => setPlanHintEmbedder(null));

// «Эмбеддинг» по ключевым словам: одинаковая тема — одинаковый вектор.
const topic = (t: string) => (/контекст/i.test(t) ? [1, 0, 0] : /реализ/i.test(t) ? [0, 1, 0] : [0, 0, 1]);
function setup() {
  const chatId = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'group','u1')").run(chatId);
  for (const m of ["u1", role]) db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chatId, m);
  const messageId = crypto.randomUUID();
  db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,created_at) VALUES(?,?,'u1','x',datetime('now'))").run(messageId, chatId);
  db.prepare("INSERT OR IGNORE INTO chat_session_generation(chat_id,role_id,generation) VALUES(?,?,1)").run(chatId, role);
  const d = crypto.randomUUID();
  db.prepare(`INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status,updated_at)
    VALUES(?,?,?,?,?,1,'{}','picked',datetime('now'))`).run(d, chatId, role, d, messageId);
  saveChatWorkPlan(chatId, role, 0, [{ id: "context", title: "Собрать контекст", state: "pending" }, { id: "impl", title: "Реализовать правку", state: "pending" }] as any);
  return { chatId, messageId };
}
const journal = (chatId: string) => db.prepare("SELECT * FROM chat_plan_hints WHERE chat_id=? ORDER BY id").all(chatId) as any[];

it("совпало с текущим — подсказка один раз на пункт; журнал; сдан ли потом", async () => {
  setPlanHintEmbedder(async (ts) => ts.map(topic));
  const { chatId, messageId } = setup();
  const g = new PlanHintGuard(chatId, role);
  const hint = await g.observe("Я собрал весь контекст по задаче и записал выводы");
  expect(hint).toContain("«Собрать контекст»"); expect(hint).toContain("taskflow_work_item_submit");
  expect(await g.observe("Контекст по задаче собран, повторяю ещё раз для верности")).toBeNull();
  let rows = journal(chatId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ role_id: role, item_id: "context", kind: "current", submitted_after: null });
  expect(rows[0].cosine).toBeGreaterThanOrEqual(0.8);
  submitChatWorkItem({ chatId, roleId: role, itemId: "context", outcome: "done", result: "ok", messageId });
  rows = journal(chatId);
  expect(rows[0].submitted_after).toBe(1);
});
it("совпало со следующим при несданном текущем — другая подсказка; не по теме — тишина", async () => {
  setPlanHintEmbedder(async (ts) => ts.map(topic));
  const { chatId } = setup();
  const g = new PlanHintGuard(chatId, role);
  expect(await g.observe("Погода сегодня хорошая, гуляем по парку и пьём чай")).toBeNull();
  const hint = await g.observe("Уже реализую правку в модуле, пишу код сейчас");
  expect(hint).toContain("Ты уже работаешь над «Реализовать правку»"); expect(hint).toContain("«Собрать контекст» не сдан");
  expect(journal(chatId).map((r) => r.kind)).toEqual(["next"]);
});
it("порог из настроек: ниже порога — молчим", async () => {
  const { chatId } = setup();
  setPlanHintEmbedder(async (ts) => ts.map((t, i) => (i === 0 ? [0.7, 0.714, 0] : topic(t))));
  expect(cosine([0.7, 0.714, 0], [1, 0, 0])).toBeLessThan(0.8);
  expect(await new PlanHintGuard(chatId, role).observe("Нечто промежуточное по контексту и правке")).toBeNull();
});
it("модель недоступна — fail-open, одна запись в журнале", async () => {
  setPlanHintEmbedder(async () => { throw new Error("ollama down"); });
  const { chatId } = setup();
  const g = new PlanHintGuard(chatId, role);
  expect(await g.observe("Я собрал весь контекст по задаче")).toBeNull();
  expect(await g.observe("Я собрал весь контекст по задаче ещё раз")).toBeNull();
  const rows = journal(chatId);
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ kind: "embed_unavailable" });
});
it("текст берётся только из assistant message_end", () => {
  expect(assistantTextOf({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "привет" }, { type: "toolCall" }] } })).toBe("привет");
  expect(assistantTextOf({ type: "message_end", message: { role: "user", content: "x" } })).toBe("");
  expect(assistantTextOf({ type: "message_update" })).toBe("");
});
