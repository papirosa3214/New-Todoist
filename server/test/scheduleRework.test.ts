// Доработка по замечаниям Критика к коду расписания (рутины).
//
// Проверяем пять пунктов:
//   D1 — занятый слот запуска двигает next_run_at вперёд (рутина не залипает);
//   D2 — порог отключения догона не меньше интервала планировщика;
//   D3 — якорь недели/месяца один и тот же на создании, правке и предпросмотре;
//   D4 — ручной запуск уважает наложение (overlap_policy=skip);
//   D5 — брошенный запуск не остаётся в истории как «создана» без карточки.
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
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
  anchorForInstant,
  decideRun,
  zonedParts,
  type ScheduleRule,
} from "../src/runtime/schedules/rules.js";
import {
  claimRun,
  createSchedule,
  getSchedule,
  listRuns,
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

describe("доработка рутин по замечаниям Критика", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Rework owner",
        email: `rework-${Date.now()}@test`,
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

  function createScheduleRow(over: {
    nextRunAt?: Date;
    catchUp?: boolean;
    overlapPolicy?: "skip" | "allow";
    kind?: ScheduleRule["kind"];
    timeLocal?: string;
    payload?: Record<string, unknown>;
  } = {}) {
    return createSchedule({
      title: "Рутина на проверку",
      taskPayload: { title: "Проверить рутину", assignee_id: "builder", ...(over.payload ?? {}) } as never,
      rule: rule({ kind: over.kind ?? "daily", timeLocal: over.timeLocal ?? "09:00" }),
      nextRunAt: over.nextRunAt ?? new Date(Date.now() - 60_000),
      catchUp: over.catchUp ?? true,
      overlapPolicy: over.overlapPolicy ?? "skip",
      createdBy: ownerId,
    });
  }

  // ─── D1 ────────────────────────────────────────────────────────────────

  it("D1: занятый слот не оставляет рутину в прошлом — следующий запуск в будущем", async () => {
    const schedule = createScheduleRow();
    const due = parseUtc(getSchedule(schedule.id)!.next_run_at)!;
    // Слот занят (процесс упал после создания карточки, до пересчёта
    // расписания) — второй проход не должен создавать карточку, но обязан
    // сдвинуть расписание вперёд.
    claimRun({ scheduleId: schedule.id, runAt: due });
    const tasksBefore = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;

    const counts = await runSchedulesTick(app, { now: new Date() });

    const tasksAfter = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    expect(tasksAfter).toBe(tasksBefore);
    expect(counts.created).toBe(0);
    const next = parseUtc(getSchedule(schedule.id)!.next_run_at)!;
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it("D1: брошенный слот без карточки помечается ошибкой, а не успешным запуском", async () => {
    const schedule = createScheduleRow();
    const due = parseUtc(getSchedule(schedule.id)!.next_run_at)!;
    claimRun({ scheduleId: schedule.id, runAt: due });
    // Процесс упал сразу после вставки: карточки нет, слот есть.
    db.prepare(
      "UPDATE schedule_runs SET created_at = datetime('now', '-30 minutes') WHERE schedule_id = ?",
    ).run(schedule.id);

    await runSchedulesTick(app, { now: new Date() });

    const run = listRuns(schedule.id).find((r) => r.run_at === due.toISOString());
    expect(run).toBeTruthy();
    expect(run!.task_id).toBeNull();
    expect(run!.status).not.toBe("created");
  });

  // ─── D2 ────────────────────────────────────────────────────────────────

  it("D2: опоздание в пределах интервала планировщика — штатный запуск, не пропуск", () => {
    const next = new Date("2026-10-22T06:00:00.000Z");
    // Догон выключен, но опоздание меньше интервала планировщика (5 минут)
    // плюс запас — запуск штатный.
    const d = decideRun({
      now: new Date("2026-10-22T06:04:00.000Z"),
      nextRunAt: next,
      catchUp: false,
      overlapOpen: false,
    });
    expect(d.action).toBe("run");
  });

  it("D2: сильное опоздание при выключенном догоне — пропуск", () => {
    const next = new Date("2026-10-22T06:00:00.000Z");
    const d = decideRun({
      now: new Date("2026-10-22T06:30:00.000Z"),
      nextRunAt: next,
      catchUp: false,
      overlapOpen: false,
    });
    expect(d.action).toBe("skip");
    expect(d.reason).toContain("догон отключён");
  });

  it("D2: рутина с выключенным догоном срабатывает, а не пропускает запуски", async () => {
    const schedule = createScheduleRow({ catchUp: false });
    // Планировщик зашёл на рутину с опозданием (дольше минуты, но в пределах
    // интервала обхода) — запуск должен состояться.
    markScheduleRun(schedule.id, { nextRunAt: new Date(Date.now() - 3 * 60_000) });
    const counts = await runSchedulesTick(app, { now: new Date() });
    expect(counts.created).toBe(1);
    expect(counts.skipped).toBe(0);
  });

  // ─── D3 ────────────────────────────────────────────────────────────────

  it("D3: якорь недели — день создания рутины, а не фиктивная дата", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        title: "Еженедельная рутина",
        rule_kind: "weekly",
        time_local: "09:00",
        timezone: MSK,
        task_payload: { title: "Еженедельная рутина" },
      },
    });
    expect(res.statusCode).toBe(201);
    const next = parseUtc(res.json().schedule.next_run_at)!;
    const createdWeekday = zonedParts(new Date(), MSK).weekday;
    expect(zonedParts(next, MSK).weekday).toBe(createdWeekday);
  });

  it("D3: якорь месяца — число создания рутины", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        title: "Месячная рутина",
        rule_kind: "monthly",
        time_local: "09:00",
        timezone: MSK,
        task_payload: { title: "Месячная рутина" },
      },
    });
    expect(res.statusCode).toBe(201);
    const next = parseUtc(res.json().schedule.next_run_at)!;
    const today = zonedParts(new Date(), MSK);
    const daysInNextMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    const expectedDay = Math.min(today.day, daysInNextMonth);
    expect(zonedParts(next, MSK).day).toBe(expectedDay);
  });

  it("D3: предпросмотр и создание считают один и тот же якорь", async () => {
    const preview = await app.inject({
      method: "GET",
      url: `/api/schedules/preview?rule_kind=monthly&time_local=09:00&timezone=${encodeURIComponent(MSK)}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(preview.statusCode).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        title: "Рутина для сверки предпросмотра",
        rule_kind: "monthly",
        time_local: "09:00",
        timezone: MSK,
        task_payload: { title: "Рутина для сверки предпросмотра" },
      },
    });
    expect(created.statusCode).toBe(201);
    const previewNext = parseUtc(preview.json().next_run_at)!;
    const createdNext = parseUtc(created.json().schedule.next_run_at)!;
    expect(zonedParts(previewNext, MSK).day).toBe(zonedParts(createdNext, MSK).day);
    expect(zonedParts(previewNext, MSK).day).toBe(
      anchorForInstant(new Date(), MSK).day,
    );
  });

  it("D3: правка рутины не меняет якорь на фиктивную дату", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        title: "Рутина под правку",
        rule_kind: "weekly",
        time_local: "09:00",
        timezone: MSK,
        task_payload: { title: "Рутина под правку" },
      },
    });
    const id = created.json().schedule.id;
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/schedules/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { time_local: "10:00" },
    });
    expect(patched.statusCode).toBe(200);
    const next = parseUtc(patched.json().schedule.next_run_at)!;
    expect(zonedParts(next, MSK).weekday).toBe(zonedParts(new Date(), MSK).weekday);
  });

  // ─── D4 ────────────────────────────────────────────────────────────────

  it("D4: ручной запуск при незакрытом прошлом экземпляре не создаёт карточку", async () => {
    const schedule = createScheduleRow();
    await runSchedulesTick(app, { now: new Date() });
    expect(getSchedule(schedule.id)!.current_task_id).toBeTruthy();
    // Предыдущий экземпляр должен быть ОТКРЫТ. Карточка, которую создал
    // тик, может закрыться сама (роль отработала мгновенно) — тогда
    // наложения нет и проверка была бы гонкой. Поэтому ставим рутине
    // заведомо открытый экземпляр.
    const openInstanceId = "open-instance-d4";
    db.prepare(
      "INSERT INTO tasks (id, title, status) VALUES (?, ?, 'active')",
    ).run(openInstanceId, "Открытый экземпляр рутины");
    db.prepare(
      "UPDATE task_schedules SET current_task_id = ? WHERE id = ?",
    ).run(openInstanceId, schedule.id);
    const tasksBefore = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;

    const res = await app.inject({
      method: "POST",
      url: `/api/schedules/${schedule.id}/run-now`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().counts.created).toBe(0);
    expect(res.json().counts.skipped).toBeGreaterThanOrEqual(1);
    const tasksAfter = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    expect(tasksAfter).toBe(tasksBefore);
    // В истории виден пропуск с причиной.
    const latest = listRuns(schedule.id)[0];
    expect(latest.status).toBe("skipped");
    expect(latest.detail).toContain("не закрыт");
  });

  it("D4: ручной запуск при свободном прошлом экземпляре карточку создаёт", async () => {
    const schedule = createScheduleRow();
    const res = await app.inject({
      method: "POST",
      url: `/api/schedules/${schedule.id}/run-now`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.created).toBe(1);
  });

  // ─── D5 ────────────────────────────────────────────────────────────────

  it("D5: брошенный запуск в истории не остаётся записью «создана»", async () => {
    const schedule = createScheduleRow();
    const due = parseUtc(getSchedule(schedule.id)!.next_run_at)!;
    claimRun({ scheduleId: schedule.id, runAt: due });
    // Ставим «слот занят давно» — так чистка в начале тика понимает, что
    // процесс упал. Откатываем время всем записям рутины: не зависит от
    // формата run_at.
    db.prepare(
      "UPDATE schedule_runs SET created_at = datetime('now', '-30 minutes') WHERE schedule_id = ?",
    ).run(schedule.id);

    await runSchedulesTick(app, { now: new Date() });

    const run = listRuns(schedule.id).find((r) => r.run_at === due.toISOString());
    expect(run!.status).toBe("failed");
    expect(run!.task_id).toBeNull();
  });
});
