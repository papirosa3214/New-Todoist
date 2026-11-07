import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { kbPendingCount } from "../src/lib/kbTriageWatcher.js";

// Замкнутость цепочки базы знаний. Без авто-метки её первого звена цепочка
// рвётся: заметки пишутся, метки не ставятся, триггер разбора видит ноль,
// категории не появляются, срез пуст. Все четыре шага есть — работать они
// будут только если связаны.
describe("цепочка базы знаний замкнута", () => {
  let app: FastifyInstance;
  let jwt = "";
  let taskId = "";
  let folderId = 0;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Владелец", email: "owner@kb-chain.test", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    jwt = (reg.json() as { token: string }).token;
    db.prepare("UPDATE users SET role='owner' WHERE email='owner@kb-chain.test'").run();
    db.prepare(
      "INSERT OR IGNORE INTO projects (id, name, owner_id, position, created_at) VALUES (?,?,?,0,datetime('now'))",
    ).run("c2fcbcdb-951f-449f-a1bd-123ea2a46a58", "TaskFlow - NewTodoist", "u1");
    db.prepare("INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type, created_at) VALUES (?,?,?,?,'owner','human',datetime('now'))")
      .run("u1", "Владелец", "owner@chain.test", "x");
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    db.prepare("DELETE FROM user_notes WHERE id LIKE 'ch-%'").run();
    taskId = `ch-task-${Date.now()}`;
    const f = db
      .prepare("INSERT INTO journal_folders (name, position) VALUES (?,0)")
      .run(`Папка ${taskId}`).lastInsertRowid;
    folderId = Number(f);
    db.prepare(
      "INSERT INTO tasks (id, title, status, creator_id, artifact_folder_id, created_at, updated_at) VALUES (?,?,?,?,?,datetime('now'),datetime('now'))",
    ).run(taskId, "Очередь сообщений роли", "active", "u1", folderId);
    db.prepare("UPDATE tasks SET artifact_folder_id = ? WHERE id = ?").run(folderId, taskId);
  });

  it("заметка в папке задачи сразу получает временную метку и источник", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/notes",
      headers: { authorization: `Bearer ${jwt}` },
      payload: { title: "Одноразовый отчёт о запуске", markdown: "Тест", folder_id: folderId },
    });
    expect(res.statusCode).toBe(200);
    const note = res.json() as any;
    expect(note.kb_temp_category, "метку ставит сервер, а не роль").toBeTruthy();
    expect(note.kb_temp_category).toContain("Очередь сообщений роли");
    expect(note.kb_source_task_id).toBe(taskId);
    expect(note.kb_category, "постоянную категорию ставит только Помощник владельца").toBeNull();
  });

  it("такая заметка попадает в счётчик разбора", async () => {
    await app.inject({
      method: "POST", url: "/api/notes",
      headers: { authorization: `Bearer ${jwt}` },
      payload: { title: "Ещё одна заметка", markdown: "Текст", folder_id: folderId },
    });
    expect(kbPendingCount(), "заметка обязана попасть в разбор").toBeGreaterThanOrEqual(1);
  });

  it("заметка вне папки задачи метку не получает — нечего разбирать", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/notes",
      headers: { authorization: `Bearer ${jwt}` },
      payload: { title: "Просто заметка", markdown: "Текст" },
    });
    expect(res.statusCode).toBe(200);
    const note = res.json() as any;
    expect(note.kb_temp_category).toBeNull();
  });
});