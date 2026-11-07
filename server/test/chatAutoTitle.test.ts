// Новый чат с ролью из панели «Комнаты» (владелец 26.10.2026): название
// придумывается по первому сообщению владельца, если его не задали.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { autoTitleFromText } from "../src/lib/chatRooms.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

describe("автоназвание нового чата", () => {
  let app: FastifyInstance;
  let auth: Record<string, string>;

  beforeAll(async () => {
    app = await buildApp();
    db.prepare(`INSERT OR IGNORE INTO users (id, name, role, role_key, type, email, password_hash, is_system_bot)
      VALUES ('role_builder', 'builder', 'agent', 'builder', 'ai', 'builder@autotitle-test', '!test', 1)`).run();
    const res = await app.inject({ method: "POST", url: "/api/auth/register",
      payload: { name: "TitleOwner", email: `t-${Date.now()}@test`, password: "password123" } });
    auth = { authorization: `Bearer ${res.json().token}` };
  });

  afterAll(async () => { if (app) await app.close(); });

  async function newChat(title?: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/chats", headers: auth,
      payload: { kind: "direct", member_ids: ["role_builder"], ...(title ? { title } : {}) } });
    expect(res.statusCode).toBe(200);
    return res.json().chat.id;
  }
  const send = (id: string, text: string) =>
    app.inject({ method: "POST", url: `/api/chats/${id}/messages`, headers: auth, payload: { text } });
  const titleOf = (id: string) => (db.prepare("SELECT title FROM chats WHERE id=?").get(id) as { title: string | null }).title;

  it("берёт первую строку первого сообщения и больше не меняет", async () => {
    const id = await newChat();
    expect((await send(id, "Разбери логи сервера за ночь\nи скажи, что упало")).statusCode).toBe(200);
    expect(titleOf(id)).toBe("Разбери логи сервера за ночь");
    await send(id, "Ещё вопрос");
    expect(titleOf(id)).toBe("Разбери логи сервера за ночь");
  });

  it("заданное вручную название не трогает", async () => {
    const id = await newChat("Мой чат");
    await send(id, "Привет");
    expect(titleOf(id)).toBe("Мой чат");
  });

  it("длинный текст режет по слову, разметку убирает", () => {
    expect(autoTitleFromText("## **Сделай** обзор `кода` модуля авторизации и проверь все обработчики ошибок на сервере"))
      .toBe("Сделай обзор кода модуля авторизации и проверь все…");
    expect(autoTitleFromText("   \n  ")).toBeNull();
  });
});
