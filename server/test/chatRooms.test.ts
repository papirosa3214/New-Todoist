// Раздел «Чаты»: постоянные комнаты и лички ролей (21.10.2026,
// docs/2026-10-21-chats-rooms-and-sessions.md).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { ensureDirectRoom, ensurePersonalRoom, roomsSnapshot } from "../src/lib/chatRooms.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

describe("комнаты ролей и лички", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerAuth: Record<string, string>;
  let strangerAuth: Record<string, string>;

  async function reg(name: string) {
    const res = await app.inject({ method: "POST", url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}-${Math.random()}@test`, password: "password123" } });
    const body = res.json();
    return { id: body.user.id as string, auth: { authorization: `Bearer ${body.token}` } };
  }

  beforeAll(async () => {
    app = await buildApp();
    const insert = db.prepare(`INSERT OR IGNORE INTO users (id, name, role, role_key, type, email, password_hash, is_system_bot)
      VALUES (?, ?, 'agent', ?, 'ai', ?, '!test', 1)`);
    db.prepare("INSERT OR IGNORE INTO roles (key, title, summary, enabled, position) VALUES ('code_orchestrator','Оркестратор','оркестратор',1,9)").run();
    for (const r of ["builder", "code_orchestrator"]) insert.run(`role_${r}`, r, r, `${r}@rooms-test`);
    db.prepare("UPDATE users SET role='agent' WHERE role='owner'").run();
    const owner = await reg("RoomsOwner");
    ownerId = owner.id;
    ownerAuth = owner.auth;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
    strangerAuth = (await reg("RoomsStranger")).auth;
  });

  afterAll(async () => { if (app) await app.close(); });

  it("личная комната роли одна и помечена personal", () => {
    const a = ensurePersonalRoom("role_builder");
    const b = ensurePersonalRoom("role_builder");
    expect(a).toBe(b);
    expect(db.prepare("SELECT room_kind FROM chats WHERE id=?").get(a)).toMatchObject({ room_kind: "personal" });
    const members = (db.prepare("SELECT member_id FROM chat_members WHERE chat_id=?").all(a) as any[]).map((m) => m.member_id).sort();
    expect(members).toEqual([ownerId, "role_builder"].sort());
  });

  it("служебный чат на тех же двоих личкой не считается", () => {
    db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by,room_kind) VALUES ('integration:role_code_orchestrator','Передача принятых изменений','direct','role_builder','handoff')").run();
    for (const m of ["role_builder", "role_code_orchestrator"]) db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES ('integration:role_code_orchestrator',?)").run(m);
    const dm = ensureDirectRoom("role_builder", "role_code_orchestrator");
    expect(dm).not.toBe("integration:role_code_orchestrator");
    expect(ensureDirectRoom("role_code_orchestrator", "role_builder")).toBe(dm);
  });

  it("снимок отдаёт личку у обеих ролей с одним ключом пары", () => {
    const dm = ensureDirectRoom("role_builder", "role_code_orchestrator");
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES (?,?,?,'chat',?)").run("rooms-msg-1", "role_builder", "посмотри план", dm);
    const snap = roomsSnapshot();
    const builder = snap.roles.find((r) => r.id === "role_builder")!;
    const orch = snap.roles.find((r) => r.id === "role_code_orchestrator")!;
    const a = builder.dms.find((d) => d.chat_id === dm)!;
    const b = orch.dms.find((d) => d.chat_id === dm)!;
    expect(a.pair).toBe(b.pair);
    expect(a.live).toBe(true);
    expect(a.peer_id).toBe("role_code_orchestrator");
    expect(orch.personal_chat_id).toBeTruthy();
  });

  it("владелец читает личку ролей, но не пишет в неё; чужой не видит комнат", async () => {
    const dm = ensureDirectRoom("role_builder", "role_code_orchestrator");
    expect((await app.inject({ method: "GET", url: `/api/chats/${dm}/messages`, headers: ownerAuth })).statusCode).toBe(200);
    const write = await app.inject({ method: "POST", url: `/api/chats/${dm}/messages`, headers: ownerAuth, payload: { text: "привет" } });
    expect(write.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/chats/rooms", headers: strangerAuth })).statusCode).toBe(403);
    const rooms = await app.inject({ method: "GET", url: "/api/chats/rooms", headers: ownerAuth });
    expect(rooms.statusCode).toBe(200);
    expect(rooms.json().common.chat_id).toBe("chat-common");
  });

  it("with-role открывает личную комнату, а не служебный чат", async () => {
    const res = await app.inject({ method: "POST", url: "/api/chats/with-role", headers: ownerAuth, payload: { role_id: "role_builder" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().chat.id).toBe(ensurePersonalRoom("role_builder"));
    expect(res.json().chat.room_kind).toBe("personal");
  });

  it("сессию закрывают и возвращают, постоянную комнату — нет", async () => {
    const personal = ensurePersonalRoom("role_builder")!;
    expect((await app.inject({ method: "POST", url: `/api/chats/${personal}/close`, headers: ownerAuth, payload: {} })).statusCode).toBe(409);
    const created = await app.inject({ method: "POST", url: "/api/chats", headers: ownerAuth, payload: { title: "Разговор", member_ids: ["role_builder", "role_code_orchestrator"] } });
    const id = created.json().chat.id;
    const closed = await app.inject({ method: "POST", url: `/api/chats/${id}/close`, headers: ownerAuth, payload: {} });
    expect(closed.json().chat.closed_at).toBeTruthy();
    const list = (await app.inject({ method: "GET", url: "/api/chats", headers: ownerAuth })).json().chats.map((c: any) => c.id);
    expect(list).not.toContain(id);
    const listed = (await app.inject({ method: "GET", url: "/api/chats?include_closed=1", headers: ownerAuth })).json().chats.find((c: any) => c.id === id);
    expect(listed).toHaveProperty("room_kind", null);
    expect(listed).toHaveProperty("project_name", null);
    const back = await app.inject({ method: "POST", url: `/api/chats/${id}/close`, headers: ownerAuth, payload: { closed: false } });
    expect(back.json().chat.closed_at).toBeNull();
  });
});
