// Сообщение из другого чата: строка с message_id в тексте хода; R015 в инструкцию не входит.
import crypto from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { crossChatNotice } from "../src/lib/crossChatNotice.js";
import { rulesFor } from "../src/lib/roleRules.js";
import { chatSystemPrompt } from "../src/runtime/instructionResources.js";
import { roleHome } from "../src/runtime/roleHome.js";

let app: any;
beforeAll(async () => { app = await buildApp(); await app.ready(); seedRoleAccounts(db); });
afterAll(async () => { await app.close(); });
const mkChat = (title: string) => { const id = crypto.randomUUID(); db.prepare("INSERT INTO chats(id,kind,created_by,title) VALUES(?,'group','u1',?)").run(id, title); return id; };
const mkMsg = (chatId: string) => { const id = crypto.randomUUID(); db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,created_at) VALUES(?,?,'u1','привет',datetime('now'))").run(id, chatId); return id; };

it("из другого чата — строка с message_id и названием; из того же — пусто", () => {
  const origin = mkChat("Рабочий разговор"), turn = mkChat("Комната роли");
  const m = mkMsg(origin);
  const line = crossChatNotice(m, turn);
  expect(line).toContain("«Рабочий разговор»");
  expect(line).toContain(`taskflow_chat_reply(message_id="${m}"`);
  expect(line).toMatch(/от .+\./);
  expect(crossChatNotice(m, origin)).toBe("");
  expect(crossChatNotice("нет-такого", turn)).toBe("");
});
it("постоянного правила про ответ в другой чат в инструкции нет", async () => {
  const ASK = /если сообщение из другого чата/;
  for (const ch of ["chat", "card", "voice"] as const) expect(rulesFor("builder", ch).some((x) => ASK.test(x.text)), ch).toBe(false);
  const prompt = await chatSystemPrompt("builder", "work", roleHome("builder").workspace);
  expect(prompt).not.toMatch(ASK);
});
