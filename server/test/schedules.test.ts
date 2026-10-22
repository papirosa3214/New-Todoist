// Рутины (крон-задачи): расчёт следующего запуска и идемпотентность.
//
// Модуль runtime/schedules/ (вариант B из заметки «Рутины и расписание
// TaskFlow»): правила вынесены отдельно от общего планировщика, у них
// свои тесты.
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Роль в тестах не поднимаем: живой запуск ушёл бы в модель (и в сеть).
// Ловим сам факт запуска — этого достаточно, чтобы проверить ветку.
const launched = vi.hoisted(() => [] as Array<{ taskId: string; role: string }>);
vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return {
    ...actual,
    runRoleInProcess: async (input: { taskId: string; role: string }) => {
      launched.push({ taskId: input.taskId, role: input.role });
      return { runId: "test-run", completion: Promise.resolve() };
    },
  };
});
import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { resolveUserIdFromToken } from "../src/auth.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import {
  decideRun,
  nextRunAfter,
  parseIntervalMinutes,
  parseTimeLocal,
  parseWeekdays,
  zonedParts,
  zonedToUtc,
  type ScheduleRule,
} from "../src/runtime/schedules/rules.js";
import {
  createSchedule,
  getSchedule,
  listRuns,
  listSchedules,
  markScheduleRun,
  parseUtc,
} from "../src/runtime/schedules/store.js";
import { runSchedulesTick } from "../src/runtime/schedules/tick.js";

const MSK = "Europe/Moscow";

function rule(over: Partial<ScheduleRule> = {}): ScheduleRule {
  return {
    kind: "daily",
    expr: null,
    timeLocal: "09:00",
    timezone: MSK,
    anchor: { year: 2026, month: 10, day: 22 },
    ...over,
  };
}

describe("расчёт следующего запуска рутины", () => {
  it("ежедневно — следующая дата в зоне рутины", () => {
    // 22.10.2026 (четверг) 07:00 МСК → ближайшие 09:00 того же дня.
    const from = new Date("2026-10-22T04:00:00.000Z");
    const next = nextRunAfter(rule(), from)!;
    expect(next.toISOString()).toBe("2026-10-22T06:00:00.000Z");
  });

  it("после времени запуска — следующий день", () => {
    const from = new Date("2026-10-22T07:00:00.000Z"); // 10:00 МСК
    const next = nextRunAfter(rule(), from)!;
    expect(next.toISOString()).toBe("2026-10-23T06:00:00.000Z");
  });

  it("будни — пятница переходит на понедельник", () => {
    const from = new Date("2026-10-23T07:00:00.000Z"); // пятница 10:00
    const next = nextRunAfter(rule({ kind: "weekdays" }), from)!;
    expect(next.toISOString()).toBe("2026-10-26T06:00:00.000Z");
  });

  it("конкретные дни недели — 1,3,5", () => {
    const days = parseWeekdays("1,3,5")!;
    expect([...days].sort()).toEqual([1, 3, 5]);
    // Понедельник 26.10 07:00 МСК → тот же понедельник в 09:00.
    const from = new Date("2026-10-26T04:00:00.000Z");
    const next = nextRunAfter(rule({ kind: "weekly_days", expr: "1,3,5" }), from)!;
    expect(next.toISOString()).toBe("2026-10-26T06:00:00.000Z");
    // Вторник → среда.
    const fromTue = new Date("2026-10-27T04:00:00.000Z");
    const nextWed = nextRunAfter(rule({ kind: "weekly_days", expr: "1,3,5" }), fromTue)!;
    expect(nextWed.toISOString()).toBe("2026-10-28T06:00:00.000Z");
  });

  it("раз в неделю — якорь задаёт день", () => {
    // Якорь — четверг (22.10), значит ближайший четверг 29.10.
    const from = new Date("2026-10-22T07:00:00.000Z");
    const next = nextRunAfter(rule({ kind: "weekly" }), from)!;
    expect(next.toISOString()).toBe("2026-10-29T06:00:00.000Z");
  });

  it("раз в месяц — тот же день месяца", () => {
    const from = new Date("2026-10-22T07:00:00.000Z");
    const next = nextRunAfter(
      rule({ kind: "monthly", anchor: { year: 2026, month: 10, day: 22 } }),
      from,
    )!;
    expect(next.toISOString()).toBe("2026-11-22T06:00:00.000Z");
  });

  it("интервал — от базы, минимальный 5 минут", () => {
    expect(parseIntervalMinutes("15m")).toBe(15);
    expect(parseIntervalMinutes("2h")).toBe(120);
    expect(parseIntervalMinutes("1m")).toBeNull();
    const from = new Date("2026-10-22T06:00:00.000Z");
    const next = nextRunAfter(rule({ kind: "interval", expr: "15m" }), from)!;
    expect(next.toISOString()).toBe("2026-10-22T06:15:00.000Z");
  });

  it("зона рутины уважается: смена зоны не ломает расчёт", () => {
    // 09:00 по Нью-Йорку — это 16:00 МСК зимой (UTC-5).
    const ny = rule({ timezone: "America/New_York" });
    const from = new Date("2026-10-22T00:00:00.000Z");
    const next = nextRunAfter(ny, from)!;
    const parts = zonedParts(next, "America/New_York");
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(0);
    // Обратный перевод даёт тот же момент.
    expect(zonedToUtc(parts, "America/New_York").getTime()).toBe(next.getTime());
  });

  it("время и дни недели валидируются", () => {
    expect(parseTimeLocal("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeLocal("9:0")).toBeNull();
    expect(parseTimeLocal("24:00")).toBeNull();
    expect(parseWeekdays("1,3,9")).toBeNull();
  });
});

describe("решение по наступившему запуску", () => {
  const next = new Date("2026-10-22T06:00:00.000Z");

  it("не наступил — ждём", () => {
    const d = decideRun({ now: new Date("2026-10-22T05:00:00.000Z"), nextRunAt: next, catchUp: true, overlapOpen: false });
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("ещё не время");
  });

  it("наступил — запускаем", () => {
    const d = decideRun({ now: new Date("2026-10-22T06:01:00.000Z"), nextRunAt: next, catchUp: true, overlapOpen: false });
    expect(d.action).toBe("run");
    expect(d.runAt.toISOString()).toBe(next.toISOString());
  });

  it("просрочено больше суток — не догоняем", () => {
    const d = decideRun({ now: new Date("2026-10-24T06:00:00.000Z"), nextRunAt: next, catchUp: true, overlapOpen: false });
    expect(d.action).toBe("skip");
    expect(d.reason).toContain("окна догона");
  });

  it("догон в пределах суток — догоняем один запуск", () => {
    const d = decideRun({ now: new Date("2026-10-23T05:00:00.000Z"), nextRunAt: next, catchUp: true, overlapOpen: false });
    expect(d.action).toBe("run");
  });

  it("прошлый экземпляр не закрыт — новый запуск не создаём", () => {
    const d = decideRun({ now: new Date("2026-10-22T06:01:00.000Z"), nextRunAt: next, catchUp: true, overlapOpen: true });
    expect(d.action).toBe("skip");
    expect(d.reason).toContain("не закрыт");
  });
});

describe("рутины в базе и тик планировщика", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    // Владелец — зарегистрированный в тесте: u1 понижен хелпером, чтобы
    // его владельцем был тот, кого мы завели сами.
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Schedules owner",
        email: `schedules-${Date.now()}@test`,
        password: "password123",
      },
    });
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
    ownerToken = app.jwt.sign({ id: ownerId }, { expiresIn: "5m" });
  });

  afterAll(async () => {
    await app.close();
  });

  function createDaily(over: { nextRunAt?: Date; payload?: Record<string, unknown> } = {}) {
    const created = createSchedule({
      title: "Ежедневная проверка",
      taskPayload: { title: "Проверить бэкапы", ...(over.payload ?? {}) } as never,
      rule: rule(),
      nextRunAt: over.nextRunAt ?? new Date(Date.now() - 60_000),
      catchUp: true,
      overlapPolicy: "skip",
      createdBy: ownerId,
    });
    return created;
  }

  it("миграция завела таблицы рутин", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('task_schedules','schedule_runs')")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(["schedule_runs", "task_schedules"]);
  });

  it("POST /api/schedules создаёт рутину и считает следующий запуск", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        title: "Утренний отчёт",
        rule_kind: "daily",
        time_local: "08:30",
        task_payload: { title: "Собрать отчёт", assignee_id: "builder" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.schedule.next_run_at).toBeTruthy();
    expect(body.schedule.timezone).toBe(MSK);
  });

  it("GET /api/schedules отдаёт список с правилом и следующим запуском", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.schedules)).toBe(true);
    expect(body.schedules[0]).toHaveProperty("rule_kind");
    expect(body.schedules[0]).toHaveProperty("next_run_at");
  });

  it("тик создаёт карточку из шаблона и поднимает роль", async () => {
    const schedule = createDaily({ payload: { assignee_id: "builder" } });
    const counts = await runSchedulesTick(app, { now: new Date() });
    expect(counts.created).toBeGreaterThanOrEqual(1);
    const runs = listRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const task = db
      .prepare("SELECT id, title, assignee_id FROM tasks WHERE id = ?")
      .get(runs[0].task_id ?? "") as { id: string; title: string; assignee_id: string | null } | undefined;
    expect(task?.title).toBe("Проверить бэкапы");
    // Роль поднялась на новой карточке.
    expect(launched.some((l) => l.taskId === runs[0].task_id && l.role === "builder")).toBe(true);
  });

  it("второй проход в то же окно не создаёт вторую карточку", async () => {
    const schedule = createDaily({ payload: { assignee_id: "builder" } });
    const before = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    await runSchedulesTick(app, { now: new Date() });
    const afterFirst = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    expect(afterFirst).toBeGreaterThan(before);
    // Тот же момент запуска — второй проход не должен ничего создать.
    await runSchedulesTick(app, { now: new Date() });
    const afterSecond = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    expect(afterSecond).toBe(afterFirst);
    const runs = listRuns(schedule.id);
    const created = runs.filter((r) => r.status === "created");
    expect(created.length).toBe(1);
  });

  it("пока прошлый экземпляр не закрыт, новый запуск не создаётся", async () => {
    const schedule = createDaily({ payload: { assignee_id: "builder" } });
    await runSchedulesTick(app, { now: new Date() });
    const open = getSchedule(schedule.id)!;
    expect(open.current_task_id).toBeTruthy();
    const tasksBefore = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    // Следующий слот — через час: рутина «попала» на открытый экземпляр.
    markScheduleRun(schedule.id, { nextRunAt: new Date(Date.now() - 1000) });
    const counts = await runSchedulesTick(app, { now: new Date() });
    const tasksAfter = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    expect(tasksAfter).toBe(tasksBefore);
    expect(counts.skipped).toBeGreaterThanOrEqual(1);
  });

  it("история запусков переживает перезапуск сервера (лежит в БД)", async () => {
    const schedule = createDaily({ payload: { assignee_id: "builder" } });
    await runSchedulesTick(app, { now: new Date() });
    const runs = listRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    // Читаем из другой «сессии» — запись в БД, не в памяти.
    const reread = db
      .prepare("SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = ?")
      .get(schedule.id) as { n: number };
    expect(reread.n).toBe(runs.length);
  });

  it("удаление рутины не трогает уже созданные карточки", async () => {
    const schedule = createDaily({ payload: { assignee_id: "builder" } });
    await runSchedulesTick(app, { now: new Date() });
    const run = listRuns(schedule.id)[0];
    const taskId = run.task_id!;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/schedules/${schedule.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
    expect(task).toBeTruthy();
    expect(listSchedules().some((s) => s.id === schedule.id)).toBe(false);
  });

  it("пауза останавливает рутину", async () => {
    const schedule = createDaily({ payload: { assignee_id: "builder" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/schedules/${schedule.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "paused" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedule.status).toBe("paused");
    const tasksBefore = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    const counts = await runSchedulesTick(app, { now: new Date() });
    const tasksAfter = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    expect(tasksAfter).toBe(tasksBefore);
    expect(counts.created).toBe(0);
  });

  it("ручной запуск вне расписания не съедает слот расписания", async () => {
    const schedule = createDaily({ payload: { assignee_id: "builder" } });
    const nextBefore = getSchedule(schedule.id)!.next_run_at;
    const res = await app.inject({
      method: "POST",
      url: `/api/schedules/${schedule.id}/run-now`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.created).toBe(1);
    expect(getSchedule(schedule.id)!.next_run_at).toBe(nextBefore);
  });
});
