import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("chat composition determines direct/group", () => {
  let app: FastifyInstance;
  let owner: string;
  let headers: { authorization: string };
  let first: string;
  let second: string;
  async function user(name: string) {
    const res = await app.inject({method: "POST", url: "/api/auth/register",
      payload: {name, email: `${name}-${Date.now()}@test`, password: "password123"}});
    expect(res.statusCode).toBe(200);
    return res.json();
  }
  beforeAll(async () => {
    app = await buildApp();
    const registered = await user("composition-owner");
    owner = registered.user.id;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner);
    headers = {authorization: `Bearer ${registered.token}`};
    first = (await user("composition-first")).user.id;
    second = (await user("composition-second")).user.id;
  });
  afterAll(async () => { await app?.close(); });
  async function create(members: string[], kind = "direct") {
    const response = await app.inject({method: "POST", url: "/api/chats", headers,
      payload: {kind, member_ids: members}});
    expect(response.statusCode).toBe(200);
    return response.json().chat;
  }
  function storedKind(id: string) {
    return (db.prepare("SELECT kind FROM chats WHERE id=?").get(id) as {kind: string}).kind;
  }
  it("normalizes a one-peer group at creation", async () => {
    const chat = await create([first], "group");
    expect(chat.kind).toBe("direct");
    expect(storedKind(chat.id)).toBe("direct");
  });
  it("switches direct -> group -> direct, including API reads and storage", async () => {
    const chat = await create([first]);
    const added = await app.inject({method: "POST", url: `/api/chats/${chat.id}/members`, headers,
      payload: {member_id: second}});
    expect(added.statusCode).toBe(200);
    expect(added.json().chat.kind).toBe("group");
    expect(storedKind(chat.id)).toBe("group");
    const list = (await app.inject({url: "/api/chats", headers})).json().chats;
    expect(list.find((c: any) => c.id === chat.id).kind).toBe("group");
    const removed = await app.inject({method: "DELETE", url: `/api/chats/${chat.id}/members/${second}`, headers});
    expect(removed.statusCode).toBe(200);
    expect(removed.json().chat.kind).toBe("direct");
    expect(storedKind(chat.id)).toBe("direct");
    const repeated = await app.inject({method: "POST", url: `/api/chats/${chat.id}/members`, headers,
      payload: {member_id: first}});
    expect(repeated.json().chat.kind).toBe("direct");
  });
  it("accepts secretary as a peer and as a group participant", async () => {
    const direct = await create(["u-secretary"]);
    expect(direct.members.some((m: any) => m.id === "u-secretary")).toBe(true);
    const response = await app.inject({method: "POST", url: `/api/chats/${direct.id}/members`, headers,
      payload: {member_id: first}});
    expect(response.json().chat.kind).toBe("group");
    const group = await create([first, second], "group");
    const invited = await app.inject({method: "POST", url: `/api/chats/${group.id}/members`, headers,
      payload: {member_id: "u-secretary"}});
    expect(invited.statusCode).toBe(200);
    expect(invited.json().chat.members.some((m: any) => m.id === "u-secretary")).toBe(true);
  });
  it("keeps project groups as groups when one peer remains", async () => {
    const created = await app.inject({method: "POST", url: "/api/projects", headers, payload: {name: "Composition project"}});
    expect(created.statusCode).toBe(200);
    const projectId = created.json().id;
    const chat = await create([first, second], "group");
    db.prepare("UPDATE chats SET project_id=? WHERE id=?").run(projectId, chat.id);
    const removed = await app.inject({method: "DELETE", url: `/api/chats/${chat.id}/members/${second}`, headers});
    expect(removed.statusCode).toBe(200);
    expect(removed.json().chat.kind).toBe("group");
  });
  it("repairs legacy stored kinds on startup without changing membership", async () => {
    const direct = await create([first]);
    const group = await create([first, second], "group");
    db.prepare("UPDATE chats SET kind='group' WHERE id=?").run(direct.id);
    db.prepare("UPDATE chats SET kind='direct' WHERE id=?").run(group.id);
    await app.close();
    app = await buildApp();
    expect(storedKind(direct.id)).toBe("direct");
    expect(storedKind(group.id)).toBe("group");
    expect((db.prepare("SELECT COUNT(*) AS n FROM chat_members WHERE chat_id=?").get(group.id) as {n:number}).n).toBe(3);
  });

});
