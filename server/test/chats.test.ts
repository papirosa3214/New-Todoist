// Чаты с ролями-агентами, этап 1 (миграция 053): создание, участники, история,
// сообщение. Идём через app.inject — контракт наружу, тот же, что у клиентов.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Чаты (этап 1, миграция 053)", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let ownerId: string;
  let otherAuth: string;
  let otherId: string;

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  async function reg(name: string, role?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}@test`, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
    return { id: body.user.id as string, jwt: body.token as string };
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await reg("ChatOwner", "owner");
    ownerId = owner.id;
    ownerAuth = bearer(owner.jwt);
    const other = await reg("ChatOther");
    otherId = other.id;
    otherAuth = bearer(other.jwt);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function createChat(payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/api/chats", headers: ownerAuth, payload });
  }

  it("создаёт групповой чат и включает создателя в участники", async () => {
    const res = await createChat({ title: "Совет", kind: "group", member_ids: [otherId] });
    expect(res.statusCode).toBe(200);
    const chat = res.json().chat;
    expect(chat.kind).toBe("group");
    expect(chat.title).toBe("Совет");
    const ids = chat.members.map((m: { id: string }) => m.id);
    expect(ids).toContain(ownerId);
    expect(ids).toContain(otherId);
  });

  it("персональный чат требует ровно одного участника", async () => {
    const bad = await createChat({ kind: "direct", member_ids: [otherId, ownerId] });
    expect(bad.statusCode).toBe(400);
    const ok = await createChat({ kind: "direct", member_ids: [otherId] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().chat.members).toHaveLength(2);
  });

  it("персональный чат с самим собой → 400 (B1)", async () => {
    const res = await createChat({ kind: "direct", member_ids: [ownerId] });
    expect(res.statusCode).toBe(400);
  });

  it("несуществующий участник → 400", async () => {
    const res = await createChat({ member_ids: ["no-such-user"] });
    expect(res.statusCode).toBe(400);
  });

  it("список чатов показывает чат участнику", async () => {
    const created = await createChat({ title: "Видно", member_ids: [otherId] });
    const id = created.json().chat.id;
    const mine = await app.inject({ method: "GET", url: "/api/chats", headers: ownerAuth });
    expect(mine.json().chats.map((c: { id: string }) => c.id)).toContain(id);
  });

  it("чужой чат недоступен → 404", async () => {
    const created = await createChat({ title: "Только моё", member_ids: [] });
    // member_ids пуст → 400; создаём корректно с другим участником
    const created2 = await createChat({ title: "Закрытый", member_ids: [ownerId] });
    const id = created2.json().chat.id;
    // otherId не участник
    const peek = await app.inject({
      method: "GET",
      url: `/api/chats/${id}`,
      headers: otherAuth,
    });
    expect(peek.statusCode).toBe(404);
    expect(created.statusCode).toBe(400);
  });

  it("сообщение ложится в чат и возвращается в истории", async () => {
    const created = await createChat({ title: "Переписка", member_ids: [otherId] });
    const id = created.json().chat.id;
    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/messages`,
      headers: ownerAuth,
      payload: { text: "привет" },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message.text).toBe("привет");
    const hist = await app.inject({
      method: "GET",
      url: `/api/chats/${id}/messages`,
      headers: ownerAuth,
    });
    expect(hist.json().messages.map((m: { text: string }) => m.text)).toEqual(["привет"]);
  });

  it("пустое сообщение → 400", async () => {
    const created = await createChat({ member_ids: [otherId] });
    const id = created.json().chat.id;
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/messages`,
      headers: ownerAuth,
      payload: { text: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("себя из чата убрать нельзя → 400; чужой не удаляет чат → 403; создатель удаляет → 200", async () => {
    const created = await createChat({ member_ids: [otherId] });
    const id = created.json().chat.id;
    const selfRemove = await app.inject({
      method: "DELETE",
      url: `/api/chats/${id}/members/${ownerId}`,
      headers: ownerAuth,
    });
    expect(selfRemove.statusCode).toBe(400);
    const foreignDelete = await app.inject({
      method: "DELETE",
      url: `/api/chats/${id}`,
      headers: otherAuth,
    });
    expect(foreignDelete.statusCode).toBe(403);
    const ownDelete = await app.inject({
      method: "DELETE",
      url: `/api/chats/${id}`,
      headers: ownerAuth,
    });
    expect(ownDelete.statusCode).toBe(200);
  });

  it("участников меняет только создатель", async () => {
    const created = await createChat({ title: "Состав", member_ids: [otherId] });
    const id = created.json().chat.id;
    const denied = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/members`,
      headers: otherAuth,
      payload: { member_id: otherId },
    });
    expect(denied.statusCode).toBe(403);
    const added = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/members`,
      headers: ownerAuth,
      payload: { member_id: ownerId },
    });
    expect(added.statusCode).toBe(200);
  });
});
