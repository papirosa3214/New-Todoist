// Планировщик внутри сервера (владелец 01.10.2026) — те же ветки, что у
// scripts/scheduler.py, но без внешнего ключа: служебная учётка по
// внутреннему пропуску, роль поднимается в процессе.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { SCHEDULER_USER_ID } from "../src/serviceUser.js";
import { nextDue, runSchedulerPass } from "../src/runtime/scheduler.js";
import { resolveUserIdFromToken } from "../src/auth.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("следующая дата повтора — как _next_due", () => {
  it("день, будни, неделя, месяц", () => {
    expect(nextDue("2026-10-02", "daily")).toBe("2026-10-03");
    expect(nextDue("2026-10-02", "weekdays")).toBe("2026-10-05"); // пятница → понедельник
    expect(nextDue("2026-10-02", "weekly")).toBe("2026-10-09");
    expect(nextDue("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextDue("2026-12-15", "monthly")).toBe("2027-01-15");
    expect(nextDue("2026-10-02", "yearly")).toBeNull();
  });
});

describe("обход доски внутри сервера", () => {
  let app: FastifyInstance;
  let ownerId: string;
  const heartbeat = path.join(os.tmpdir(), `scheduler-hb-${process.pid}.json`);

  beforeAll(async () => {
    process.env.TASKFLOW_SCHEDULER_HEARTBEAT = heartbeat;
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    // Служебная учётка — как на .110: в архиве, без внешнего ключа.
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type, avatar_color, initials, status, archived)
       VALUES (?, 'Pi Agent', 'pi@agent.test', 'x', 'agent', 'ai', '#888', 'P', 'offline', 1)`,
    ).run(SCHEDULER_USER_ID);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Sched owner", email: `sched-${Date.now()}@test`, password: "password123" } });
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    delete process.env.TASKFLOW_SCHEDULER_HEARTBEAT;
    fs.rmSync(heartbeat, { force: true });
    await app.close();
  });

  function insertTask(fields: Record<string, unknown>): string {
    const id = crypto.randomUUID();
    const row = { id, title: "t", creator_id: ownerId, status: "active", ...fields };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO tasks (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row));
    return id;
  }

  it("архивная служебная учётка не входит обычным JWT", () => {
    const token = app.jwt.sign({ id: SCHEDULER_USER_ID });
    expect(resolveUserIdFromToken(app, token)).toBeNull();
  });

  it("явный предел серии отмечается без создания следующей карточки", async () => {
    const id = insertTask({ title: "Конец серии", status: "completed", due_date: "2026-10-01", run_repeat: "daily", repeat_until: "2026-10-01" });
    await runSchedulerPass(app, new Date(2026, 9, 1, 12));
    expect(db.prepare("SELECT recurrence_spawned FROM tasks WHERE id = ?").get(id)).toEqual({ recurrence_spawned: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Конец серии'").get()).toEqual({ n: 1 });
  });

  it("повтор: одно следующее вхождение, дубля на втором обходе нет; тупик — одно уведомление; отметка", async () => {
    const now = new Date(2026, 9, 1, 12, 0);
    const recurring = insertTask({ title: "Полить цветы", status: "completed", due_date: "2026-10-01", run_repeat: "daily" });
    const dead = insertTask({ title: "Застряла", agent_state: "blocked", block_type: "dead", blocked_reason: "все роли отказались" });
    // Ветка 4 (запуск по времени) перенесена как есть: она читает run_at из
    // списка задач, а список его не отдаёт — и в старом скрипте ни разу не
    // срабатывала. Включать ли — решает владелец (01.10.2026).
    insertTask({ title: "По расписанию", assignee_id: "role_builder", due_date: "2026-10-01", start_time: "11:50" });

    const first = await runSchedulerPass(app, now);
    expect(first.repeat).toBe(1);
    expect(first.dead).toBe(1);
    expect(first.scheduled).toBe(0);
    expect(launched).toEqual([]);

    const clones = db.prepare("SELECT due_date FROM tasks WHERE title = 'Полить цветы' AND id <> ?").all(recurring) as Array<{ due_date: string }>;
    expect(clones.map((c) => c.due_date)).toEqual(["2026-10-02"]);
    const notes = db.prepare("SELECT type FROM notifications WHERE task_id = ?").all(dead) as Array<{ type: string }>;
    expect(notes.map((n) => n.type)).toEqual(["task_dead"]);

    const hb = JSON.parse(fs.readFileSync(heartbeat, "utf8"));
    expect(hb).toMatchObject({ repeat: 1, dead: 1, scheduled: 0, source: "server" });

    const second = await runSchedulerPass(app, now);
    expect(second.repeat).toBe(0);
    expect(second.dead).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Полить цветы'").get()).toEqual({ n: 2 });
  });
});
