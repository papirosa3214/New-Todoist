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
  anchorForNow,
  decideRun,
  nextRunAfter,
  parseCron,
  parseIntervalMinutes,
  parseTimeLocal,
  parseWeekdays,
  ruleLabel,
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

  it("месяц с 28/29/30/31 днём: «раз в месяц» не теряет 31-е", () => {
    // Якорь — 31-е число. В коротком месяце дата сдвигается на последний
    // день месяца, дальше снова идёт по 31-му.
    const monthly = () => rule({ kind: "monthly", anchor: { year: 2026, month: 1, day: 31 } });
    // 31.01.2026 12:00 МСК → 28.02.2026 09:00 (февраль 2026 — 28 дней).
    const afterJan = nextRunAfter(monthly(), new Date("2026-01-31T09:00:00.000Z"))!;
    expect(afterJan.toISOString()).toBe("2026-02-28T06:00:00.000Z");
    // 28.02.2026 12:00 МСК → 31.03.2026 09:00.
    const afterFeb = nextRunAfter(monthly(), new Date("2026-02-28T09:00:00.000Z"))!;
    expect(afterFeb.toISOString()).toBe("2026-03-31T06:00:00.000Z");
    // 30.04.2026 12:00 МСК → 31.05.2026 09:00 (апрель — 30 дней).
    const afterApr = nextRunAfter(monthly(), new Date("2026-04-30T09:00:00.000Z"))!;
    expect(afterApr.toISOString()).toBe("2026-05-31T06:00:00.000Z");
    // Високосный год: 29 февраля существует (2028) — запуск в этот день.
    const leap = rule({ kind: "monthly", anchor: { year: 2028, month: 1, day: 29 } });
    const leapNext = nextRunAfter(leap, new Date("2028-01-29T09:00:00.000Z"))!;
    expect(leapNext.toISOString()).toBe("2028-02-29T06:00:00.000Z");
  });

  it("cron: разбор выражения и ближайший запуск", () => {
    expect(parseCron("0 9 * * 1-5")).toBeTruthy();
    expect(parseCron("*/15 * * * *")).toBeTruthy();
    expect(parseCron("0 9 * *")).toBeNull();
    expect(parseCron("60 9 * * *")).toBeNull();
    // По будням в 09:00 МСК: пятница 23.10 12:00 → понедельник 26.10 09:00.
    const from = new Date("2026-10-23T09:00:00.000Z");
    const next = nextRunAfter(rule({ kind: "cron", expr: "0 9 * * 1-5" }), from)!;
    expect(next.toISOString()).toBe("2026-10-26T06:00:00.000Z");
    // Каждые 15 минут — от базы.
    const step = nextRunAfter(rule({ kind: "cron", expr: "*/15 * * * *" }), from)!;
    expect(step.toISOString()).toBe("2026-10-23T09:15:00.000Z");
  });

  it("подпись правила приходит по-русски и одинаково для веба и iOS", () => {
    expect(ruleLabel({ kind: "weekdays" })).toBe("По будням");
    expect(ruleLabel({ kind: "daily" })).toBe("Ежедневно");
    expect(ruleLabel({ kind: "interval", expr: "15m" })).toBe("Каждые 15 минут");
    expect(ruleLabel({ kind: "interval", expr: "2h" })).toBe("Каждые 2 часа");
    expect(ruleLabel({ kind: "weekly_days", expr: "1,5" })).toBe("По дням: Пн, Пт");
  });

  it("еженедельно: явный день недели важнее якоря", () => {
    // Якорь правила — четверг 22.10.2026, а правило просит понедельник.
    const next = nextRunAfter(rule({ kind: "weekly", expr: "1" }), new Date("2026-10-22T06:00:00.000Z"))!;
    expect(next.toISOString()).toBe("2026-10-26T06:00:00.000Z");
    // Без явного дня — по якорю (четверг), как раньше.
    const byAnchor = nextRunAfter(rule({ kind: "weekly" }), new Date("2026-10-22T06:00:00.000Z"))!;
    expect(byAnchor.toISOString()).toBe("2026-10-29T06:00:00.000Z");
  });

  it("ежемесячно: явный день месяца важнее якоря", () => {
    const next = nextRunAfter(rule({ kind: "monthly", expr: "15" }), new Date("2026-10-22T06:00:00.000Z"))!;
    expect(next.toISOString()).toBe("2026-11-15T06:00:00.000Z");
  });

  it("подпись правила с днём: еженедельно и ежемесячно", () => {
    expect(ruleLabel({ kind: "weekly", expr: "1" })).toBe("Еженедельно: понедельник");
    expect(ruleLabel({ kind: "weekly", expr: "6" })).toBe("Еженедельно: суббота");
    expect(ruleLabel({ kind: "monthly", expr: "15" })).toBe("Ежемесячно: 15-е число");
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
    // Ручной запуск отдаёт ссылку на созданную карточку (веб показывает её).
    expect(res.json().run?.task_id).toBeTruthy();
  });

  it("список отдаёт подпись правила и ссылку на текущий экземпляр", async () => {
    const schedule = createDaily({ payload: { assignee_id: "builder" } });
    await runSchedulesTick(app, { now: new Date() });
    const res = await app.inject({
      method: "GET",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const row = res.json().schedules.find((s: { id: string }) => s.id === schedule.id);
    expect(row.rule_label).toBe("Ежедневно");
    // current_task_id — чтобы веб и iOS показали «прошлый запуск не закрыт».
    expect(row.current_task_id).toBeTruthy();
  });

  it("интервал меньше 5 минут отклоняется на входе", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        title: "Слишком часто",
        rule_kind: "interval",
        rule_expr: "1m",
        task_payload: { title: "Слишком часто" },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("неверный день недели или месяца отклоняется на входе", async () => {
    const week = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        title: "Неделя",
        rule_kind: "weekly",
        rule_expr: "9",
        task_payload: { title: "Неделя" },
      },
    });
    expect(week.statusCode).toBe(400);
    const month = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        title: "Месяц",
        rule_kind: "monthly",
        rule_expr: "32",
        task_payload: { title: "Месяц" },
      },
    });
    expect(month.statusCode).toBe(400);
  });

  it("рутина с явным днём недели: следующий запуск в этот день, подпись с днём", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        title: "Понедельный отчёт",
        rule_kind: "weekly",
        rule_expr: "1",
        time_local: "09:00",
        timezone: MSK,
        task_payload: { title: "Понедельный отчёт" },
      },
    });
    expect(res.statusCode).toBe(201);
    const schedule = res.json().schedule;
    expect(schedule.rule_label).toBe("Еженедельно: понедельник");
    // День запуска — понедельник (в зоне рутины).
    const local = zonedParts(new Date(schedule.next_run_at), MSK);
    expect(local.weekday).toBe(1);
    // Показанный запуск и запуск, посчитанный планировщиком по той же
    // формуле, совпадают (якорь один и тот же).
    const stored = getSchedule(schedule.id)!;
    const recomputed = nextRunAfter(
      {
        kind: stored.rule_kind,
        expr: stored.rule_expr,
        timeLocal: stored.time_local,
        timezone: stored.timezone,
        anchor: anchorForNow(new Date(), MSK),
      },
      new Date(),
    );
    expect(recomputed!.toISOString()).toBe(new Date(schedule.next_run_at).toISOString());
  });

  it("cron-правило принимается и считает следующий запуск", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        title: "По cron",
        rule_kind: "cron",
        rule_expr: "0 9 * * 1-5",
        task_payload: { title: "По cron" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.schedule.next_run_at).toBeTruthy();
    expect(body.schedule.rule_label).toContain("cron");
  });

  it("посторонний пользователь не может создать рутину", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Чужой",
        email: `schedules-other-${Date.now()}@test`,
        password: "password123",
      },
    });
    const otherToken = app.jwt.sign({ id: reg.json().user.id }, { expiresIn: "5m" });
    const res = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${otherToken}` },
      payload: {
        title: "Чужая рутина",
        rule_kind: "daily",
        time_local: "09:00",
        task_payload: { title: "Чужая рутина" },
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("после пропущенного запуска следующий запуск всё равно в будущем", async () => {
    const schedule = createDaily({ payload: { assignee_id: "builder" } });
    // Просрочка больше окна догона (24 ч) — запуск пропускается.
    markScheduleRun(schedule.id, { nextRunAt: new Date(Date.now() - 48 * 3_600_000) });
    const counts = await runSchedulesTick(app, { now: new Date() });
    expect(counts.created).toBe(0);
    const next = parseUtc(getSchedule(schedule.id)!.next_run_at)!;
    expect(next.getTime()).toBeGreaterThan(Date.now());
    // В истории виден пропуск с причиной.
    const run = listRuns(schedule.id)[0];
    expect(run.status).toBe("skipped");
  });

  it("карточка рутины ложится в заданный проект", async () => {
    const projectId = "proj-routine-test";
    db.prepare(
      "INSERT OR REPLACE INTO projects (id, name, owner_id, created_at) VALUES (?, ?, ?, datetime('now'))",
    ).run(projectId, "Проект рутин", ownerId);
    const schedule = createDaily({
      payload: { assignee_id: "builder", project_id: projectId },
    });
    const counts = await runSchedulesTick(app, { now: new Date() });
    expect(counts.created).toBeGreaterThanOrEqual(1);
    const run = listRuns(schedule.id)[0];
    const task = db
      .prepare("SELECT project_id, status FROM tasks WHERE id = ?")
      .get(run.task_id ?? "") as { project_id: string | null; status: string } | undefined;
    expect(task?.project_id).toBe(projectId);
  });

  it("ручной запуск приостановленной рутины отклоняется с понятной причиной", async () => {
    const schedule = createDaily({ payload: { assignee_id: "builder" } });
    await app.inject({
      method: "PATCH",
      url: `/api/schedules/${schedule.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "paused" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/schedules/${schedule.id}/run-now`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("паузе");
  });
});
