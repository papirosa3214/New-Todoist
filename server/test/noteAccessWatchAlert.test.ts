import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { __raiseWatchAlert, __resetWatchState } from "../src/lib/noteAccessWatcher.js";

// Тревога должна РЕАЛЬНО прилетать в «Серверные уведомления» — иначе
// сторож красивый, но бесполезный: молчал бы при сломанном приборе.
describe("тревога сторожа прилетает задачей", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  it("создаёт задачу в проекте «Серверные уведомления» с внятной причиной", () => {
    __resetWatchState();
    db.prepare("DELETE FROM tasks WHERE id LIKE 'note-access-watch-%'").run();

    __raiseWatchAlert("чтение заметки не увеличило счётчик обращений");

    const t = db
      .prepare("SELECT title, description, project_id, status FROM tasks WHERE id LIKE 'note-access-watch-%'")
      .get() as any;
    expect(t, "задача-тревога должна быть создана").toBeTruthy();
    expect(t.title).toContain("Счётчик обращений");
    expect(t.title).toContain("не увеличило счётчик");
    expect(t.description).toContain("## Что делать");

    const p = db.prepare("SELECT name FROM projects WHERE id = ?").get(t.project_id) as any;
    expect(p?.name).toBe("Серверные уведомления");
    expect(t.status).toBe("active");

    db.prepare("DELETE FROM tasks WHERE id LIKE 'note-access-watch-%'").run();
  });

  it("не сыпет лавину: за сутки не больше одной тревоги", () => {
    __resetWatchState();
    db.prepare("DELETE FROM tasks WHERE id LIKE 'note-access-watch-%'").run();

    __raiseWatchAlert("первая поломка");
    __raiseWatchAlert("вторая поломка");
    __raiseWatchAlert("третья поломка");

    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id LIKE 'note-access-watch-%'").get() as any
    ).n;
    expect(n, "повторные тревоги в пределах суток должны давиться").toBe(1);

    db.prepare("DELETE FROM tasks WHERE id LIKE 'note-access-watch-%'").run();
  });
});