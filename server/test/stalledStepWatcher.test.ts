// Сторож зависших шагов: один порог 10 минут (настраивается через
// TASKFLOW_STALL_AFTER_MIN). Сигнал «жива» — mtime свежего `.jsonl` в
// `~/.local/state/taskflow-runs/sessions/<task>-<role>-<step>/` (поток
// событий хода). Нет потока — автоперезапуск (≤ 2 за окно), затем
// blocked + снимок + уведомление (карточка 71651ad0, поправки
// оркестратора 17:01–17:06).
import { execFileSync } from "node:child_process";
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

// Упавший старт новой попытки — отдельный сценарий уведомления
// (`stalled_restart_failed`), флагом включается только в нужном тесте.
// `holdSlot` воспроизводит обрыв боевой цепочки: слот держит умерший
// запуск, `acquireSlotSession` ждёт его `release()` и не разрешается
// никогда — подтверждения старта не будет (дефект D1).
const admission = vi.hoisted(() => ({ failNext: false, holdSlot: false }));
vi.mock("../src/runtime/planSubtaskAdmission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/planSubtaskAdmission.js")>();
  return {
    ...actual,
    startPlanSubtaskRun: async (subtaskId: string, actorId: string) => {
      if (admission.failNext) return { ok: false as const, error: "слот держит мёртвый запуск" };
      if (admission.holdSlot) {
        const { acquireSlotSession } = await import("../src/runtime/slotSession.js");
        // Живая аренда слота, а не заглушка: тест сам занимает её первым,
        // здесь мы ждём чужой `release()`, которого не будет.
        await acquireSlotSession(subtaskId);
        return await new Promise<never>(() => {});
      }
      // Не запускаем модель: её свежая активность маскирует состаренный журнал.
      const { default: db } = await import("../src/db.js");
      const row = db.prepare("SELECT s.task_id,n.role_key FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key WHERE s.id=?").get(subtaskId) as {task_id:string;role_key:string};
      const attemptId = "watch-test-" + Math.random().toString(36).slice(2);
      db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at) VALUES(?,?,?,?,datetime('now'))").run(attemptId,row.task_id,subtaskId,"role_"+row.role_key);
      db.prepare("UPDATE subtasks SET current_attempt_id=?,agent_id=?,agent_state='in_progress',agent_heartbeat_at=datetime('now') WHERE id=?").run(attemptId,"role_"+row.role_key,subtaskId);
      return {ok:true as const,runId:attemptId};
    },
  };
});

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { roleUserId } from "../src/roleRouting.js";
import { runStalledStepWatch } from "../src/runtime/stalledStepWatcher.js";
import { slotSessionDirectory, acquireSlotSession, forceReleaseSlotSession } from "../src/runtime/slotSession.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

// Каталог сессий берём из того же корня, что и боевой `slotSessionDirectory`
// (TASKFLOW_RUNS_DIR/sessions) — так раскладка пути в тесте совпадает с
// production, а не выдумана руками.
const sessionsDir = path.join(process.env.TASKFLOW_RUNS_DIR ?? os.tmpdir(), "sessions");

// Рабочая копия шага для снимка git: событие «шаг брошен» берёт git-снимок из
// cwd из `slot_sessions`, поэтому в фикстуре нужен настоящий git-репозиторий.
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

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

/** Сообщения сторожа оркестратору: личный чат «Заминки команды». */
// Заминки — сессия на задачу (`wake:<task_id>`, 21.10.2026).
const ORCH_CHAT = "wake:%";
const orchMessages = (): Array<{ id: string; text: string; task_id: string }> =>
  db.prepare("SELECT id, text, task_id FROM chat_messages WHERE chat_id LIKE ? ORDER BY rowid").all(ORCH_CHAT) as Array<{ id: string; text: string; task_id: string }>;
const orchQueue = (): Array<{ delivery_id: string; role_id: string; status: string }> =>
  db.prepare("SELECT delivery_id, role_id, status FROM chat_message_queue WHERE chat_id LIKE ? ORDER BY rowid").all(ORCH_CHAT) as Array<{ delivery_id: string; role_id: string; status: string }>;

/** Создать «журнал» потока событий: каталог с одним .jsonl, mtime которого
 *  отстоит от текущего момента на `minutesAgo` минут. `step` — реальный
 *  ключ каталога сессии: UUID подзадачи (`inProcessRun.sessionDir`), а не
 *  `plan_node_key` (дефект D1, 06.10.2026). Путь берём из боевой
 *  `slotSessionDirectory`, чтобы тест не разошёлся с production-раскладкой. */
function seedSessionJournal(taskId: string, role: string, step: string, minutesAgo: number): void {
  const dir = slotSessionDirectory(taskId, role, step);
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
  let workRepo: string;

  beforeAll(async () => {
    // Подменяем путь к сессиям на временную папку, чтобы тест не
    // зависел от живого Pi-runtime и не загрязнял реальный кэш.
    process.env.TASKFLOW_RUNS_DIR = path.dirname(sessionsDir);
    process.env.TASKFLOW_SESSIONS_DIR = sessionsDir;
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Настоящий git-репозиторий: без него git_snapshot в событии был бы null,
    // и критерий «в нём есть хвост и снимок git» не проверялся бы (MAK-97).
    workRepo = fs.mkdtempSync(path.join(os.tmpdir(), "stalled-repo-"));
    git(workRepo, ["init", "-b", "main"]);
    git(workRepo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"]);
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    // Уведомление сторожа адресовано учётке `role_code_orchestrator`
    // (`roleUserId('code_orchestrator')`), а общий `seedRoleAccounts` её не
    // сеет — без неё побудка молча возвращает null и тест был бы зелёным
    // вхолостую.
    db.prepare(
      `INSERT OR IGNORE INTO users (id,name,email,password_hash,role,role_key,type,avatar_color,initials,status,is_system_bot)
       VALUES ('role_code_orchestrator','Code Orchestrator','orchestrator@taskflow.local','','agent',NULL,'ai','#8E8E93','O','offline',1)`,
    ).run();
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
    admission.failNext = false;
    admission.holdSlot = false;
    delete process.env.TASKFLOW_STALLED_START_WAIT_MS;
    db.prepare("DELETE FROM notifications WHERE type = 'stalled_blocked'").run();
    db.prepare("DELETE FROM task_events WHERE kind LIKE 'stalled_step_%'").run();
    // Уведомления сторожа живут в личном чате оркестратора и не каскадом
    // чистятся вместе с карточкой — снимаем их на каждый тест, иначе
    // счётчики «ровно одно сообщение» копятся между кейсами.
    db.prepare("DELETE FROM chat_message_queue WHERE chat_id LIKE 'wake:%'").run();
    db.prepare("DELETE FROM chat_messages WHERE chat_id LIKE 'wake:%'").run();
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
    try { fs.rmSync(workRepo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("архивный зависший шаг не создаёт перезапуск и не меняет состояние", async () => {
    db.prepare("UPDATE tasks SET archived_at=datetime('now') WHERE id=?").run(fixture.task.id);
    const before = db.prepare("SELECT agent_state,current_attempt_id FROM subtasks WHERE id=?").get(fixture.subtaskId);
    const count = db.prepare("SELECT count(*) n FROM role_run_jobs WHERE task_id=?").get(fixture.task.id);
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    await runStalledStepWatch();
    expect(db.prepare("SELECT agent_state,current_attempt_id FROM subtasks WHERE id=?").get(fixture.subtaskId)).toEqual(before);
    expect(db.prepare("SELECT count(*) n FROM role_run_jobs WHERE task_id=?").get(fixture.task.id)).toEqual(count);
  });

  it("живой поток (mtime 3 минуты) — сторож не трогает узел", async () => {
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 3);
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
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
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
    // Технический перезапуск не создаёт комментарий.
    expect(comments(fixture.task.id)).toHaveLength(0);
  });

  // Карточка 568a2b93: лавина заданий очереди ролей. Ключ дедупликации
  // автоперезапуска стабилен на шаг, поэтому две остановки подряд дают
  // ОДНО задание в очереди, а не два.
  it("две остановки подряд — одно задание в очереди ролей, ключ дедупликации стабильный", async () => {
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    const first = await runStalledStepWatch();
    expect(first.restarted).toBe(1);
    // Роль не поднялась (журнал молчит) — второй тик сторожа.
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    const second = await runStalledStepWatch();
    expect(second.restarted).toBe(1);

    const jobs = db
      .prepare(
        "SELECT dedupe_key FROM role_run_jobs WHERE task_id = ? AND dedupe_key LIKE 'stalled-restart:%'",
      )
      .all(fixture.task.id) as Array<{ dedupe_key: string }>;
    expect(jobs.length).toBe(1);
    expect(jobs[0].dedupe_key).toBe(`stalled-restart:${fixture.subtaskId}`);
  });

  // Лимит автоперезапусков обязан считать САМИ перезапуски. Раньше счётчик
  // смотрел только на закрытые попытки: если попытки не было, лимит не
  // достигался НИКОГДА и сторож плодил задания (лава очереди ролей).
  it("лимит автоперезапуска считается по факту перезапусков, даже без закрытых попыток", async () => {
    // Два прошлых автоперезапуска — только события ленты, без попыток.
    const ins = db.prepare(
      `INSERT INTO task_events(id, task_id, kind, field, from_value, to_value, created_at)
       VALUES(?, ?, 'stalled_step_auto_restart', 'executor', NULL, 'setup', datetime('now', ?))`,
    );
    ins.run(`te_setup_a_${Date.now()}`, fixture.task.id, "-30 minutes");
    ins.run(`te_setup_b_${Date.now()}_b`, fixture.task.id, "-20 minutes");
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 30);

    const report = await runStalledStepWatch();

    expect(report.blocked).toBe(1);
    expect(report.restarted).toBe(0);
    expect(subtask(fixture.subtaskId).agent_state).toBe("blocked");
    const jobs = db
      .prepare(
        "SELECT count(*) AS n FROM role_run_jobs WHERE task_id = ? AND dedupe_key LIKE 'stalled-restart:%'",
      )
      .get(fixture.task.id) as { n: number };
    expect(jobs.n).toBe(0);
  });

  it("2 автоперезапуска уже были — третий обход ставит узел в blocked и уведомляет владельца", async () => {
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 30);
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

  // Живой прогон MAK-97: зависший ход (журнал молчит, перезапуски исчерпаны)
  // оставляет в ленте событие «шаг брошен» с хвостом журнала хода и снимком
  // git рабочей копии — получателю видно, где шаг остановился.
  it("блок зависшего шага несёт событие «шаг брошен» с хвостом журнала и снимком git", async () => {
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 30);
    // cwd шага → снимок git берётся из этой записи (как в боевом inProcessRun).
    db.prepare("INSERT INTO slot_sessions(subtask_id, session_file, cwd, session_id) VALUES(?,?,?,?)")
      .run(fixture.subtaskId, path.join(workRepo, "session.jsonl"), workRepo, "s1");
    const ins = db.prepare(
      `INSERT INTO attempts(id, task_id, subtask_id, executor_id, started_at, ended_at, outcome, reason)
       VALUES(?, ?, ?, ?, datetime('now', ?), datetime('now', ?), 'auto_restarted', 'setup')`,
    );
    ins.run(`att_ab_a_${Date.now()}`, fixture.task.id, fixture.subtaskId, roleUserId("builder"), "-110 minutes", "-110 minutes");
    ins.run(`att_ab_b_${Date.now()}`, fixture.task.id, fixture.subtaskId, roleUserId("builder"), "-60 minutes", "-60 minutes");
    const report = await runStalledStepWatch();
    expect(report.blocked).toBe(1);

    const rows = db.prepare("SELECT to_value FROM task_events WHERE task_id = ? AND kind = 'step_abandoned'").all(fixture.task.id) as Array<{ to_value: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].to_value) as { reason: string; journal_tail: string | null; git_snapshot: string | null; slot_key: string | null };
    expect(payload.slot_key).toBe("executor");
    expect(payload.reason).toMatch(/лимит автоперезапуска/);
    expect(payload.journal_tail).toContain('"step":"test"');
    expect(payload.git_snapshot).toMatch(/^main @ /);
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

  it("реальная раскладка inProcessRun: свежий журнал в каталоге с UUID подзадачи (не plan_node_key) отменяет рестарт", async () => {
    // Дефект D1: inProcessRun пишет журнал в <task>-<role>-<UUID>, а
    // сторож искал <task>-<role>-<plan_node_key>. Если UUID не учтён,
    // при старом heartbeat узел уйдёт в автоперезапуск.
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 1);
    db.prepare("UPDATE subtasks SET agent_heartbeat_at = datetime('now', '-45 minutes') WHERE id = ?").run(fixture.subtaskId);
    const before = comments(fixture.task.id).length;
    const report = await runStalledStepWatch();
    expect(report.stalled).toBe(1);
    expect(report.restarted).toBe(0);
    expect(report.blocked).toBe(0);
    expect(comments(fixture.task.id).length).toBe(before);
    expect(subtask(fixture.subtaskId).agent_state).toBe("in_progress");
  });


  it("авторестарт сохраняется без комнаты Заминок и запуска оркестратора", async () => {
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    expect((await runStalledStepWatch()).restarted).toBe(1);
    expect(orchMessages()).toHaveLength(0);
    expect(orchQueue()).toHaveLength(0);
    expect(db.prepare("SELECT id FROM chats WHERE id=?").get("wake:" + fixture.task.id)).toBeUndefined();
  });

  it("автоблок сохраняет Входящие владельца без побудки оркестратора", async () => {
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 30);
    const ins = db.prepare(`INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at,ended_at,outcome,reason)
      VALUES(?,?,?,?,datetime('now',?),datetime('now',?),'auto_restarted','setup')`);
    ins.run("no-wake-a",fixture.task.id,fixture.subtaskId,roleUserId("builder"),"-110 minutes","-110 minutes");
    ins.run("no-wake-b",fixture.task.id,fixture.subtaskId,roleUserId("builder"),"-60 minutes","-60 minutes");
    expect((await runStalledStepWatch()).blocked).toBe(1);
    expect(subtask(fixture.subtaskId).agent_state).toBe("blocked");
    expect(notifications("stalled_blocked")).toHaveLength(1);
    expect(orchMessages()).toHaveLength(0);
    expect(orchQueue()).toHaveLength(0);
  });

  it("отказ старта остаётся в журнале без очереди оркестратора", async () => {
    admission.failNext = true;
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    expect((await runStalledStepWatch()).restarted).toBe(1);
    expect(db.prepare("SELECT id FROM task_events WHERE task_id=? AND kind='stalled_step_restart_failed'").get(fixture.task.id)).toBeDefined();
    expect(orchMessages()).toHaveLength(0);
    expect(orchQueue()).toHaveLength(0);
  });

  it("занятая аренда не останавливает сторож и не создаёт Заминки", async () => {
    const holder = await acquireSlotSession(fixture.subtaskId);
    admission.holdSlot = true;
    process.env.TASKFLOW_STALLED_START_WAIT_MS = "80";
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    try {
      const report = await Promise.race([
        runStalledStepWatch(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
      ]);
      expect(report).not.toBeNull();
      expect(report!.restarted).toBe(1);
      expect(db.prepare("SELECT id FROM task_events WHERE task_id=? AND kind='stalled_step_restart_pending'").get(fixture.task.id)).toBeDefined();
      expect(orchMessages()).toHaveLength(0);
      expect(orchQueue()).toHaveLength(0);
    } finally {
      admission.holdSlot = false;
      holder();
      forceReleaseSlotSession(fixture.subtaskId);
    }
  });
});
