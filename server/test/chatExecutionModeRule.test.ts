// Способ выполнения определяет только задача чата (владелец 06.11.2026).
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { chatExecutionMode } from "../src/runtime/chatExecutionMode.js";

let app: any;
beforeAll(async () => { app = await buildApp(); await app.ready(); seedRoleAccounts(db); db.pragma("foreign_keys = OFF"); });
afterAll(async () => { db.pragma("foreign_keys = ON"); await app.close(); });

function chat(opts: { taskId?: string; branchOf?: string } = {}) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO chats(id,kind,created_by,task_id,branch_of_chat_id) VALUES(?,'group','u1',?,?)").run(id, opts.taskId ?? null, opts.branchOf ?? null);
  return id;
}
function message(chatId: string, mode: "chat" | "card") {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,created_at,execution_mode) VALUES(?,?,'u1','x',datetime('now'),?)").run(id, chatId, mode);
  return id;
}

it("чат без задачи — chat, даже при сохранённом card в сообщении и в чате", () => {
  const c = chat();
  const m = message(c, "card");
  db.prepare("UPDATE chats SET execution_mode='card' WHERE id=?").run(c);
  expect(chatExecutionMode(c, m)).toBe("chat");
  expect(chatExecutionMode(c)).toBe("chat");
  expect(chatExecutionMode(undefined)).toBe("chat");
});
it("чат с задачей без родителя — card, даже при сохранённом chat", () => {
  const c = chat({ taskId: "task-1" });
  const m = message(c, "chat");
  expect(chatExecutionMode(c, m)).toBe("card");
});
it("ветка субагента: от чата с задачей — card, от чата без задачи — chat", () => {
  const withTask = chat({ taskId: "task-2" });
  const branch = chat({ branchOf: withTask });
  expect(chatExecutionMode(branch)).toBe("card");
  const plain = chat();
  expect(chatExecutionMode(chat({ branchOf: plain }))).toBe("chat");
});
