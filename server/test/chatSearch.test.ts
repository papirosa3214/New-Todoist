// Поиск по чатам (владелец 08.11.2026: «а поиск бы обязательно ещё бы сделал»):
// находит по названию комнаты, по имени собеседника и по тексту сообщений;
// служебные строки в выдачу не попадают; короткий запрос — пустая выдача.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

const HIT = "арендованное помещение";
const CHAT_A = "search-chat-a";
const CHAT_B = "search-chat-b";


describe("Поиск по чатам", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let ownerId: string;
  let roleId: string;
  let roleName: string;

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

  const message = (id: string, chat: string, text: string, from: string, type: string | null) =>
    db.prepare(
      "INSERT INTO chat_messages (id, chat_id, from_user_id, text, message_type, created_at) VALUES (?,?,?,?,?,datetime('now'))",
    ).run(id, chat, from, text, type);

  const search = (q: string) =>
    app.inject({
      method: "GET",
      url: `/api/chats/search?q=${encodeURIComponent(q)}`,
      headers: ownerAuth,
    });

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const owner = await reg("SearchOwner", "owner");
    ownerAuth = owner.auth;
    ownerId = owner.id;
    // Собеседник — уже посеянная роль: бизнес-роль живёт в users.role_key, а
    // users.role принимает только системные authority ('agent', 'owner', …).
    const seeded = db
      .prepare("SELECT id, name FROM users WHERE type = 'ai' AND COALESCE(archived,0) = 0 ORDER BY id LIMIT 1")
      .get() as { id: string; name: string };
    roleId = seeded.id;
    roleName = seeded.name;

    db.prepare(
      "INSERT INTO chats (id, title, kind, created_by, created_at, updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))",
    ).run(CHAT_A, "Договор с подрядчиком по аудиту", "group", ownerId);
    db.prepare(
      "INSERT INTO chats (id, title, kind, created_by, created_at, updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))",
    ).run(CHAT_B, "Рабочая комната поиска", "group", ownerId);
    for (const chat of [CHAT_A, CHAT_B]) {
      db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?,?)").run(chat, ownerId);
    }
    db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?,?)").run(CHAT_B, roleId);

    message("search-m1", CHAT_A, `Пришли счёт за ${HIT}`, ownerId, null);
    message("search-m2", CHAT_B, `Собрал отчёт по ${HIT}`, roleId, null);
    message("search-m3", CHAT_B, `служебная строка про ${HIT}`, "taskflow_system", "system");
  });

  afterAll(async () => {
    db.prepare("DELETE FROM chat_messages WHERE id IN ('search-m1','search-m2','search-m3')").run();
    for (const chat of [CHAT_A, CHAT_B]) {
      db.prepare("DELETE FROM chat_members WHERE chat_id = ?").run(chat);
      db.prepare("DELETE FROM chats WHERE id = ?").run(chat);
    }
    db.prepare("DELETE FROM users WHERE id = ?").run(ownerId);
    if (app) await app.close();
  });

  it("находит комнаты по тексту сообщения", async () => {
    const res = await search(HIT);
    expect(res.statusCode).toBe(200);
    const ids = res.json().results.map((r: any) => r.chat_id);
    expect(ids).toContain(CHAT_A);
    expect(ids).toContain(CHAT_B);
    const b = res.json().results.find((r: any) => r.chat_id === CHAT_B);
    expect(b.hit_text).toContain("Собрал отчёт");
  });

  it("служебные строки не выдают комнату: находится только живая переписка", async () => {
    const res = await search("служебная строка про");
    expect(res.json().results).toEqual([]);
  });

  it("находит по названию комнаты и по имени собеседника", async () => {
    const byTitle = await search("подрядчик по аудиту");
    expect(byTitle.json().results.map((r: any) => r.chat_id)).toEqual([CHAT_A]);
    const byMember = await search(roleName);
    expect(byMember.json().results.map((r: any) => r.chat_id)).toEqual([CHAT_B]);
  });

  it("кириллица в другом регистре и короткий запрос", async () => {
    const upper = await search("АРЕНДОВАННОЕ ПОМЕЩЕНИЕ");
    expect(upper.json().results.length).toBe(2);
    const short = await search("а");
    expect(short.json().results).toEqual([]);
  });
});
