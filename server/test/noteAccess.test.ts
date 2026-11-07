import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

// Учёт обращений к заметкам — измерительный прибор для схемы базы знаний:
// помечалку Помощника владельца проверяем фактом (10.10.2026, заметка cfa5cdcd).
describe("учёт обращений к заметкам", () => {
  let app: FastifyInstance;
  let jwt = "";
  let NOTE = "";

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Владелец теста", email: "owner@note-access.test", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    jwt = (reg.json() as { token: string }).token;
    db.prepare("UPDATE users SET role='owner' WHERE email='owner@note-access.test'").run();
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    NOTE = `na-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // id — TEXT, поэтому lastInsertRowid тут не годится: берём то, что задали.
    db.prepare(
      "INSERT INTO user_notes (id, title, content, created_at, updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))",
    ).run(NOTE, "Заметка для проверки обращений",
      JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }));
    db.prepare("DELETE FROM note_accesses WHERE note_id = ?").run(NOTE);
  });

  it("засчитывает обращение: счётчик растёт, в журнале появляется запись с автором", async () => {
    const before = (db.prepare("SELECT access_count AS n FROM user_notes WHERE id = ?").get(NOTE) as any).n;
    const res = await app.inject({
      method: "GET", url: `/api/notes/${NOTE}?format=markdown`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);

    const after = (db.prepare("SELECT access_count AS n, last_accessed_at AS at FROM user_notes WHERE id = ?").get(NOTE) as any);
    expect(after.n).toBe(before + 1);
    expect(after.at, "должна проставиться метка времени обращения").toBeTruthy();

    const rows = db
      .prepare("SELECT actor_id FROM note_accesses WHERE note_id = ?")
      .all(NOTE) as Array<{ actor_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].actor_id, "в журнале видно, КТО обращался").toBeTruthy();
  });

  it("повторные обращения накапливают, а не переписывают", async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "GET", url: `/api/notes/${NOTE}`,
        headers: { authorization: `Bearer ${jwt}` },
      });
    }
    const n = (db.prepare("SELECT access_count AS n FROM user_notes WHERE id = ?").get(NOTE) as any).n;
    expect(n).toBeGreaterThanOrEqual(3);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM note_accesses WHERE note_id = ?").get(NOTE) as any;
    expect(rows.n).toBeGreaterThanOrEqual(3);
  });

  it("чтение работает, даже если таблицы учёта недоступны", async () => {
    db.exec("DROP TABLE note_accesses");
    const res = await app.inject({
      method: "GET", url: `/api/notes/${NOTE}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode, "чтение заметки не должно падать из-за счётчика").toBe(200);
    expect(res.json().title).toBe("Заметка для проверки обращений");
    db.exec(`CREATE TABLE IF NOT EXISTS note_accesses (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  });
});