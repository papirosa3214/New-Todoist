// Рутина → карточка: проверяем, что задание рутины (название и описание)
// доезжает до созданной карточки, а не теряется по пути.
//
// Владелец 31.10.2026: «в рутине всё есть, а в карточке ни названия, ни
// описания». Этот тест воспроизводит путь тика на чистой базе.
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
import { createSchedule, listRuns, parseUtc } from "../src/runtime/schedules/store.js";
import { runSchedulesTick } from "../src/runtime/schedules/tick.js";

describe("рутина → карточка: название и описание", () => {
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
        name: "Routine fields owner",
        email: `routine-fields-${Date.now()}@test`,
        password: "password123",
      },
    });
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    await app.close();
  });

  it("карточка из шаблона получает название и описание рутины", async () => {
    const schedule = createSchedule({
      title: "Утренний отчёт",
      taskPayload: {
        title: "Собрать отчёт за сутки",
        description: "Полное задание: собрать цифры за сутки и свести в отчёт.",
      } as never,
      rule: {
        kind: "daily",
        expr: null,
        timeLocal: "09:00",
        timezone: "Europe/Moscow",
        anchor: { year: 2026, month: 10, day: 22 },
      },
      nextRunAt: new Date(Date.now() - 60_000),
      catchUp: true,
      overlapPolicy: "skip",
      createdBy: ownerId,
    });

    await runSchedulesTick(app, { now: new Date(), scheduleId: schedule.id, force: true });

    const runs = listRuns(schedule.id);
    expect(runs.length).toBe(1);
    expect(runs[0].task_id).toBeTruthy();

    const task = db
      .prepare("SELECT title, description FROM tasks WHERE id = ?")
      .get(runs[0].task_id ?? "") as { title: string; description: string | null } | undefined;
    expect(task?.title).toBe("Собрать отчёт за сутки");
    expect(task?.description).toBe("Полное задание: собрать цифры за сутки и свести в отчёт.");
  });
});
