// Контракт рутин после правок по решению архитектора (22.10.2026):
//   1. якорь первого запуска — дата создания рутины в её зоне, а не 1970 год;
//   2. явный день правила («Еженедельно» → день недели, «Ежемесячно» →
//      число месяца) главнее даты создания;
//   3. cron-выражение в первой версии не поддерживается — отказ на входе;
//   4. метки в шаблоне задаются именами и превращаются в идентификаторы;
//   5. два выключателя рутин: весь механизм и запуск по расписанию.
//
// Тесты падают на коде до правок и зеленеют после.
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

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
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import {
  localDateParts,
  nextRunAfter,
  type ScheduleRule,
} from "../src/runtime/schedules/rules.js";
import { createSchedule, getSchedule } from "../src/runtime/schedules/store.js";
import { runSchedulesTick } from "../src/runtime/schedules/tick.js";

const MSK = "Europe/Moscow";
/** Пятница, 23.10.2026, 13:00 МСК — момент, на котором считаем якорь. */
const FRIDAY = new Date("2026-10-23T10:00:00.000Z");

/**
 * Фактический якорь рутины: дата её создания в зоне рутины.
 *
 * created_at ставит СУБД (datetime('now')), поэтому он не подменяется
 * часами приложения — это реальное время. Тесты, которым нужен якорь,
 * берут его отсюда, а не подставляют дату руками.
 */
function anchorOf(scheduleId: string, timezone: string) {
  const row = getSchedule(scheduleId)!;
  return localDateParts(new Date(row.created_at.replace(" ", "T") + "Z"), timezone);
}

/** День недели календарной даты (0 — воскресенье). */
function weekdayOf(date: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Время суток в зоне рутины, «ЧЧ:ММ». */
function localTimeOf(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

describe("якорь первого запуска и явный день правила", () => {
  it("якорь без явного дня — дата создания рутины в её зоне", () => {
    expect(localDateParts(FRIDAY, MSK)).toEqual({ year: 2026, month: 10, day: 23 });
  });

  it("явный день недели главнее даты создания", () => {
    // Понедельник (ISO 1), создано в пятницу.
    const rule: ScheduleRule = {
      kind: "weekly",
      expr: "1",
      timeLocal: "09:00",
      timezone: MSK,
      anchor: localDateParts(FRIDAY, MSK),
    };
    const next = nextRunAfter(rule, FRIDAY)!;
    // Ближайший понедельник после пятницы — 26.10.2026, 09:00 МСК.
    expect(next.toISOString()).toBe("2026-10-26T06:00:00.000Z");
  });

  it("явное число месяца главнее даты создания", () => {
    const rule: ScheduleRule = {
      kind: "monthly",
      expr: "19",
      timeLocal: "09:00",
      timezone: MSK,
      anchor: localDateParts(FRIDAY, MSK),
    };
    const next = nextRunAfter(rule, FRIDAY)!;
    expect(next.toISOString()).toBe("2026-11-19T06:00:00.000Z");
  });

  it("без явного дня «раз в неделю» срабатывает в день создания", () => {
    const rule: ScheduleRule = {
      kind: "weekly",
      expr: null,
      timeLocal: "09:00",
      timezone: MSK,
      anchor: localDateParts(FRIDAY, MSK),
    };
    const next = nextRunAfter(rule, FRIDAY)!;
    // Следующая пятница — 30.10.2026, 09:00 МСК.
    expect(next.toISOString()).toBe("2026-10-30T06:00:00.000Z");
  });
});

describe("рутины в базе: контракт API", () => {
  let app: FastifyInstance;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Routines contract owner",
        email: `routines-contract-${Date.now()}@test`,
        password: "password123",
      },
    });
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Токен подписываем в момент вызова: под поддельными часами старый
   *  токен выглядит просроченным (401). */
  function ownerHeaders() {
    return { authorization: `Bearer ${app.jwt.sign({ id: ownerId }, { expiresIn: "5m" })}` };
  }

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.TASKFLOW_ROUTINES_ENABLED;
    delete process.env.TASKFLOW_ROUTINES_TICK_ENABLED;
  });

  function createRoutine(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: ownerHeaders(),
      payload: body,
    });
  }

  it("рутина без явного дня недельная — первый запуск в день создания", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FRIDAY);
    const res = await createRoutine({
      title: "Еженедельная сводка",
      rule_kind: "weekly",
      time_local: "09:00",
      timezone: MSK,
      task_payload: { title: "Еженедельная сводка" },
    });
    expect(res.statusCode).toBe(201);
    // created_at ставит СУБД реальными часами (datetime('now')) — подмена
    // часов приложения (vi.setSystemTime) на него не действует. Поэтому
    // ожидание считаем от ФАКТИЧЕСКОГО якоря — даты создания рутины в её
    // зоне, а не от зашитой в тесте даты: иначе кейс зелёный только в
    // те дни недели, когда реальная дата совпадает с подставленной.
    const anchor = anchorOf(res.json().schedule.id, MSK);
    const expected = nextRunAfter(
      {
        kind: "weekly",
        expr: null,
        timeLocal: "09:00",
        timezone: MSK,
        anchor,
      },
      FRIDAY,
    )!;
    expect(res.json().schedule.next_run_at).toBe(expected.toISOString());
    // Первый запуск — в тот же день недели, что и день создания рутины
    // (иначе якорь уехал бы на 1970 год и рутина стартовала бы в четверг).
    expect(weekdayOf(anchor)).toBe(weekdayOf(localDateParts(expected, MSK)));
    // Время запуска — 09:00 по зоне рутины.
    expect(localTimeOf(expected, MSK)).toBe("09:00");
  });

  it("рутина с явным днём недели — первый запуск в выбранный день", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FRIDAY);
    const res = await createRoutine({
      title: "Сводка по понедельникам",
      rule_kind: "weekly",
      rule_expr: "1",
      time_local: "09:00",
      timezone: MSK,
      task_payload: { title: "Сводка по понедельникам" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().schedule.next_run_at).toBe("2026-10-26T06:00:00.000Z");
  });

  it("ежемесячная рутина с числом месяца — первый запуск в это число", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FRIDAY);
    const res = await createRoutine({
      title: "Отчёт 19-го",
      rule_kind: "monthly",
      rule_expr: "19",
      time_local: "09:00",
      timezone: MSK,
      task_payload: { title: "Отчёт 19-го" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().schedule.next_run_at).toBe("2026-11-19T06:00:00.000Z");
  });

  it("показатель первого запуска совпадает с тем, что посчитает тик", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FRIDAY);
    const res = await createRoutine({
      title: "Совпадение расчётов",
      rule_kind: "weekly",
      rule_expr: "3",
      time_local: "10:00",
      timezone: MSK,
      task_payload: { title: "Совпадение расчётов" },
    });
    expect(res.statusCode).toBe(201);
    const shown = res.json().schedule.next_run_at;
    const row = getSchedule(res.json().schedule.id)!;
    // Тот же расчёт из тика: следующий запуск после момента создания.
    const rule = {
      kind: row.rule_kind,
      expr: row.rule_expr,
      timeLocal: row.time_local,
      timezone: row.timezone,
      anchor: localDateParts(
        new Date(row.created_at.replace(" ", "T") + "Z"),
        row.timezone,
      ),
    };
    const next = nextRunAfter(rule, FRIDAY)!;
    expect(next.toISOString()).toBe(shown);
  });

  it("cron-выражение отклоняется на входе", async () => {
    const res = await createRoutine({
      title: "По cron",
      rule_kind: "cron",
      rule_expr: "0 9 * * 1-5",
      task_payload: { title: "По cron" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("cron");
  });

  it("правка рутины на cron отклоняется", async () => {
    const created = await createRoutine({
      title: "Обычная рутина",
      rule_kind: "daily",
      time_local: "09:00",
      task_payload: { title: "Обычная рутина" },
    });
    const id = created.json().schedule.id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/schedules/${id}`,
      headers: ownerHeaders(),
      payload: { rule_kind: "cron", rule_expr: "0 9 * * 1-5" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("cron");
  });

  it("превью cron отклоняется", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/schedules/preview?rule_kind=cron&rule_expr=0%209%20*%20*%201-5",
      headers: ownerHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("cron");
  });

  it("метка по имени создаёт карточку с этой меткой", async () => {
    const labelId = "label-routine-contract";
    db.prepare(
      "INSERT OR REPLACE INTO labels (id, name, color, owner_id) VALUES (?, ?, ?, ?)",
    ).run(labelId, "Отчёт", "#FF7A8A", ownerId);
    const res = await createRoutine({
      title: "Отчёт с меткой",
      rule_kind: "daily",
      time_local: "09:00",
      task_payload: { title: "Отчёт с меткой", labels: ["Отчёт"] },
    });
    expect(res.statusCode).toBe(201);
    const schedule = createSchedule({
      title: "Отчёт с меткой (тик)",
      taskPayload: { title: "Отчёт с меткой", labels: ["Отчёт"] } as never,
      rule: {
        kind: "daily",
        expr: null,
        timeLocal: "09:00",
        timezone: MSK,
        anchor: localDateParts(new Date(), MSK),
      },
      nextRunAt: new Date(Date.now() - 60_000),
      catchUp: true,
      overlapPolicy: "skip",
      createdBy: ownerId,
    });
    const counts = await runSchedulesTick(app, { now: new Date(), scheduleId: schedule.id });
    expect(counts.created).toBe(1);
    const task = db
      .prepare("SELECT id FROM tasks WHERE title = 'Отчёт с меткой' ORDER BY id DESC LIMIT 1")
      .get() as { id: string } | undefined;
    expect(task).toBeTruthy();
    const link = db
      .prepare("SELECT label_id FROM task_labels WHERE task_id = ?")
      .get(task!.id) as { label_id: string } | undefined;
    expect(link?.label_id).toBe(labelId);
  });

  it("несуществующая метка отклоняется при создании рутины", async () => {
    const res = await createRoutine({
      title: "Нет такой метки",
      rule_kind: "daily",
      time_local: "09:00",
      task_payload: { title: "Нет такой метки", labels: ["Такой метки нет"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Такой метки нет");
  });

  it("выключатель рутин останавливает создание и запуск по расписанию", async () => {
    process.env.TASKFLOW_ROUTINES_ENABLED = "0";
    const res = await createRoutine({
      title: "Пока выключено",
      rule_kind: "daily",
      time_local: "09:00",
      task_payload: { title: "Пока выключено" },
    });
    expect(res.statusCode).toBe(503);
    delete process.env.TASKFLOW_ROUTINES_ENABLED;

    const schedule = createSchedule({
      title: "Пока выключено (тик)",
      taskPayload: { title: "Пока выключено" } as never,
      rule: {
        kind: "daily",
        expr: null,
        timeLocal: "09:00",
        timezone: MSK,
        anchor: localDateParts(new Date(), MSK),
      },
      nextRunAt: new Date(Date.now() - 60_000),
      catchUp: true,
      overlapPolicy: "skip",
      createdBy: ownerId,
    });
    process.env.TASKFLOW_ROUTINES_ENABLED = "0";
    const counts = await runSchedulesTick(app, { now: new Date(), scheduleId: schedule.id });
    expect(counts.created).toBe(0);
  });

  it("выключатель запуска по расписанию не мешает ручному запуску", async () => {
    process.env.TASKFLOW_ROUTINES_TICK_ENABLED = "0";
    const schedule = createSchedule({
      title: "Только вручную",
      taskPayload: { title: "Только вручную" } as never,
      rule: {
        kind: "daily",
        expr: null,
        timeLocal: "09:00",
        timezone: MSK,
        anchor: localDateParts(new Date(), MSK),
      },
      nextRunAt: new Date(Date.now() - 60_000),
      catchUp: true,
      overlapPolicy: "skip",
      createdBy: ownerId,
    });
    const counts = await runSchedulesTick(app, { now: new Date(), scheduleId: schedule.id });
    expect(counts.created).toBe(0);

    const res = await app.inject({
      method: "POST",
      url: `/api/schedules/${schedule.id}/run-now`,
      headers: ownerHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.created).toBe(1);
  });
});
