// Расписание и повтор (ветки 4 и 5 scheduler.py + серверные контракты).
//
// scheduler.py — отдельный Python-воркер, который ходит в HTTP API сервера.
// Его ветки нельзя вызвать из vitest напрямую, поэтому покрытие разбито на
// две части:
//   1) серверные контракты, на которые воркер опирается: run_at, поля
//      run_repeat/repeat_until/recurrence_spawned, GET /api/scheduler/recurring,
//      POST /api/tasks/:id/repeat-extend и repeat-ended (этот describe,
//      настоящий app.inject на временной БД из test/setup.ts);
//   2) логика самих веток scheduler.py — через Python-харнесс
//      test/fixtures/scheduler_probe.py (второй describe): модуль
//      импортируется, api() и subprocess.Popen подменяются заглушками,
//      продуктовый код не меняется.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("расписание и повтор: серверные контракты", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let otherToken: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OwnerSchedule",
        email: "owner-schedule@test",
        password: "password123",
      },
    });
    ownerToken = owner.json().token;
    ownerId = owner.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    const other = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OtherSchedule",
        email: "other-schedule@test",
        password: "password123",
      },
    });
    otherToken = other.json().token;
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  // Задачи заводим на самого владельца: без assignee сервер запускает
  // фоновый подбор исполнителя (dispatch.applyIntakeToNewTask) — тесту он
  // не нужен и делает прогон недетерминированным.
  async function createTask(payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: auth(ownerToken),
      payload: { assignee_id: ownerId, ...payload },
    });
    expect(res.statusCode).toBe(200);
    return res.json().task as Record<string, any>;
  }

  async function patchTask(id: string, payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: auth(ownerToken),
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json().task as Record<string, any>;
  }

  async function recurringIds(): Promise<string[]> {
    const res = await app.inject({
      method: "GET",
      url: "/api/scheduler/recurring",
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as Array<{ id: string }>).map((t) => t.id);
  }

  it("run_at собирается из срока и времени, без срока — null (формат для scheduler.py)", async () => {
    const noTime = await createTask({ title: "run_at default", due_date: "2026-10-05" });
    expect(noTime.run_at).toBe("2026-10-05 09:00");

    const withTime = await createTask({
      title: "run_at custom",
      due_date: "2026-10-05",
      start_time: "14:30",
    });
    expect(withTime.run_at).toBe("2026-10-05 14:30");

    const noDue = await createTask({ title: "run_at none" });
    expect(noDue.run_at).toBeNull();
  });

  it("run_repeat сохраняется; неизвестный интервал схлопывается в none", async () => {
    const daily = await createTask({
      title: "repeat daily",
      due_date: "2026-09-20",
      run_repeat: "daily",
      repeat_until: "2026-11-30",
    });
    expect(daily.run_repeat).toBe("daily");
    expect(daily.repeat_until).toBe("2026-11-30");
    expect(daily.recurrence_spawned).toBe(0);

    const bogus = await createTask({
      title: "repeat bogus",
      due_date: "2026-09-20",
      run_repeat: "yearly",
    });
    expect(bogus.run_repeat).toBe("none");
    expect(bogus.repeat_until).toBeNull();
  });

  it("/api/scheduler/recurring отдаёт только завершённые незасеянные серии", async () => {
    const task = await createTask({
      title: "recurring lifecycle",
      due_date: "2026-09-20",
      run_repeat: "daily",
    });
    // Активная — планировщику нечего с ней делать (её берёт ветка 4).
    expect(await recurringIds()).not.toContain(task.id);

    await patchTask(task.id, { status: "completed" });
    expect(await recurringIds()).toContain(task.id);

    // Засеяно — «одна за раз»: второй раз не отдаём, пока не сброшен флаг.
    await patchTask(task.id, { recurrence_spawned: 1 });
    expect(await recurringIds()).not.toContain(task.id);
  });

  it("повтор не возвращается, если run_repeat = none", async () => {
    const task = await createTask({ title: "recurring none", run_repeat: "none" });
    await patchTask(task.id, { status: "completed" });
    expect(await recurringIds()).not.toContain(task.id);
  });

  it("repeat-extend: только владелец, ставит конец следующего года и сбрасывает флаг", async () => {
    const task = await createTask({
      title: "extend me",
      due_date: "2026-09-20",
      run_repeat: "daily",
      repeat_until: "2026-12-31",
    });
    await patchTask(task.id, { status: "completed", recurrence_spawned: 1 });

    const forbidden = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/repeat-extend`,
      headers: auth(otherToken),
    });
    expect(forbidden.statusCode).toBe(403);

    const missing = await app.inject({
      method: "POST",
      url: "/api/tasks/does-not-exist/repeat-extend",
      headers: auth(ownerToken),
    });
    expect(missing.statusCode).toBe(404);

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/repeat-extend`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    const expectedUntil = `${new Date().getFullYear() + 1}-12-31`;
    expect(res.json().repeat_until).toBe(expectedUntil);

    const row = db
      .prepare("SELECT repeat_until, recurrence_spawned FROM tasks WHERE id = ?")
      .get(task.id) as { repeat_until: string; recurrence_spawned: number };
    expect(row.repeat_until).toBe(expectedUntil);
    // Флаг снят — серия снова может рождать следующее вхождение.
    expect(row.recurrence_spawned).toBe(0);
    expect(await recurringIds()).toContain(task.id);
  });

  it("repeat-ended: помечает серию засеянной и уведомляет владельца", async () => {
    const task = await createTask({
      title: "year end series",
      due_date: "2026-12-31",
      run_repeat: "daily",
    });
    await patchTask(task.id, { status: "completed" });

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/repeat-ended`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    const row = db
      .prepare("SELECT recurrence_spawned FROM tasks WHERE id = ?")
      .get(task.id) as { recurrence_spawned: number };
    expect(row.recurrence_spawned).toBe(1);
    // Вопрос о продлении не должен молча потеряться — уходит уведомление.
    const notif = db
      .prepare(
        "SELECT type, task_id FROM notifications WHERE task_id = ? AND type = 'repeat_ended'",
      )
      .get(task.id) as { type: string; task_id: string } | undefined;
    expect(notif?.type).toBe("repeat_ended");
    expect(await recurringIds()).not.toContain(task.id);
  });

  it("«одна за раз»: после засева завершённая серия уходит из выдачи", async () => {
    const due = "2026-09-20";
    const first = await createTask({
      title: "one at a time",
      due_date: due,
      run_repeat: "daily",
    });
    await patchTask(first.id, { status: "completed" });
    expect(await recurringIds()).toContain(first.id);

    // Так же, как это делает ветка 5: создать следующее вхождение и
    // пометить исходную засеянной.
    const next = await createTask({
      title: "one at a time",
      due_date: "2026-09-21",
      run_repeat: "daily",
    });
    await patchTask(first.id, { recurrence_spawned: 1 });

    expect(await recurringIds()).not.toContain(first.id);
    expect((next as any).status).toBe("active");

    // Ровно одна будущая карточка серии в работе, никаких «пачек вперёд».
    const successors = db
      .prepare(
        "SELECT id FROM tasks WHERE title = ? AND status = 'active' AND run_repeat = 'daily'",
      )
      .all("one at a time") as Array<{ id: string }>;
    expect(successors).toHaveLength(1);
    expect(successors[0].id).toBe(next.id);
  });
});

// ─── Ветки scheduler.py: детерминированная проба через python3 ─────────────
//
// scheduler.py запускается как воркер и ходит в HTTP API, поэтому его ветки
// нельзя исполнить в vitest напрямую. Фикстура scheduler_probe.py импортирует
// модуль и подменяет у него ровно две точки ввода-вывода (api и Popen),
// продуктовый код при этом не меняется. Если python3 в окружении нет — блок
// пропускается, а не падает.

const probePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "scheduler_probe.py",
);
const hasPython =
  spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!hasPython)("scheduler.py: ветки расписания и повтора", () => {
  const probe = hasPython
    ? spawnSync("python3", [probePath], { encoding: "utf8" })
    : { status: 0, stdout: "{}" };
  if (probe.status !== 0) {
    throw new Error(`scheduler_probe.py упал: ${probe.stderr || probe.stdout}`);
  }
  const result = JSON.parse(probe.stdout);

  it("_next_due: интервалы, выходные и конец месяца", () => {
    expect(result.next_due).toEqual({
      daily: "2026-09-21",
      weekdays_from_friday: "2026-09-21",
      weekdays_from_saturday: "2026-09-21",
      weekly: "2026-09-27",
      monthly_end_of_feb: "2026-02-28",
      monthly_leap: "2028-02-29",
      monthly_year_roll: "2027-01-15",
      unknown: null,
      bad_date: null,
    });
  });

  it("ветка 4: поднимает только активные агентские run_at в окне догона", () => {
    expect(result.launch.handled).toBe(1);
    expect(result.launch.launched_ids).toEqual(["in-window"]);
  });

  it("ветка 5: создаёт следующее вхождение и помечает исходное засеянным", () => {
    expect(result.clone.spawn.handled).toBe(1);
    const post = result.clone.spawn.calls.find(
      (c: any) => c.method === "POST" && c.path === "/api/tasks",
    );
    expect(post.body.due_date).toBe("2026-09-16");
    expect(post.body.run_repeat).toBe("daily");
    const patch = result.clone.spawn.calls.find((c: any) => c.method === "PATCH");
    expect(patch).toMatchObject({
      path: "/api/tasks/spawn1",
      body: { recurrence_spawned: 1 },
    });
  });

  const getRecurring = {
    method: "GET",
    path: "/api/scheduler/recurring",
    body: null,
  };

  it("ветка 5: упирается в repeat_until — серия закрывается без вопроса", () => {
    expect(result.clone.explicit_end.handled).toBe(0);
    expect(result.clone.explicit_end.calls).toEqual([
      getRecurring,
      { method: "PATCH", path: "/api/tasks/end1", body: { recurrence_spawned: 1 } },
    ]);
  });

  it("ветка 5: конец календарного года — спрашивает владельца", () => {
    expect(result.clone.year_end.handled).toBe(0);
    expect(result.clone.year_end.calls).toEqual([
      getRecurring,
      { method: "POST", path: "/api/tasks/yend1/repeat-ended", body: {} },
    ]);
  });

  it("ветка 5: run_repeat = none — ничего не делает", () => {
    expect(result.clone.no_repeat.handled).toBe(0);
    expect(result.clone.no_repeat.calls).toEqual([getRecurring]);
  });
});
