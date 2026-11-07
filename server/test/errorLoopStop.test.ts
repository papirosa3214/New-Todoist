// Стоп хода по циклу неверных вызовов (24.10.2026, карточка 252c400e):
// разработчик повторял один и тот же неверный вызов taskflow_work_plan
// 55+ раз подряд. Живость хода в стороже считалась по mtime журнала
// сессии, а цикл этот журнал пишет каждый ход — поэтому сторож молчал,
// а слот висел три часа. Проверяем: цикл (отказы есть, успешных нет) →
// ход остановлен, попытка закрыта, шаг в blocked, владелец уведомлён.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return {
    ...actual,
    runRoleInProcess: async () => ({
      runId: "test-run-cycle",
      completion: Promise.resolve(),
    }),
  };
});

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { roleUserId } from "../src/roleRouting.js";
import { runStalledStepWatch } from "../src/runtime/stalledStepWatcher.js";
import { toolOutcomeStats } from "../src/runtime/errorLoopStop.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

async function setupTaskWithPlan(
  app: FastifyInstance,
): Promise<{ taskId: string; subtaskId: string; auth: { authorization: string } }> {
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "Cycle owner",
      email: `cycle-${Date.now()}-${Math.random()}@test`,
      password: "password123",
    },
  });
  const userId = reg.json().user.id;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(userId);
  const auth = { authorization: `Bearer ${reg.json().token}` };
  db.prepare("UPDATE users SET task_intake_mode='manual' WHERE role='owner'").run();
  const task = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: auth,
    payload: { title: "Cycle fixture" },
  });
  const taskId = task.json().task.id;
  const plan = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/collaboration-plans`,
    headers: auth,
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
    headers: auth,
  });
  expect(approve.statusCode).toBeLessThan(300);
  const row = db
    .prepare(
      "SELECT id FROM subtasks WHERE task_id = ? AND plan_node_key = 'executor'",
    )
    .get(taskId) as { id: string };
  return { taskId, subtaskId: row.id, auth };
}

/** Шаг в работе: попытка открыта, слот занят ролью. Попытка на шаг может
 *  уже быть создана при утверждении плана (на шаг она одна — UNIQUE), так что
 *  берём существующую, а не заводим вторую. */
function startAttempt(taskId: string, subtaskId: string): string {
  const existing = db
    .prepare("SELECT id FROM attempts WHERE subtask_id = ?")
    .get(subtaskId) as { id: string } | undefined;
  const attemptId =
    existing?.id ??
    `att-cycle-${Math.random().toString(36).slice(2)}`;
  if (!existing) {
    db.prepare(
      `INSERT INTO attempts (id, task_id, subtask_id, executor_id, started_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(attemptId, taskId, subtaskId, roleUserId("builder"));
  }
  db.prepare(
    `UPDATE subtasks
        SET agent_state = 'in_progress', agent_id = ?, current_attempt_id = ?,
            agent_heartbeat_at = datetime('now')
      WHERE id = ?`,
  ).run(roleUserId("builder"), attemptId, subtaskId);
  return attemptId;
}

/** Отказы в журнале вызовов: столько же, сколько модель надела ошибок. */
function seedErrors(
  taskId: string,
  subtaskId: string,
  count: number,
  operation = "taskflow_work_plan",
  code = "INVALID_ARGUMENTS",
): void {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      `INSERT INTO role_tool_audit
         (id, created_at, role, mode, run_id, task_id, subtask_id, action, tool,
          operation, outcome, error_code, error_message)
       VALUES (?, datetime('now'), 'builder', 'work', 'run-cycle', ?, ?, 'invoke',
               'taskflow', ?, 'error', ?,
               'arguments.items: ожидается массив; получен объект {"item":{}}')`,
    ).run(
      `audit-cycle-${Math.random().toString(36).slice(2)}`,
      taskId,
      subtaskId,
      operation,
      code,
    );
  }
}

/** Успешный вызов в журнале: роль работала, а не крутила один неверный вызов. */
function seedOk(
  taskId: string,
  subtaskId: string,
  count = 1,
  operation = "taskflow_work_plan",
): void {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      `INSERT INTO role_tool_audit
         (id, created_at, role, mode, run_id, task_id, subtask_id, action, tool,
          operation, outcome)
       VALUES (?, datetime('now'), 'builder', 'work', 'run-cycle', ?, ?, 'invoke',
               'taskflow', ?, 'ok')`,
    ).run(
      `audit-ok-${Math.random().toString(36).slice(2)}`,
      taskId,
      subtaskId,
      operation,
    );
  }
}

describe("errorLoopStop", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
  });

  beforeEach(() => {
    // Чужие плановые шаги в работе не должны мешать сторожу.
    db.prepare(
      `UPDATE subtasks
          SET agent_state = 'todo', agent_id = NULL, current_attempt_id = NULL, agent_heartbeat_at = NULL
        WHERE collaboration_plan_id IS NOT NULL`,
    ).run();
    db.prepare("DELETE FROM notifications WHERE type = 'error_loop_blocked'").run();
    db.prepare("DELETE FROM task_events WHERE kind = 'subtask_error_loop_blocked'").run();
    db.prepare("DELETE FROM role_tool_audit WHERE run_id = 'run-cycle'").run();
  });

  afterAll(async () => {
    db.prepare("DELETE FROM role_tool_audit WHERE run_id = 'run-cycle'").run();
    await app.close();
  });

  it("останавливает ход, зациклившийся на неверных вызовах, и переводит шаг в blocked", async () => {
    const { taskId, subtaskId } = await setupTaskWithPlan(app);
    const attemptId = startAttempt(taskId, subtaskId);
    seedErrors(taskId, subtaskId, 3);

    const report = await runStalledStepWatch();
    expect(report.blocked).toBe(1);

    const step = db
      .prepare(
        "SELECT agent_state, current_attempt_id, agent_heartbeat_at FROM subtasks WHERE id = ?",
      )
      .get(subtaskId) as {
      agent_state: string | null;
      current_attempt_id: string | null;
      agent_heartbeat_at: string | null;
    };
    expect(step.agent_state).toBe("blocked");
    expect(step.current_attempt_id).toBeNull();
    expect(step.agent_heartbeat_at).toBeNull();

    const attempt = db
      .prepare("SELECT ended_at, outcome FROM attempts WHERE id = ?")
      .get(attemptId) as { ended_at: string | null; outcome: string | null };
    expect(attempt.outcome).toBe("error_loop");
    expect(attempt.ended_at).toBeTruthy();
  });

  it("оставляет владельцу запись в карточке, уведомление и событие", async () => {
    const { taskId, subtaskId } = await setupTaskWithPlan(app);
    startAttempt(taskId, subtaskId);
    seedErrors(taskId, subtaskId, 4);

    await runStalledStepWatch();

    const notes = db
      .prepare("SELECT text FROM comments WHERE task_id = ?")
      .all(taskId) as Array<{ text: string }>;
    expect(
      notes.some((n) => /неверных вызовов taskflow_work_plan/.test(n.text)),
    ).toBe(true);

    const notif = db
      .prepare(
        "SELECT text FROM notifications WHERE task_id = ? AND type = 'error_loop_blocked'",
      )
      .all(taskId) as Array<{ text: string }>;
    expect(notif.length).toBe(1);
    expect(notif[0].text).toMatch(/неверных вызовов/);

    const events = db
      .prepare(
        "SELECT kind FROM task_events WHERE task_id = ? AND kind = 'subtask_error_loop_blocked'",
      )
      .all(taskId);
    expect(events.length).toBe(1);
  });

  it("не трогает ход, у которого были успешные вызовы", async () => {
    const { taskId, subtaskId } = await setupTaskWithPlan(app);
    const attemptId = startAttempt(taskId, subtaskId);
    seedErrors(taskId, subtaskId, 3);
    // Роль работала: успешный вызов есть — это не цикл, а обычная работа.
    seedOk(taskId, subtaskId);

    const report = await runStalledStepWatch();
    expect(report.blocked).toBe(0);

    const step = db
      .prepare("SELECT agent_state, current_attempt_id FROM subtasks WHERE id = ?")
      .get(subtaskId) as { agent_state: string | null; current_attempt_id: string | null };
    expect(step.agent_state).toBe("in_progress");
    expect(step.current_attempt_id).toBe(attemptId);
  });

  // P0/B1 (карточка e73e7314): служебные отказы — не вина роли. Уточнение
  // посреди хода, устаревший ход и закрытый чек-лист раньше гасили живой шаг.
  it("три служебных отказа не блокируют шаг", async () => {
    const { taskId, subtaskId } = await setupTaskWithPlan(app);
    const attemptId = startAttempt(taskId, subtaskId);
    seedErrors(taskId, subtaskId, 1, "taskflow_work_plan", "STEERING_REFUSAL");
    seedErrors(taskId, subtaskId, 1, "taskflow_work_plan", "CHAT_RUN_STALE");
    seedErrors(taskId, subtaskId, 1, "taskflow_work_plan", "CHAT_PLAN_CLOSED");

    const stats = toolOutcomeStats(subtaskId, 10);
    expect(stats.errors).toBe(0);
    expect(stats.serviceRefusals).toBe(3);

    const report = await runStalledStepWatch();
    expect(report.blocked).toBe(0);
    const step = db
      .prepare("SELECT agent_state, current_attempt_id FROM subtasks WHERE id = ?")
      .get(subtaskId) as { agent_state: string | null; current_attempt_id: string | null };
    expect(step.agent_state).toBe("in_progress");
    expect(step.current_attempt_id).toBe(attemptId);
  });

  // Цикл — это три отказа ОДНОЙ операции: промах в трёх разных инструментах
  // не признак зацикливания.
  it("три отказа разных операций не считаются циклом", async () => {
    const { taskId, subtaskId } = await setupTaskWithPlan(app);
    const attemptId = startAttempt(taskId, subtaskId);
    seedErrors(taskId, subtaskId, 1, "taskflow_work_plan");
    seedErrors(taskId, subtaskId, 1, "taskflow_comment");
    seedErrors(taskId, subtaskId, 1, "taskflow_task");

    const stats = toolOutcomeStats(subtaskId, 10);
    expect(stats.errors).toBe(3);
    expect(stats.loopErrors).toBe(1);

    const report = await runStalledStepWatch();
    expect(report.blocked).toBe(0);
    const step = db
      .prepare("SELECT agent_state, current_attempt_id FROM subtasks WHERE id = ?")
      .get(subtaskId) as { agent_state: string | null; current_attempt_id: string | null };
    expect(step.agent_state).toBe("in_progress");
    expect(step.current_attempt_id).toBe(attemptId);
  });

  // Успешные вызовы теперь лежат строкой в учёте, поэтому «ok = 0» больше не
  // получается само собой: живой ход с отказами не гасится.
  it("успешные вызовы в учёте видны сторожу и снимают подозрение в цикле", async () => {
    const { taskId, subtaskId } = await setupTaskWithPlan(app);
    startAttempt(taskId, subtaskId);
    seedErrors(taskId, subtaskId, 3);
    seedOk(taskId, subtaskId, 4);

    const stats = toolOutcomeStats(subtaskId, 10);
    expect(stats.ok).toBe(4);
    expect(stats.errors).toBe(3);

    const report = await runStalledStepWatch();
    expect(report.blocked).toBe(0);
  });
});
