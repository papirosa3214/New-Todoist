// Ветка от сообщения (владелец 14.10.2026): отдельный чат с теми же
// участниками, первым сообщением — копия исходного от того же автора.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner } from "./helpers/seedOwner.js";

describe("Ветка чата от сообщения", () => {
  let app: FastifyInstance;
  let owner: { token: string; id: string };
  let other: { token: string; id: string };
  const register = async (name: string, email: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name, email, password: "password123" } });
    return { token: res.json().token, id: res.json().user.id };
  };
  const as = (token: string, method: any, url: string, payload?: any) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    owner = await register("Хозяин", "owner@branch.test");
    db.prepare("UPDATE users SET role = \x27owner\x27 WHERE id = ?").run(owner.id);
    other = await register("Собеседник", "other@branch.test");
  });
  afterAll(async () => { await app.close(); });

  it("создаёт ветку с теми же участниками и копией сообщения", async () => {
    const chat = (await as(owner.token, "POST", "/api/chats", { kind: "group", title: "Основной", member_ids: [other.id] })).json().chat;
    const sent = await as(other.token, "POST", `/api/chats/${chat.id}/messages`, { text: "## План\nСначала реестр, потом шлюз." });
    expect(sent.statusCode).toBeLessThan(300);
    const messageId = sent.json().message.id;

    const res = await as(owner.token, "POST", `/api/chats/${chat.id}/branch`, { message_id: messageId });
    expect(res.statusCode).toBe(200);
    const branch = res.json().chat;
    expect(branch.branch_of_chat_id).toBe(chat.id);
    expect(branch.branch_of_message_id).toBe(messageId);
    expect(branch.title).toBe("Ветка: План");
    expect(branch.members.map((m: any) => m.id).sort()).toEqual([owner.id, other.id].sort());

    const messages = (await as(owner.token, "GET", `/api/chats/${branch.id}/messages`)).json().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].from_user_id).toBe(other.id);
    expect(messages[0].text).toBe("## План\nСначала реестр, потом шлюз.");

    const parentMessages = (await as(owner.token, "GET", `/api/chats/${chat.id}/messages`)).json().messages;
    expect(parentMessages).toHaveLength(1);
  });

  it("чужое сообщение и чужой чат — 404", async () => {
    const chat = (await as(owner.token, "POST", "/api/chats", { kind: "group", member_ids: [other.id] })).json().chat;
    expect((await as(owner.token, "POST", `/api/chats/${chat.id}/branch`, { message_id: "нет" })).statusCode).toBe(404);
    const outsider = await register("Чужой", "outsider@branch.test");
    expect((await as(outsider.token, "POST", `/api/chats/${chat.id}/branch`, { message_id: "нет" })).statusCode).toBe(404);
  });
});
