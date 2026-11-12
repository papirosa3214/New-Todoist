// Удаление чата насовсем (владелец 08.11.2026): в меню чата есть «В архив» и
// «Удалить». Сначала архив, потом удаление; удалённое не возвращается.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { ensurePersonalRoom } from "../src/lib/chatRooms.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

describe("Удаление чата насовсем", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let otherAuth: { authorization: string };
  let otherId: string;
  let ownerId: string;

  async function reg(name: string, role?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}-${Math.random()}@test`, password: "password123" },
    });
    const body = res.json();
    if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
    return { id: body.user.id as string, auth: { authorization: `Bearer ${body.token}` } };
  }

  async function newChat(title: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { title, member_ids: [otherId] },
    });
    expect(res.statusCode).toBe(200);
    return res.json().chat as { id: string };
  }

  const post = (url: string, headers: any, payload: any = {}) =>
    app.inject({ method: "POST", url, headers, payload });

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const owner = await reg("PurgeOwner", "owner");
    ownerAuth = owner.auth;
    ownerId = owner.id;
    // Владелец — участник общей комнаты, иначе её и не видно (404).
    db.prepare("INSERT OR IGNORE INTO chat_members(chat_id, member_id) VALUES ('chat-common', ?)").run(ownerId);
    const other = await reg("PurgeOther");
    otherAuth = other.auth;
    otherId = other.id;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("удаляет сразу, без «В архив»: как в GPT — архив или насовсем", async () => {
    const chat = await newChat("Удаляю сразу");
    const res = await post(`/api/chats/${chat.id}/purge`, ownerAuth);
    expect(res.statusCode).toBe(200);
    expect(db.prepare("SELECT 1 FROM chats WHERE id = ?").get(chat.id)).toBeFalsy();
  });

  it("из архива возвращается: снимаются уборка и закрытие", async () => {
    const chat = await newChat("Вернуть из архива");
    const archived = await post(`/api/chats/${chat.id}/archive`, ownerAuth);
    expect(archived.statusCode).toBe(200);
    let row = db.prepare("SELECT archived_at, closed_at FROM chats WHERE id = ?").get(chat.id) as
      | { archived_at: string | null; closed_at: string | null }
      | undefined;
    expect(row?.archived_at).toBeTruthy();

    const back = await post(`/api/chats/${chat.id}/unarchive`, ownerAuth);
    expect(back.statusCode).toBe(200);
    row = db.prepare("SELECT archived_at, closed_at FROM chats WHERE id = ?").get(chat.id) as
      | { archived_at: string | null; closed_at: string | null }
      | undefined;
    expect(row?.archived_at).toBeFalsy();
    expect(row?.closed_at).toBeFalsy();
    // Вернувшийся чат снова принимает сообщения.
    const sent = await post(`/api/chats/${chat.id}/messages`, ownerAuth, { text: "снова на связи" });
    expect(sent.statusCode).toBe(200);
  });

  it("из архива удаляет комнату, переписку, очередь и вопросы", async () => {
    const chat = await newChat("Удаляемая");
    await post(`/api/chats/${chat.id}/messages`, ownerAuth, { text: "тут была переписка" });
    // Очередь доставки и открытый вопрос — обе строки должны уйти вместе с чатом.
    db.prepare(
      `INSERT INTO chat_message_queue(id, chat_id, role_id, delivery_id, message_id, session_generation, payload_json, status, updated_at)
       VALUES ('purge-q1', ?, 'role_builder', 'purge-q1', NULL, 1, '{}', 'pending', datetime('now'))`,
    ).run(chat.id);
    db.prepare(
      "INSERT INTO chat_questions(id, chat_id, role_id, payload_json, status, created_at) VALUES ('purge-question', ?, 'role_builder', '{}', 'open', datetime('now'))",
    ).run(chat.id);

    expect((await post(`/api/chats/${chat.id}/archive`, ownerAuth)).statusCode).toBe(200);
    const res = await post(`/api/chats/${chat.id}/purge`, ownerAuth);
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(res.json().messages).toBeGreaterThan(0);

    expect(db.prepare("SELECT 1 FROM chats WHERE id = ?").get(chat.id)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(chat.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?").get(chat.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_message_queue WHERE chat_id = ?").get(chat.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_questions WHERE chat_id = ?").get(chat.id)).toEqual({ n: 0 });
    expect((await app.inject({ method: "GET", url: `/api/chats/${chat.id}`, headers: ownerAuth })).statusCode).toBe(404);
  });

  it("удаление не задевает соседний чат", async () => {
    const doomed = await newChat("Уходит");
    const alive = await newChat("Остаётся");
    await post(`/api/chats/${alive.id}/messages`, ownerAuth, { text: "не трогать" });
    await post(`/api/chats/${doomed.id}/archive`, ownerAuth);
    expect((await post(`/api/chats/${doomed.id}/purge`, ownerAuth)).statusCode).toBe(200);
    expect(db.prepare("SELECT 1 FROM chats WHERE id = ?").get(alive.id)).toBeTruthy();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(alive.id) as { n: number }).n,
    ).toBe(1);
    await post(`/api/chats/${alive.id}/archive`, ownerAuth);
  });

  it("чужой участник удалить не может, автор — может", async () => {
    const chat = await newChat("Чужая переписка");
    await post(`/api/chats/${chat.id}/archive`, ownerAuth);
    const foreign = await post(`/api/chats/${chat.id}/purge`, otherAuth);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error).toBe("удалить чат может только его создатель");
    const own = await post(`/api/chats/${chat.id}/purge`, ownerAuth);
    expect(own.statusCode).toBe(200);
  });

  it("общая комната и личная комната роли не удаляются", async () => {
    const common = await post("/api/chats/chat-common/purge", ownerAuth);
    expect(common.statusCode).toBe(403);
    expect(common.json().error).toBe("общую комнату удалить нельзя");

    const personal = ensurePersonalRoom("role_builder")!;
    await post(`/api/chats/${personal}/archive`, ownerAuth);
    const res = await post(`/api/chats/${personal}/purge`, ownerAuth);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("личная комната роли не удаляется");
    expect(db.prepare("SELECT 1 FROM chats WHERE id = ?").get(personal)).toBeTruthy();
  });
});
