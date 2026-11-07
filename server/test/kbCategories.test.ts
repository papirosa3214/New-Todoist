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
  let OWNER = "";
  let AUTHOR = "";

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
    // Автор заметки — отдельный пользователь: updated_by указывает на
    // users.id, и подменить его ролью вслепую нельзя (FOREIGN KEY).
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Автор заметки", email: "author@kb-cat.test", password: "password123" },
    });
    OWNER = (db.prepare("SELECT id FROM users WHERE email='owner@kb-cat.test'").get() as any).id;
    AUTHOR = (db.prepare("SELECT id FROM users WHERE email='author@kb-cat.test'").get() as any).id;
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

  // Срез по роли собирается по автору и по дате правки. Если разбор забирает
  // себе и то и другое, витрина знаний уезжает от ролей, которые эти заметки
  // создали, — и починить это через API уже нельзя.
  it("разметка категории не переписывает автора и дату правки заметки", async () => {
    db.prepare(
      "UPDATE user_notes SET updated_by = ?, updated_at = ? WHERE id = ?",
    ).run(AUTHOR, "2026-01-01 00:00:00", NOTE);

    const res = await app.inject({
      method: "PATCH", url: `/api/notes/${NOTE}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { kb_category: "Knowledge Base" },
    });
    expect(res.statusCode).toBe(200);
    const row = db.prepare(
      "SELECT kb_category AS c, updated_by AS u, updated_at AS t FROM user_notes WHERE id = ?",
    ).get(NOTE) as any;
    expect(row.c).toBe("Knowledge Base");
    expect(row.u, "автор заметки должен остаться автором").toBe(AUTHOR);
    expect(row.t, "дата правки текста должна остаться прежней").toBe("2026-01-01 00:00:00");
  });

  it("обычная правка заметки автора и дату переписывает — как и раньше", async () => {
    db.prepare(
      "UPDATE user_notes SET updated_by = ?, updated_at = ? WHERE id = ?",
    ).run(AUTHOR, "2026-01-01 00:00:00", NOTE);

    const res = await app.inject({
      method: "PATCH", url: `/api/notes/${NOTE}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { markdown: "Новый текст заметки" },
    });
    expect(res.statusCode).toBe(200);
    const row = db.prepare(
      "SELECT updated_by AS u, updated_at AS t FROM user_notes WHERE id = ?",
    ).get(NOTE) as any;
    expect(row.u, "правку текста пишет тот, кто её сделал").toBe(OWNER);
    expect(row.t).not.toBe("2026-01-01 00:00:00");
  });
});