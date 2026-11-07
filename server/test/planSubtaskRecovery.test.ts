// Брошенные после перезапуска сервера узлы плана (владелец 01.10.2026,
// T05): роль молча продолжает; второй обрыв подряд — blocked.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const runs = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return {
    ...actual,
    runRoleInProcess: async () => {
      runs.count += 1;
      return { runId: `test-run-${runs.count}`, completion: Promise.resolve() };
    },
  };
});

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { roleUserId } from "../src/roleRouting.js";
import { recoverInterruptedPlanSubtasks } from "../src/runtime/planSubtaskAdmission.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("узлы плана после перезапуска сервера", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let taskId: string;
  let subtaskId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Recovery owner",
        email: `recovery-${Date.now()}@test`,
        password: "password123",
      },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(
      reg.json().user.id,
    );
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };
    // Создаём задачу под manual, чтобы applyIntakeToNewTask не успел
    // поставить свой план single_executor и не блокировал approve.
    db.prepare(
      "UPDATE users SET task_intake_mode='manual' WHERE role='owner'",
    ).run();

    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "Фабрика шаблона" },
    });
    taskId = task.json().task.id;
    const plan = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: ownerAuth,
      payload: {
        profile: "manual",
        rationale: "тест",
        nodes: [
          {
            slot_key: "executor",
            role_key: "builder",
            required: true,
            expected_result: "Реализация",
          },
        ],
        edges: [],
      },
    });
    expect(plan.statusCode).toBeLessThan(300);
    const approve = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans/${plan.json().id ?? plan.json().plan?.id}/approve`,
      headers: ownerAuth,
    });
    expect(approve.statusCode).toBeLessThan(300);
    // Разделение «вход vs цепочка»: mode='manual' больше не глушит
    // восстановление утверждённого плана — согласием владельца было
    // утверждение плана. Оставляем manual и проверяем именно это.
    const row = db
      .prepare(
        "SELECT id, agent_state FROM subtasks WHERE task_id = ? AND plan_node_key = 'executor'",
      )
      .get(taskId) as { id: string; agent_state: string };
    subtaskId = row.id;
    expect(row.agent_state).toBe("in_progress");
  });

  afterAll(async () => {
    await app.close();
  });

  const subtask = () =>
    db
      .prepare(
        "SELECT agent_state, current_attempt_id FROM subtasks WHERE id = ?",
      )
      .get(subtaskId) as {
      agent_state: string | null;
      current_attempt_id: string | null;
    };
  const comments = () =>
    db
      .prepare(
        "SELECT user_id, text FROM comments WHERE task_id = ? ORDER BY rowid",
      )
      .all(taskId) as Array<{ user_id: string; text: string }>;

  it("первый обрыв: попытка interrupted, роль молча продолжает", async () => {
    const before = subtask().current_attempt_id;
    const startedBefore = runs.count;
    expect(await recoverInterruptedPlanSubtasks()).toEqual({
      resumed: 1,
      blocked: 0,
      freed: 0,
    });

    const old = db
      .prepare("SELECT outcome, ended_at FROM attempts WHERE id = ?")
      .get(before) as { outcome: string; ended_at: string | null };
    expect(old.outcome).toBe("interrupted");
    expect(old.ended_at).toBeTruthy();
    expect(subtask().agent_state).toBe("in_progress");
    expect(subtask().current_attempt_id).not.toBe(before);
    expect(runs.count).toBe(startedBefore + 1);
    expect(comments()).toHaveLength(0);
  });

  it("второй обрыв за полчаса: blocked и сообщение владельцу, без нового запуска", async () => {
    const startedBefore = runs.count;
    expect(await recoverInterruptedPlanSubtasks()).toEqual({
      resumed: 0,
      blocked: 1,
      freed: 0,
    });
    expect(subtask().agent_state).toBe("blocked");
    expect(runs.count).toBe(startedBefore);
    expect(comments().at(-1)!.text).toContain("Сам больше не продолжаю");
  });

  it("заблокированный узел при следующем старте освобождает аренду (freed)", async () => {
    // Доработка MAK-66 (critic 05.10.2026): блокировка из-за обрыва сервера
    // — не навсегда; при рестарте узел снова попадает в общую очередь.
    // Владелец/оркестратор потом сам решает, что с ним делать.
    expect(await recoverInterruptedPlanSubtasks()).toEqual({
      resumed: 0,
      blocked: 0,
      freed: 1,
    });
    expect(subtask().agent_state).toBeNull();
    expect(
      comments().some((c) =>
        c.text.includes("после рестарта сервера снят признак"),
      ),
    ).toBe(false);
  });

  it("сбрасывает succeeded/dead role_run_jobs этой задачи (Г1-к: дедупликация не возвращает старое задание)", async () => {
    // Имитируем картину Г1-к: прошлый запуск задачи уже `succeeded`,
    // и `POST /run` отдаёт тот же job по `dedupe_key`. Восстановление
    // должно сбросить его в `queued` (attempts=0, lease чист), чтобы
    // новый старт получил свежую попытку, а не чужую запись.
    //
    // После предыдущего теста узел в `agent_state = NULL` — переводим
    // его в `todo`, чтобы `recoverInterruptedPlanSubtasks` подхватил
    // его в `freed`-ветке и прошёл по `resetRoleRunJobsForTask`.
    db.prepare("UPDATE subtasks SET agent_state='todo' WHERE id = ?").run(
      subtaskId,
    );
    db.prepare(
      `INSERT INTO role_run_jobs
         (id, task_id, reason, actor_id, dedupe_key, status, attempts, max_attempts, chain_depth, manual_start, last_error, started_at, finished_at)
       VALUES (?, ?, 'after_run', NULL, ?, 'succeeded', 1, 3, 0, 0, 'old run', datetime('now','-1 hour'), datetime('now','-30 minutes'))`,
    ).run(`rrj_test_${Date.now()}_1`, taskId, `stale-dedupe-${Date.now()}_1`);
    db.prepare(
      `INSERT INTO role_run_jobs
         (id, task_id, reason, actor_id, dedupe_key, status, attempts, max_attempts, chain_depth, manual_start, last_error, started_at, finished_at)
       VALUES (?, ?, 'after_run', NULL, ?, 'dead', 3, 3, 0, 0, 'gave up', datetime('now','-2 hours'), datetime('now','-1 hour'))`,
    ).run(`rrj_test_${Date.now()}_2`, taskId, `stale-dedupe-${Date.now()}_2`);
    // Третий job — `running`, его трогать НЕЛЬЗЯ (его ход живой).
    db.prepare(
      `INSERT INTO role_run_jobs
         (id, task_id, reason, actor_id, dedupe_key, status, attempts, max_attempts, chain_depth, manual_start, lease_owner, lease_expires_at, started_at)
       VALUES (?, ?, 'after_run', NULL, ?, 'running', 1, 3, 0, 0, 'live-worker', datetime('now','+5 minutes'), datetime('now','-1 minute'))`,
    ).run(`rrj_test_${Date.now()}_3`, taskId, `stale-dedupe-${Date.now()}_3`);
    // Четвёртый — отработавший ответ на комментарий: заново его не проигрывать.
    db.prepare(
      `INSERT INTO role_run_jobs
         (id, task_id, reason, actor_id, dedupe_key, status, attempts, max_attempts, chain_depth, manual_start, started_at, finished_at)
       VALUES (?, ?, 'commented', NULL, ?, 'succeeded', 1, 3, 0, 0, datetime('now','-1 hour'), datetime('now','-30 minutes'))`,
    ).run(`rrj_test_${Date.now()}_4`, taskId, `stale-comment-${Date.now()}_4`);
    await recoverInterruptedPlanSubtasks();
    const comment = db
      .prepare(
        `SELECT status FROM role_run_jobs WHERE task_id = ? AND id LIKE 'rrj_test_%_4'`,
      )
      .get(taskId) as { status: string };
    expect(comment.status).toBe("succeeded");
    // Два завершённых задания — обнулены и снова в очереди.
    const queued = db
      .prepare(
        `SELECT id, status, attempts, lease_owner, finished_at FROM role_run_jobs WHERE task_id = ? AND id LIKE 'rrj_test_%' ORDER BY id`,
      )
      .all(taskId) as Array<{
      id: string;
      status: string;
      attempts: number;
      lease_owner: string | null;
      finished_at: string | null;
    }>;
    const recovered = queued.filter(
      (j) => j.id.endsWith("_1") || j.id.endsWith("_2"),
    );
    for (const job of recovered) {
      expect(job.status).toBe("queued");
      expect(job.attempts).toBe(0);
      expect(job.lease_owner).toBeNull();
      expect(job.finished_at).toBeNull();
    }
    // Третий, «живой» — не тронут.
    const live = queued.find((j) => j.id.endsWith("_3"))!;
    expect(live.status).toBe("running");
    expect(live.lease_owner).toBe("live-worker");
    // Узел снова свободен после `freed`.
    expect(subtask().agent_state).toBeNull();
  });
});
