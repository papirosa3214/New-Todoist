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
      return actual.startPlanSubtaskRun(subtaskId, actorId);
    },
  };
});

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { roleUserId } from "../src/roleRouting.js";
import { runStalledStepWatch } from "../src/runtime/stalledStepWatcher.js";
import { wakeOrchestratorStalled } from "../src/runtime/orchestratorWake.js";
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
const ORCH_CHAT = `orchestrator-wake:${roleUserId("code_orchestrator")}`;
const orchMessages = (): Array<{ id: string; text: string; task_id: string }> =>
  db.prepare("SELECT id, text, task_id FROM chat_messages WHERE chat_id = ? ORDER BY rowid").all(ORCH_CHAT) as Array<{ id: string; text: string; task_id: string }>;
const orchQueue = (): Array<{ delivery_id: string; role_id: string; status: string }> =>
  db.prepare("SELECT delivery_id, role_id, status FROM chat_message_queue WHERE chat_id = ? ORDER BY rowid").all(ORCH_CHAT) as Array<{ delivery_id: string; role_id: string; status: string }>;

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
    db.prepare("DELETE FROM chat_message_queue WHERE chat_id LIKE 'orchestrator-wake:%'").run();
    db.prepare("DELETE FROM chat_messages WHERE chat_id LIKE 'orchestrator-wake:%'").run();
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
    // Лента: запись о перезапуске.
    const last = comments(fixture.task.id).at(-1)!;
    expect(last.text).toMatch(/перезапускаю попытку/);
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

  /* ── Уведомление оркестратору о зависании (карточка 2beb2bf2, контракт fc0ea9a6) ──
   *
   * Суть правки — убрать зависимость от профиля плана: фикстура здесь
   * профиля `manual`, а `wakeOrchestrator` смотрит только `orchestrated`.
   * Если этот кейс снова станет зелёным «вхолостую», значит сообщение
   * уходит мимо проверки. */

  it("план не orchestrated: авторестарт всё равно пишет оркестратору ровно одно сообщение в его чат", async () => {
    const profile = db.prepare("SELECT profile FROM task_collaboration_plans WHERE id = (SELECT collaboration_plan_id FROM subtasks WHERE id = ?)").get(fixture.subtaskId) as { profile: string };
    expect(profile.profile).not.toBe("orchestrated");
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    const commonBefore = (db.prepare("SELECT count(*) n FROM chat_messages WHERE chat_id='chat-common'").get() as { n: number }).n;
    const report = await runStalledStepWatch();
    expect(report.restarted).toBe(1);
    const messages = orchMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toMatch(/^orch-stalled_restarted:/);
    expect(messages[0].task_id).toBe(fixture.task.id);
    // Карточка, шаг, роль и что произошло — всё в одном сообщении.
    expect(messages[0].text).toContain("Stalled fixture");
    expect(messages[0].text).toContain(fixture.task.id);
    expect(messages[0].text).toContain(fixture.subtaskId);
    expect(messages[0].text).toContain("executor");
    expect(messages[0].text).toMatch(/Разработчик/);
    expect(messages[0].text).toMatch(/поток событий молчал|поток собы/i);
    // Доставка адресована оркестратору как роль, не владельцу.
    const queue = orchQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].role_id).toBe(roleUserId("code_orchestrator"));
    expect(queue[0].status).toBe("pending");
    expect(queue[0].delivery_id).toBe(messages[0].id);
    // В общий чат событие сторожа не попало: счётчик не вырос и текста
    // про зависание там нет.
    expect((db.prepare("SELECT count(*) n FROM chat_messages WHERE chat_id='chat-common'").get() as { n: number }).n).toBe(commonBefore);
    expect((db.prepare("SELECT count(*) n FROM chat_messages WHERE chat_id='chat-common' AND text LIKE '%поток событий молчал%'").get() as { n: number }).n).toBe(0);
  });

  it("повторный обход на ту же уже закрытую попытку — второго сообщения нет", async () => {
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    await runStalledStepWatch();
    const first = orchMessages();
    expect(first).toHaveLength(1);
    const attemptId = first[0].id.replace("orch-stalled_restarted:", "");
    // Тот же узел снова «завис» на той же закрытой попытке: закрыть её
    // повторно нельзя (`ended_at IS NULL`), значит и сообщения быть не должно.
    db.prepare("UPDATE subtasks SET agent_state='in_progress', current_attempt_id=? WHERE id=?").run(attemptId, fixture.subtaskId);
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    await runStalledStepWatch();
    expect(orchMessages()).toHaveLength(1);
    expect(orchQueue()).toHaveLength(1);
  });

  it("детерминированный messageId: тот же ключ события после пересборки не плодит сообщения", async () => {
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    await runStalledStepWatch();
    const key = orchMessages()[0].id.replace("orch-stalled_restarted:", "");
    const again = wakeOrchestratorStalled(fixture.subtaskId, "stalled_restarted", key, "повтор того же события");
    expect(again).not.toBeNull();
    expect(again!.messageId).toBe(`orch-stalled_restarted:${key}`);
    const messages = orchMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).not.toContain("повтор того же события");
    expect(orchQueue()).toHaveLength(1);
  });

  it("упавший старт новой попытки — после сообщения о зависании приходит stalled_restart_failed с текстом ошибки", async () => {
    admission.failNext = true;
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    const report = await runStalledStepWatch();
    expect(report.restarted).toBe(1);
    const messages = orchMessages();
    // Первым уходит сообщение о самом зависании — его результат от
    // старта не зависит, второй несёт уже отказ перезапуска.
    expect(messages).toHaveLength(2);
    const key = messages[0].id.replace("orch-stalled_restarted:", "");
    expect(messages[0].id).toBe(`orch-stalled_restarted:${key}`);
    expect(messages[1].id).toBe(`orch-stalled_restart_failed:${key}`);
    expect(messages[1].text).toContain("Запуск не удался");
    expect(messages[1].text).toContain("слот держит мёртвый запуск");
    expect(orchQueue()).toHaveLength(2);
  });

  // Дефект D1 (ревью критика 16.10.2026): уведомление было написано в
  // .then() ПОСЛЕ await startPlanSubtaskRun, а тот ждёт аренду слота.
  // Умерший держатель слота не отпускает аренду никогда — сообщения не
  // было вовсе, а тик сторожа не завершался и тот же флаг busy не
  // сбрасывался: сторож переставал смотреть за всеми узлами до рестарта
  // сервера. Ниже — боевая форма: аренду действительно держит «мёртвый»
  // запуск (тест занимает её первым и не отпускает).
  it("занятая аренда слота: уведомление уходит сразу, тик не замирает, отказ приходит отдельным сообщением", async () => {
    const holder = await acquireSlotSession(fixture.subtaskId);
    admission.holdSlot = true;
    // Предел ожидания подтверждения старта уменьшаем, чтобы тест не ждал
    // боевые 4 секунды; проверяется сам факт «тик не завис намертво».
    process.env.TASKFLOW_STALLED_START_WAIT_MS = "80";
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 12);
    const started = Date.now();
    const raced = await Promise.race([
      runStalledStepWatch().then((report) => ({ report })),
      new Promise<{ report: null }>((resolve) => setTimeout(() => resolve({ report: null }), 5_000)),
    ]);
    try {
      // Тик завершился, хотя подтверждения старта так и не будет.
      expect(raced.report).not.toBeNull();
      expect(raced.report!.restarted).toBe(1);
      expect(Date.now() - started).toBeLessThan(5_000);
      // Сообщение о зависании ушло сразу и не обещает «перезапущен».
      const messages = orchMessages();
      expect(messages[0].id).toMatch(/^orch-stalled_restarted:/);
      expect(messages[0].text).toMatch(/Перезапуск запущен/);
      expect(messages[0].text).not.toMatch(/Новая попытка запущена|перезапущен сервером/);
      expect(messages[0].text).toContain(fixture.task.id);
      expect(messages[0].text).toContain("executor");
      // Событие «старт не подтвердился» попало в журнал событий.
      const pending = db.prepare("SELECT to_value FROM task_events WHERE task_id = ? AND kind = 'stalled_step_restart_pending'").get(fixture.task.id) as { to_value: string } | undefined;
      expect(pending?.to_value).toMatch(/подтверждение старта не пришло/);
      // Отказ старта придёт сам, когда промис развяжется: сейчас его ещё
      // нет, и второй тик по той же закрытой попытке его не создаст.
      expect(messages.filter((m) => m.id.startsWith("orch-stalled_restart_failed:"))).toHaveLength(0);
    } finally {
      admission.holdSlot = false;
      holder();
      forceReleaseSlotSession(fixture.subtaskId);
    }
  });

  // Дефект D3 (ревью критика 16.10.2026): уведомление об автоблоке
  // уходило только если тик сам закрыл текущую попытку (`closed === 1`).
  // У узла, который умер до первой попытки, `current_attempt_id` пуст и
  // блок проходил в полной тишине, хотя детерминированный ключ события
  // (цикл допуска) в этой же функции вычисляется.
  // Молчание без текущей попытки — тот же класс, что D3, только на
  // авторестарте: закрывать нечего, но шаг-то мы с умершего запуска
  // сняли и перезапуск запустили, а сообщить нечем было бы.
  it("авторестарт узла без текущей попытки — одно сообщение по ключу цикла допуска", async () => {
    db.prepare("DELETE FROM attempts WHERE subtask_id = ? AND ended_at IS NULL").run(fixture.subtaskId);
    db.prepare("UPDATE subtasks SET current_attempt_id=NULL, agent_heartbeat_at=datetime('now','-40 minutes') WHERE id=?").run(fixture.subtaskId);
    const cycle = (db.prepare("SELECT admission_cycle c FROM subtasks WHERE id=?").get(fixture.subtaskId) as { c: number }).c;
    const report = await runStalledStepWatch();
    expect(report.restarted).toBe(1);
    const messages = orchMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(`orch-stalled_restarted:cycle:${cycle}`);
    expect(messages[0].text).toContain("не было текущей попытки");
    expect(messages[0].text).toMatch(/Перезапуск запущен/);
    expect(orchQueue()).toHaveLength(1);
  });

  it("автоблок узла без текущей попытки — сообщение всё равно уходит по ключу цикла допуска", async () => {
    const ins = db.prepare(
      `INSERT INTO attempts(id, task_id, subtask_id, executor_id, started_at, ended_at, outcome, reason)
       VALUES(?, ?, ?, ?, datetime('now', ?), datetime('now', ?), 'auto_restarted', 'setup')`,
    );
    ins.run(`att_no_a_${Date.now()}`, fixture.task.id, fixture.subtaskId, roleUserId("builder"), "-110 minutes", "-110 minutes");
    ins.run(`att_no_b_${Date.now()}_b`, fixture.task.id, fixture.subtaskId, roleUserId("builder"), "-60 minutes", "-60 minutes");
    // Узел завис, но попытки у него нет: старт не дошёл до попытки.
    db.prepare("UPDATE subtasks SET current_attempt_id=NULL, agent_heartbeat_at=datetime('now','-40 minutes') WHERE id=?").run(fixture.subtaskId);
    const cycle = (db.prepare("SELECT admission_cycle c FROM subtasks WHERE id=?").get(fixture.subtaskId) as { c: number }).c;
    const report = await runStalledStepWatch();
    expect(report.blocked).toBe(1);
    expect(subtask(fixture.subtaskId).agent_state).toBe("blocked");
    const messages = orchMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(`orch-stalled_blocked:cycle:${cycle}`);
    expect(messages[0].text).toContain(`цикл допуска ${cycle}`);
    expect(messages[0].text).toMatch(/Разработчик/);
    expect(messages[0].text).toMatch(/лимит автоперезапуска/);
    expect(notifications("stalled_blocked")).toHaveLength(1);
    expect(orchQueue()).toHaveLength(1);
  });

  it("автоблок — одно сообщение stalled_blocked с причиной; владельцу по-прежнему ровно одно уведомление", async () => {
    seedSessionJournal(fixture.task.id, "builder", fixture.subtaskId, 30);
    const ins = db.prepare(
      `INSERT INTO attempts(id, task_id, subtask_id, executor_id, started_at, ended_at, outcome, reason)
       VALUES(?, ?, ?, ?, datetime('now', ?), datetime('now', ?), 'auto_restarted', 'setup')`,
    );
    ins.run(`att_bl_a_${Date.now()}`, fixture.task.id, fixture.subtaskId, roleUserId("builder"), "-110 minutes", "-110 minutes");
    ins.run(`att_bl_b_${Date.now()}_b`, fixture.task.id, fixture.subtaskId, roleUserId("builder"), "-60 minutes", "-60 minutes");
    const report = await runStalledStepWatch();
    expect(report.blocked).toBe(1);
    const messages = orchMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toMatch(/^orch-stalled_blocked:/);
    expect(messages[0].text).toMatch(/blocked/);
    expect(messages[0].text).toContain("лимит автоперезапуска");
    expect(messages[0].text).toMatch(/Разработчик/);
    expect(notifications("stalled_blocked")).toHaveLength(1);
    expect(orchQueue()).toHaveLength(1);
  });
});
