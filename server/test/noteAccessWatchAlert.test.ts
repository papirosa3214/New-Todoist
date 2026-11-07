import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { purgeTasks } from "../src/lib/taskPurge.js";
import { __raiseWatchAlert, __resetWatchState } from "../src/lib/noteAccessWatcher.js";

// Тревога должна РЕАЛЬНО прилетать уведомлением о поломке — иначе
// сторож красивый, но бесполезный: молчал бы при сломанном приборе.
describe("тревога сторожа прилетает задачей", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  it("создаёт уведомление о поломке и скрытую карточку починки с внятной причиной", () => {
    __resetWatchState();
    purgeTasks((db.prepare("SELECT id FROM tasks WHERE incident_key = 'note-access-watch'").all() as any[]).map((r) => r.id));

    __raiseWatchAlert("чтение заметки не увеличило счётчик обращений");

    const t = db
      .prepare("SELECT id, title, description, project_id, status, service_hidden FROM tasks WHERE incident_key = 'note-access-watch'")
      .get() as any;
    expect(t, "задача-тревога должна быть создана").toBeTruthy();
    expect(t.title).toContain("Счётчик обращений");
    expect(t.title).toContain("не увеличило счётчик");
    expect(t.description).toContain("## Что делать");

    // Поломка — уведомление, а не задача в проекте (12.10.2026): карточка
    // починки без проекта и скрыта из списков.
    expect(t.project_id).toBeNull();
    expect(t.service_hidden).toBe(1);
    const n = db.prepare("SELECT type, text FROM notifications WHERE task_id = ?").get(t.id) as any;
    expect(n?.type).toBe("incident");
    expect(n?.text).toContain("Счётчик обращений");
    expect(t.status).toBe("active");

    purgeTasks((db.prepare("SELECT id FROM tasks WHERE incident_key = 'note-access-watch'").all() as any[]).map((r) => r.id));
  });

  it("не сыпет лавину: за сутки не больше одной тревоги", () => {
    __resetWatchState();
    purgeTasks((db.prepare("SELECT id FROM tasks WHERE incident_key = 'note-access-watch'").all() as any[]).map((r) => r.id));

    __raiseWatchAlert("первая поломка");
    __raiseWatchAlert("вторая поломка");
    __raiseWatchAlert("третья поломка");

    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE incident_key = 'note-access-watch'").get() as any
    ).n;
    expect(n, "повторные тревоги в пределах суток должны давиться").toBe(1);

    purgeTasks((db.prepare("SELECT id FROM tasks WHERE incident_key = 'note-access-watch'").all() as any[]).map((r) => r.id));
  });
});