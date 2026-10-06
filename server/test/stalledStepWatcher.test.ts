// Сторож зависших шагов: один порог 10 минут (настраивается через
// TASKFLOW_STALL_AFTER_MIN). Сигнал «жива» — mtime свежего `.jsonl` в
// `~/.local/state/taskflow-runs/sessions/<task>-<role>-<step>/` (поток
// событий хода). Нет потока — автоперезапуск (≤ 2 за окно), затем
// blocked + снимок + уведомление (карточка 71651ad0, поправки
// оркестратора 17:01–17:06).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const runs = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
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
import { runStalledStepWatch } from "../src/runtime/stalledStepWatcher.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

const sessionsDir = path.join(os.tmpdir(), `stalled-test-sessions-${process.pid}`);

type Subtask = {
  id: string;
  task_id: string;
  title: string;
  agent_state: string | null;
  current_attempt_id: string | null;
  agent_heartbeat_at: string | null;
};

type Task = { id: string };

async function setupTaskWithPlan(app: FastifyInstance): Promise<{ task: Task; subtaskId: string; auth: { authorization: string } }> {
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Stalled owner", email: `stalled-${Date.now()}-${Math.random()}@test`, password: "password123" } });
  const userId = reg.json().user.id;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(userId);
  const auth = { authorization: `Bearer ${reg.json().token}` };
  db.prepare("UPDATE users SET task_intake_mode='manual' WHERE role='owner'").run();
  const task = await app.inject({ method: "POST", url: "/api/tasks", headers: auth, payload: { title: "Stalled fixture" } });
  const taskId = task.json().task.id;
  const plan = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/collaboration-plans`,
    headers: auth,
    payload: { profile: "manual", rationale: "тест", nodes: [{ slot_key: "executor", role_key: "builder", required: true, expected_result: "Реализация" }], edges: [] },
  });
  expect(plan.statusCode).toBeLessThan(300);
  const approve = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${plan.json().id ?? plan.json().plan?.id}/approve`, headers: auth });
  expect(approve.statusCode).toBeLessThan(300);
  const row = db.prepare("SELECT id FROM subtasks WHERE task_id = ? AND plan_node_key = 'executor'").get(taskId) as { id: string };
  return { task: { id: taskId }, subtaskId: row.id, auth };
}

function subtask(id: string): Subtask {
  return db.prepare("SELECT id, task_id, title, agent_state, current_attempt_id, agent_heartbeat_at FROM subtasks WHERE id = ?").get(id) as Subtask;
}

const comments = (taskId: string): Array<{ user_id: string; text: string }> => {
  return (db.prepare("SELECT user_id, text FROM comments WHERE task_id = ? ORDER BY rowid").all(taskId) as Array<{ user_id: string; text: string }>);
};

const notifications = (kind: string): Array<{ text: string }> => {
  return db.prepare("SELECT text FROM notifications WHERE type = ?").all(kind) as Array<{ text: string }>;
};

/** Создать «журнал» потока событий: каталог с одним .jsonl, mtime которого
 *  отстоит от текущего момента на `minutesAgo` минут. */
function seedSessionJournal(taskId: string, role: string, slot: string, minutesAgo: number): void {
  const dir = path.join(sessionsDir, `${taskId}-${role}-${slot}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-01-01T00-00-00-000Z_test-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, "{\"step\":\"test\"}\n");
  const mtime = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(file, mtime, mtime);
}

function cleanupFixture(taskId: string): void {
  // Каскад по task_id: subtasks (CASCADE), потом plan tables, deps,
  // notifications, role_run_jobs, slot_work_snapshots, task_events,
  // comments, attempts, branch_plan_members.
  db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(taskId);
  db.prepare(`DELETE FROM task_collaboration_plan_edges WHERE plan_id IN
    (SELECT id FROM task_collaboration_plans WHERE task_id = ?)`).run(taskId);
  db.prepare(`DELETE FROM task_collaboration_plan_nodes WHERE plan_id IN
    (SELECT id FROM task_collaboration_plans WHERE task_id = ?)`).run(taskId);
  db.prepare(`DELETE FROM task_collaboration_plans WHERE task_id = ?`).run(taskId);
  db.prepare(`DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?`).run(taskId, taskId);
  db.prepare(`DELETE FROM branch_plan_members WHERE task_id = ?`).run(taskId);
  db.prepare("DELETE FROM attempts WHERE task_id = ?").run(taskId);
  db.prepare("DELETE FROM comments WHERE task_id = ?").run(taskId);
  db.prepare("DELETE FROM notifications WHERE task_id = ?").run(taskId);
  db.prepare("DELETE FROM slot_work_snapshots WHERE task_id = ?").run(taskId);
  db.prepare("DELETE FROM task_events WHERE task_id = ?").run(taskId);
  db.prepare("DELETE FROM role_run_jobs WHERE task_id = ?").run(taskId);
  db.prepare("DELETE FROM tasks WHERE title = 'Stalled fixture'").run();
  for (const dir of fs.readdirSync(sessionsDir)) {
    if (dir.startsWith(`${taskId}-`)) {
      fs.rmSync(path.join(sessionsDir, dir), { recursive: true, force: true });
    }
  }
}

describe("stalledStepWatcher", () => {
  let app: FastifyInstance;
  let fixture: { task: Task; subtaskId: string; auth: { authorization: string } };

  beforeAll(async () => {
    // Подменяем путь к сессиям на временную папку, чтобы тест не
    // зависел от живого Pi-runtime и не загрязнял реальный кэш.
    process.env.TASKFLOW_SESSIONS_DIR = sessionsDir;
    fs.mkdirSync(sessionsDir, { recursive: true });
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    // Перед всеми тестами: сбрасываем любые in_progress subtasks, чтобы
    // прошлые запуски этого теста (или соседние test'ы) не подкидывали
    // свои узлы в сторож. Штатные in_progress-узлы других ролей нам
    // не интересны — мы смотрим только плановые.
    db.prepare(
      `UPDATE subtasks
          SET agent_state = 'todo', agent_id = NULL, current_attempt_id = NULL, agent_heartbeat_at = NULL
        WHERE collaboration_plan_id IS NOT NULL`,
    ).run();
  });

  beforeEach(async () => {
    db.prepare("DELETE FROM notifications WHERE type = 'stalled_blocked'").run();
    db.prepare("DELETE FROM task_events WHERE kind LIKE 'stalled_step_%'").run();
    // Сначала снимаем аренду со ВСЕХ плановых subtasks, чтобы FK на
    // agent_id/current_attempt_id не упёрся при удалении задач.
    db.prepare(
      `UPDATE subtasks
          SET agent_state = 'todo', agent_id = NULL, current_attempt_id = NULL, agent_heartbeat_at = NULL
        WHERE collaboration_plan_id IS NOT NULL`,
    ).run();
    // Затем удаляем все Stalled fixture'ы каскадом.
    db.prepare("DELETE FROM attempts WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture')").run();
    db.prepare("DELETE FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture')").run();
    db.prepare("DELETE FROM notifications WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture')").run();
    db.prepare("DELETE FROM slot_work_snapshots WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture')").run();
    db.prepare("DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture')").run();
    db.prepare("DELETE FROM role_run_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture')").run();
    db.prepare("DELETE FROM branch_plan_members WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture')").run();
    db.prepare("DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture') OR depends_on_task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture')").run();
    db.prepare("DELETE FROM subtasks WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture')").run();
    db.prepare("DELETE FROM task_collaboration_plan_edges WHERE plan_id IN (SELECT id FROM task_collaboration_plans WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture'))").run();
    db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id IN (SELECT id FROM task_collaboration_plans WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture'))").run();
    db.prepare("DELETE FROM task_collaboration_plans WHERE task_id IN (SELECT id FROM tasks WHERE title = 'Stalled fixture')").run();
    db.prepare("DELETE FROM tasks WHERE title = 'Stalled fixture'").run();
    // Подчищаем каталоги сессий от прошлых fixture'ов.
    if (fs.existsSync(sessionsDir)) {
      for (const dir of fs.readdirSync(sessionsDir)) {
        fs.rmSync(path.join(sessionsDir, dir), { recursive: true, force: true });
      }
    }
    fixture = await setupTaskWithPlan(app);
  });

  afterAll(async () => {
    await app.close();
    try { fs.rmSync(sessionsDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("живой поток (mtime 3 минуты) — сторож не трогает узел", async () => {
    seedSessionJournal(fixture.task.id, "builder", "executor", 3);
    const before = comments(fixture.task.id).length;
    const report = await runStalledStepWatch();
    // Узел в выборке, но действий сторож не предпринимает.
    expect(report.stalled).toBe(1);
    expect(report.restarted).toBe(0);
    expect(report.blocked).toBe(0);
    expect(comments(fixture.task.id).length).toBe(before);
    expect(subtask(fixture.subtaskId).agent_state).toBe("in_progress");
  });

  it("поток молчит 12 минут, перезапусков < 2: автоперезапуск, новый dedupe_key, узел продолжен", async () => {
    seedSessionJournal(fixture.task.id, "builder", "executor", 12);
    // Имитируем предыдущий перезапуск, чтобы счётчик показал «1 из 2».
    db.prepare(
      `INSERT INTO attempts(id, task_id, subtask_id, executor_id, started_at, ended_at, outcome, reason)
       VALUES(?, ?, ?, ?, datetime('now', '-90 minutes'), datetime('now', '-90 minutes'), 'auto_restarted', 'setup')`,
    ).run(`att_setup_${Date.now()}`, fixture.task.id, fixture.subtaskId, roleUserId("builder"));
    const beforeAttempt = subtask(fixture.subtaskId).current_attempt_id;
    const report = await runStalledStepWatch();
    expect(report.stalled).toBe(1);
    expect(report.restarted).toBe(1);
    expect(report.blocked).toBe(0);
    const after = subtask(fixture.subtaskId);
    expect(after.current_attempt_id).not.toBe(beforeAttempt);
    expect(after.agent_state).toBe("in_progress");
    // role_run_jobs этой задачи: должен лежать queued-свежий job с новым dedupe_key.
    const job = db.prepare(
      "SELECT status, attempts, dedupe_key FROM role_run_jobs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(fixture.task.id) as { status: string; attempts: number; dedupe_key: string };
    expect(job).toBeTruthy();
    expect(job.dedupe_key).toMatch(/^stalled-restart:/);
    // Лента: запись о перезапуске.
    const last = comments(fixture.task.id).at(-1)!;
    expect(last.text).toMatch(/перезапускаю попытку/);
  });

  it("2 автоперезапуска уже были — третий обход ставит узел в blocked и уведомляет владельца", async () => {
    seedSessionJournal(fixture.task.id, "builder", "executor", 30);
    // Имитируем два предыдущих перезапуска в окне.
    const ins = db.prepare(
      `INSERT INTO attempts(id, task_id, subtask_id, executor_id, started_at, ended_at, outcome, reason)
       VALUES(?, ?, ?, ?, datetime('now', ?), datetime('now', ?), 'auto_restarted', 'setup')`,
    );
    ins.run(`att_setup_a_${Date.now()}`, fixture.task.id, fixture.subtaskId, roleUserId("builder"), "-110 minutes", "-110 minutes");
    ins.run(`att_setup_b_${Date.now()}_b`, fixture.task.id, fixture.subtaskId, roleUserId("builder"), "-60 minutes", "-60 minutes");
    const report = await runStalledStepWatch();
    expect(report.stalled).toBe(1);
    expect(report.blocked).toBe(1);
    expect(report.restarted).toBe(0);
    const after = subtask(fixture.subtaskId);
    expect(after.agent_state).toBe("blocked");
    // Уведомление владельцу.
    const notes = notifications("stalled_blocked");
    expect(notes.length).toBe(1);
    // `roleTitle('builder')` отдаёт «Разработчик» в живой локали.
    expect(notes[0].text).toMatch(/Разработчик/);
    // Снимок слота записан.
    const snap = db.prepare("SELECT reason, blocker FROM slot_work_snapshots WHERE subtask_id = ? ORDER BY rowid DESC LIMIT 1").get(fixture.subtaskId) as { reason: string; blocker: string };
    expect(snap.reason).toBe("blocked");
    expect(snap.blocker).toMatch(/событий/);
  });

  it("журнал сессии ещё не создан (узел только что стартовал) — сторож ждёт", async () => {
    db.prepare("UPDATE subtasks SET agent_heartbeat_at = datetime('now', '-1 minutes') WHERE id = ?").run(fixture.subtaskId);
    const before = comments(fixture.task.id).length;
    const report = await runStalledStepWatch();
    // Узел в выборке (он in_progress), но действий нет.
    expect(report.stalled).toBe(1);
    expect(report.restarted).toBe(0);
    expect(report.blocked).toBe(0);
    expect(comments(fixture.task.id).length).toBe(before);
    expect(subtask(fixture.subtaskId).agent_state).toBe("in_progress");
  });
});
