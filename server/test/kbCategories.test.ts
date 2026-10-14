import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { KB_CATEGORIES } from "../src/routes/notes.js";

// Категории — вход Помощника владельца-журналиста. Если он не может проставить
// категорию или может проставить что угодно, шаг 3 бессмыслен.
describe("категории базы знаний на заметках", () => {
  let app: FastifyInstance;
  let jwt = "";
  let NOTE = "";

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Владелец теста", email: "owner@kb-cat.test", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    jwt = (reg.json() as { token: string }).token;
    db.prepare("UPDATE users SET role='owner' WHERE email='owner@kb-cat.test'").run();
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    NOTE = `kc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    db.prepare(
      "INSERT INTO user_notes (id, title, content, created_at, updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))",
    ).run(NOTE, "Заметка под разбор",
      JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }));
  });

  it("принимает каждую из пяти категорий", async () => {
    expect(KB_CATEGORIES.length).toBeGreaterThanOrEqual(5);
    for (const c of ["Workflows", "Norms", "Roles", "Knowledge Base", "Исследования"]) {
      const res = await app.inject({
        method: "PATCH", url: `/api/notes/${NOTE}`,
        headers: { authorization: `Bearer ${jwt}` },
        payload: { kb_category: c },
      });
      expect(res.statusCode, `категория ${c} должна приниматься`).toBe(200);
      const row = db.prepare("SELECT kb_category AS c FROM user_notes WHERE id = ?").get(NOTE) as any;
      expect(row.c).toBe(c);
    }
  });

  it("отвергает чужое значение — в базу не должно попасть что попало", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/api/notes/${NOTE}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { kb_category: "мизер из подвала" },
    });
    expect(res.statusCode).toBe(400);
    const row = db.prepare("SELECT kb_category AS c FROM user_notes WHERE id = ?").get(NOTE) as any;
    expect(row.c).toBeNull();
  });

  it("разбор ставит временную метку, источник и разметку «кем»", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/api/notes/${NOTE}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        kb_temp_category: "Из задачи: Координация",
        kb_source_task_id: "f910062c-0000-0000-0000-000000000000",
      },
    });
    expect(res.statusCode).toBe(200);
    const row = db.prepare(
      "SELECT kb_temp_category AS t, kb_category AS c, kb_source_task_id AS s FROM user_notes WHERE id = ?",
    ).get(NOTE) as any;
    expect(row.t).toContain("Координация");
    expect(row.c, "постоянная категория должна остаться пустой").toBeNull();
    expect(row.s).toBe("f910062c-0000-0000-0000-000000000000");
  });

  it("снятие разбора обнуляет метку, а не выдумывает категорию", async () => {
    await app.inject({
      method: "PATCH", url: `/api/notes/${NOTE}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { kb_temp_category: "Из задачи: Координация" },
    });
    const res = await app.inject({
      method: "PATCH", url: `/api/notes/${NOTE}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { kb_temp_category: null },
    });
    expect(res.statusCode).toBe(200);
    const row = db.prepare("SELECT kb_temp_category AS t, kb_category AS c FROM user_notes WHERE id = ?").get(NOTE) as any;
    expect(row.t).toBeNull();
    expect(row.c).toBeNull();
  });
});