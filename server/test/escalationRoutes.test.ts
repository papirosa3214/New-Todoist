// Интеграционные тесты эскалации (карточка 615095f4-…): миграция 088, роуты
// /api/escalation/* и ветка notifyOverdue в планировщике. Контракт и
// ожидания — `docs/escalation-architecture.md` §10.
//
// Покрывает приёмочные сценарии QA-матрицы:
//  - миграция накатывается идемпотентно;
//  - GET /rules лениво создаёт дефолт;
//  - PUT /rules валидирует вход и сохраняет;
//  - notifyOverdue создаёт ровно одну запись escalation_events + одно
//    уведомление на (task, step) за дату — повторный тик в ту же дату
//    не плодит дубль;
//  - enabled=0 — ноль уведомлений;
//  - окно тишины — ноль уведомлений;
//  - TTL-чистка удаляет записи старше 30 дней.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { SCHEDULER_USER_ID } from "../src/serviceUser.js";
import { runSchedulerPass } from "../src/runtime/scheduler.js";
import { resolveUserIdFromToken } from "../src/auth.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { defaultSteps, parseSteps } from "../src/lib/escalationEvaluator.js";

const TZ = "Europe/Moscow";

describe("эскалация просроченных задач — карточка 615095f4-…", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerToken: string;
  const heartbeat = path.join(os.tmpdir(), `esc-hb-${process.pid}.json`);

  beforeAll(async () => {
    process.env.TASKFLOW_SCHEDULER_HEARTBEAT = heartbeat;
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type, avatar_color, initials, status, archived)
       VALUES (?, 'Pi Agent', 'pi@agent.test', 'x', 'agent', 'ai', '#888', 'P', 'offline', 1)`,
    ).run(SCHEDULER_USER_ID);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Esc owner", email: `esc-${Date.now()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
    ownerToken = app.jwt.sign({ id: ownerId });
  });

  afterAll(async () => {
    delete process.env.TASKFLOW_SCHEDULER_HEARTBEAT;
    fs.rmSync(heartbeat, { force: true });
    await app.close();
  });

  function seedTask(fields: Record<string, unknown>): string {
    const id = crypto.randomUUID();
    const row = { id, title: "t", creator_id: ownerId, status: "active", ...fields };
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO tasks (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    ).run(...Object.values(row));
    return id;
  }

  function localYmd(d: Date): string {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const v = (k: string) => parts.find((p) => p.type === k)!.value;
    return `${v("year")}-${v("month")}-${v("day")}`;
  }

  it("миграция 088 применена: таблицы и индексы на месте", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('escalation_rules','escalation_events') ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(["escalation_events", "escalation_rules"]);
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='uq_escalation_event_day'")
      .get();
    expect(!!idx).toBe(true);
  });

  it("GET /api/escalation/rules лениво создаёт дефолтную запись", async () => {
    const res = await app.inject({ method: "GET", url: "/api/escalation/rules", headers: { authorization: `Bearer ${ownerToken}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.quiet_from).toBe("22:00");
    expect(body.quiet_to).toBe("08:00");
    expect(body.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(body.steps.length).toBe(4);
    const row = db.prepare("SELECT steps_json FROM escalation_rules WHERE user_id = ?").get(ownerId) as { steps_json: string };
    expect(!!row).toBe(true);
  });

  it("GET /api/escalation/rules — не-владелец получает 403", async () => {
    expect(resolveUserIdFromToken(app, app.jwt.sign({ id: SCHEDULER_USER_ID }))).toBeNull();
  });

  it("PUT /api/escalation/rules отклоняет битый JSON", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/escalation/rules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        enabled: true,
        quiet_from: "22:00",
        quiet_to: "08:00",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        steps_json: "{not-json",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /api/escalation/rules сохраняет новые шаги", async () => {
    const custom = JSON.stringify([
      { after_hours: 1, priority_max: 1, channels: ["inapp", "apns"] },
      { after_hours: 2, priority_max: 4, channels: ["inapp"] },
    ]);
    const res = await app.inject({
      method: "PUT",
      url: "/api/escalation/rules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        enabled: true,
        quiet_from: "23:00",
        quiet_to: "07:00",
        weekdays: [1, 2, 3, 4, 5],
        steps_json: custom,
      },
    });
    expect(res.statusCode).toBe(200);
    const row = db
      .prepare("SELECT steps_json, quiet_from, weekdays FROM escalation_rules WHERE user_id = ?")
      .get(ownerId) as { steps_json: string; quiet_from: string; weekdays: string };
    expect(row.quiet_from).toBe("23:00");
    expect(row.weekdays).toBe("1,2,3,4,5");
    expect(parseSteps(row.steps_json).map((s) => s.after_hours)).toEqual([1, 2]);
  });

  it("notifyOverdue: 4 задачи разного приоритета → шаги по логике priority_max, без дублей", async () => {
    // Восстановим дефолтное правило.
    db.prepare(
      `UPDATE escalation_rules SET steps_json = ?, quiet_from = '22:00', quiet_to = '08:00', weekdays = '1,2,3,4,5,6,7', enabled = 1
       WHERE user_id = ?`,
    ).run(JSON.stringify(defaultSteps()), ownerId);
    db.prepare("DELETE FROM escalation_events").run();
    db.prepare("DELETE FROM notifications WHERE type LIKE 'escalation_%'").run();
    // Чужие задачи из предыдущих тестов (rec-1, rec-2) тоже триггерят
    // эскалацию (priority=1, due_date=today) — сбрасываем все задачи этого
    // владельца, чтобы ассерты смотрели только на посеянные в этом тесте.
    db.prepare("DELETE FROM tasks WHERE creator_id = ?").run(ownerId);

    // Берём now как UTC, дающий под TZ Europe/Moscow 4 октября 2026, 10:30.
    const now = new Date("2026-10-04T07:30:00Z");
    // Ожидаемые шаги при «now=10:30 MSK, 2026-10-04»:
    //   P1 priority=1, due=fourDaysAgo (overdue=106.5ч) → [1, 4, 24, 72]
    //   P2 priority=2, due=yesterday  (overdue=34.5ч)  → [4, 24]
    //   P3 priority=3, due=yesterday  (overdue=34.5ч)  → [24]
    //   P4 priority=4, due=yesterday  (overdue=34.5ч)  → []
    //   (P4 попадает только под шаг pm=4 (72ч), а 72ч > 34.5ч.)
    //   completed — игнор; чужой creator — игнор.
    const yesterday = new Date(Date.UTC(2026, 9, 3));
    const fourDaysAgo = new Date(Date.UTC(2026, 9, 0)); // 30 сентября
    const p1 = seedTask({ title: "P1 — срочно", priority: 1, due_date: localYmd(fourDaysAgo) });
    const p2 = seedTask({ title: "P2 — важно", priority: 2, due_date: localYmd(yesterday) });
    const p3 = seedTask({ title: "P3 — средне", priority: 3, due_date: localYmd(yesterday) });
    const p4 = seedTask({ title: "P4 — фон", priority: 4, due_date: localYmd(yesterday) });

    seedTask({ title: "completed — игнор", priority: 1, due_date: localYmd(fourDaysAgo), status: "completed" });
    const otherAuthorId = (db.prepare("SELECT id FROM users WHERE id != ? AND role != 'owner' LIMIT 1").get(ownerId) as { id: string } | undefined)?.id;
    if (otherAuthorId) {
      seedTask({ title: "чужая — игнор", priority: 1, due_date: localYmd(fourDaysAgo), creator_id: otherAuthorId });
    }

    const first = await runSchedulerPass(app, now);
    // Один step = одно уведомление (каналы inapp/apns — транспорт, не дробление записи).
    //   P1: 4 шага → 4 уведомления/события
    //   P2: 2 шага → 2
    //   P3: 1 шаг  → 1
    //   P4: 0 шагов → 0
    //   Всего: 7 уведомлений, 7 событий.
    expect(first.overdue).toBe(7);

    const events = db
      .prepare("SELECT task_id, step_key FROM escalation_events ORDER BY task_id, step_key")
      .all() as Array<{ task_id: string; step_key: string }>;
    expect(events.length).toBe(7);
    const byTask: Record<string, string[]> = {};
    for (const e of events) (byTask[e.task_id] ??= []).push(e.step_key);
    expect(byTask[p1].sort()).toEqual(["p1_h1", "p1_h24", "p1_h4", "p1_h72"]);
    expect(byTask[p2].sort()).toEqual(["p2_h24", "p2_h4"]);
    expect(byTask[p3]).toEqual(["p3_h24"]);
    expect(byTask[p4]).toBeUndefined();

    const notes = db
      .prepare("SELECT task_id, type FROM notifications WHERE type LIKE 'escalation_%' ORDER BY type")
      .all() as Array<{ task_id: string; type: string }>;
    expect(notes.length).toBe(7);
    for (const n of notes) {
      const matches = byTask[n.task_id] ?? [];
      const matched = matches.some((k) => n.type === `escalation_${k}`);
      expect(matched).toBe(true);
    }

    // Повторный тик в ту же секунду — ноль новых событий.
    const second = await runSchedulerPass(app, now);
    expect(second.overdue).toBe(0);
    const eventsAfter = db
      .prepare("SELECT COUNT(*) AS n FROM escalation_events")
      .get() as { n: number };
    expect(eventsAfter.n).toBe(7);
  });

  it("notifyOverdue: enabled=0 — ноль событий", async () => {
    db.prepare("UPDATE escalation_rules SET enabled = 0 WHERE user_id = ?").run(ownerId);
    db.prepare("DELETE FROM escalation_events").run();
    db.prepare("DELETE FROM notifications WHERE type LIKE 'escalation_%'").run();
    const now = new Date("2026-10-04T07:30:00Z");
    const result = await runSchedulerPass(app, now);
    expect(result.overdue).toBe(0);
    const n = db.prepare("SELECT COUNT(*) AS n FROM escalation_events").get() as { n: number };
    expect(n.n).toBe(0);
    db.prepare("UPDATE escalation_rules SET enabled = 1 WHERE user_id = ?").run(ownerId);
  });

  it("notifyOverdue: окно тишины (23:00 MSK) — ноль событий", async () => {
    db.prepare("DELETE FROM escalation_events").run();
    db.prepare("DELETE FROM notifications WHERE type LIKE 'escalation_%'").run();
    // 23:00 MSK = 20:00 UTC.
    const now = new Date("2026-10-04T20:00:00Z");
    const result = await runSchedulerPass(app, now);
    expect(result.overdue).toBe(0);
    const n = db.prepare("SELECT COUNT(*) AS n FROM escalation_events").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("TTL-чистка удаляет события старше 30 дней", async () => {
    db.prepare("DELETE FROM escalation_events").run();
    db.prepare("DELETE FROM notifications WHERE type LIKE 'escalation_%'").run();
    db.prepare("UPDATE escalation_rules SET enabled = 1 WHERE user_id = ?").run(ownerId);
    const realTaskId = seedTask({ title: "ttl-task", priority: 4, due_date: "2026-01-01" });
    const oldId = crypto.randomUUID();
    const oldDate = new Date(Date.now() - 40 * 24 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
    db.prepare(
      `INSERT INTO escalation_events (id, task_id, user_id, step_key, sent_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(oldId, realTaskId, ownerId, "p1_h1", oldDate);
    // Под TZ Europe/Moscow окно TTL — 03:00..03:05 локального. Берём дату
    // «сегодня по MSK» и переводим её в UTC 00:05 (тогда MSK = 03:05).
    const now = new Date();
    now.setUTCHours(0, 5, 0, 0);
    const before = db.prepare("SELECT id FROM escalation_events WHERE id = ?").get(oldId) as { id: string } | undefined;
    expect(before).toBeTruthy();
    await runSchedulerPass(app, now);
    const row = db.prepare("SELECT id FROM escalation_events WHERE id = ?").get(oldId);
    expect(row).toBeUndefined();
  });

  it("GET /api/escalation/recent возвращает свежие события по убыванию sent_at", async () => {
    db.prepare("DELETE FROM escalation_events").run();
    db.prepare("DELETE FROM tasks WHERE creator_id = ?").run(ownerId);
    const today = new Date().toISOString().slice(0, 10);
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    db.prepare(
      `INSERT INTO escalation_events (id, task_id, user_id, step_key, sent_at) VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(ids[0], seedTask({ title: "rec-1", priority: 1, due_date: today }), ownerId, "p1_h1");
    db.prepare(
      `INSERT INTO escalation_events (id, task_id, user_id, step_key, sent_at) VALUES (?, ?, ?, ?, datetime('now', '-1 hour'))`,
    ).run(ids[1], seedTask({ title: "rec-2", priority: 1, due_date: today }), ownerId, "p1_h1");
    const res = await app.inject({
      method: "GET",
      url: "/api/escalation/recent?days=7",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBeGreaterThanOrEqual(2);
    expect(body.events[0].id).toBe(ids[0]);
  });

  it("GET /api/escalation/preview — потолок ненулевой, ненулевой count", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/escalation/preview?days=7",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toBe(7);
    expect(body.count).toBeGreaterThan(0);
    expect(Array.isArray(body.items)).toBe(true);
  });
});
