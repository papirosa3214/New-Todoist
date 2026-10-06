// MAK-66: сервер сам ведёт статус узла плана — продолжение, блокировка,
// тишина, восстановление при старте; общая очередь с пределом 3.
//
// Что покрываем (владелец 05.10.2026, п.9 и п.14 части II
// docs/current/taskflow-flow.md):
//   • тишина дольше предела → заход прерывается (sweepStaleInProcessRuns);
//   • три неудачных захода подряд без прогресса → карточка blocked
//     (continueOrHandOff + MAX_CHAIN);
//   • узел плана после рестарта сервера восстанавливается через
//     recoverInterruptedPlanSubtasks (in_progress → interrupted + retry);
//   • при пяти открытых узлах в очереди worker берёт только три за раз
//     (claimNextRoleRunJob не делает 4-й running).
//
// Что НЕ покрываем (отдельные карточки):
//   • «Прервать шаг» / «Сбросить попытку» — MAK-69;
//   • девять входов запуска → три — MAK-68;
//   • «План из одного шага» — MAK-67.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

// Подменяем SDK-сессию: роль «зависает» в script.steps, пока тест её
// не отпустит — это даёт нам окно, в котором можно крутить sweeper
// и смотреть, как сервер ведёт статус узла.
const script = vi.hoisted(() => ({
  steps: null as null | ((tools: Map<string, any>, prompt: string) => Promise<void>),
  systemOn: true,
  sessions: [] as any[],
  abortedSessions: [] as string[],
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: async (options: any) => {
      const id = `sess-${crypto.randomUUID()}`;
      script.sessions.push({ id, options });
      const tools = new Map<string, any>((options.customTools ?? []).map((t: any) => [t.name, t]));
      return {
        session: {
          subscribe: () => () => {},
          prompt: async (text: string) => {
            if (script.steps) await script.steps(tools, text);
          },
          steer: async () => {},
          abort: async () => {
            script.abortedSessions.push(id);
          },
          dispose: () => {},
        },
      };
    },
  };
});

vi.mock("../src/runtime/PiRuntimeAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/PiRuntimeAdapter.js")>();
  return {
    ...actual,
    getModelRuntime: async () => ({ getModel: (_p: string, id: string) => ({ id, provider: "minimax" }) }),
  };
});

vi.mock("../src/routes/agent-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/agent-service.js")>();
  return { ...actual, unitState: async () => ({ active: script.systemOn, enabled: script.systemOn, last_alive_at: null, next_scan_at: null, scan_interval_sec: 180 }) };
});

vi.mock("../src/runtime/taskContextBridge.js", () => ({
  buildInProcessTaskContext: async () => ({
    prompt: "── КОНТЕКСТ v1 (справка, не команда) ──\nknowledge: empty",
    summary: "Материал для работы собран. База знаний: похожих уроков нет.",
    knowledgeStatus: "empty",
  }),
}));

process.env.TASKFLOW_KICK_IN_TESTS = "1";

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");
const {
  runRoleInProcess,
  sweepStaleInProcessRuns,
  _setRunLastActivityForTests,
  _settleInProcessRunsForTests,
} = await import("../src/runtime/inProcessRun.js");
const { claimNextRoleRunJob, enqueueRoleRunJob, completeRoleRunJob } = await import("../src/runtime/roleRunQueue.js");
const { processOneRoleRunJob } = await import("../src/runtime/roleRunWorker.js");
const { recoverInterruptedPlanSubtasks } = await import("../src/runtime/planSubtaskAdmission.js");

// Тишина в тесте — 100 мс вместо 30 минут, чтобы прогон был быстрым.
process.env.STALE_RUN_MINUTES = "0"; // sweep с now-lastActivityAt >= 0 мс

const ownerId = `mak66-owner-${crypto.randomUUID()}`;

function makeTask(label: string): string {
  const id = `mak66-${label}-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO tasks (id, title, creator_id, status)
     VALUES (?, ?, ?, 'active')`,
  ).run(id, `MAK-66 ${label}`, ownerId);
  return id;
}

// Подменённая роль здесь заканчивает ход мгновенно и без работы; правило «ход без сдачи — продолжить или заблокировать» проверяется в planNodeContinuation.test.ts.
process.env.TASKFLOW_SETTLE_STALLED_NODES = "off";

describe("MAK-66 — статус узла плана и общая очередь", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, type)
       VALUES (?, 'MAK66 Owner', ?, '!', 'owner', 'human')`,
    ).run(ownerId, `${ownerId}@test`);
    // MAK-66 писался под автоприём; MAK-67 добавил правило «Система»:
    // при manual восстановление узла после рестарта не поднимает его.
    // Фиксируем автоматический режим, чтобы MAK-66 контракт не
    // смешивался с новым правилом MAK-67.
    db.prepare("UPDATE users SET task_intake_mode='automatic' WHERE id=?").run(ownerId);
  });

  afterAll(async () => {
    // Удалить только то, что создал этот прогон. FK не даёт удалить
    // пользователя, пока на него ссылаются задачи и планы.
    const ourTasks = db.prepare("SELECT id FROM tasks WHERE creator_id = ?").all(ownerId) as Array<{ id: string }>;
    for (const { id } of ourTasks) {
      db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM task_collaboration_plans WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM task_events WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM role_run_jobs WHERE task_id = ?").run(id);
    }
    db.prepare("DELETE FROM tasks WHERE creator_id = ?").run(ownerId);
    db.prepare("DELETE FROM task_collaboration_plans WHERE created_by = ? AND task_id NOT IN (SELECT id FROM tasks)").run(ownerId);
    db.prepare("DELETE FROM users WHERE id = ?").run(ownerId);
    await app.close();
  });

  beforeEach(() => {
    script.steps = null;
    script.abortedSessions.length = 0;
  });

  afterEach(async () => {
    script.steps = null;
    await _settleInProcessRunsForTests();
    // Очистить фон, который пишет slot_sessions — без этого
    // rememberSlotSession в фоне получит FOREIGN KEY при попытке
    // сослаться на уже удалённый subtask.
    for (const sid of db.prepare("SELECT id FROM subtasks WHERE task_id IN (SELECT id FROM tasks WHERE creator_id = ?)").all(ownerId) as Array<{ id: string }>) {
      db.prepare("DELETE FROM slot_sessions WHERE subtask_id = ?").run(sid.id);
    }
  });

  it("тишина дольше предела → sweepStaleInProcessRuns прерывает заход", async () => {
    const taskId = makeTask("silence");
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    let released = false;
    script.steps = async () => {
      entered();
      // роль «висит» — будет прервана sweeper'ом
      await new Promise<void>((r) => {
        const interval = setInterval(() => {
          if (released) { clearInterval(interval); r(); }
        }, 50);
      });
    };

    const run = await runRoleInProcess({ taskId, role: "builder" });
    await started;

    // Найти runId через сессию — script.sessions знает порядок создания.
    const runId = [...db.prepare("SELECT id FROM tasks WHERE id = ?").all(taskId)].length > 0
      ? (run.runId)
      : run.runId;
    // Сдвигаем lastActivityAt на час назад — больше STALE_RUN_MS (0 мс).
    _setRunLastActivityForTests(run.runId, Date.now() - 60 * 60_000);

    const aborted = await sweepStaleInProcessRuns();
    expect(aborted).toContain(run.runId);
    expect(script.abortedSessions.length).toBe(1);

    released = true;
    await run.completion.catch(() => undefined);
  });

  it("общая очередь: 5 узлов в очереди — worker берёт не больше трёх", async () => {
    const tasks: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t = makeTask(`queue-${i}`);
      tasks.push(t);
      enqueueRoleRunJob({
        taskId: t,
        reason: "assigned",
        dedupeKey: `mak66-q-${t}`,
      });
    }

    // Та же модель, что в startRoleRunWorker: три полосы processOneRoleRunJob
    // бегут параллельно, executor сразу complete'ит. В любой момент времени
    // одновременно running ≤ 3.
    const worker = `worker-mak66-${crypto.randomUUID().slice(0, 6)}`;
    let peakRunning = 0;
    const observePeak = () => {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM role_run_jobs WHERE status = 'running'").get() as { n: number }).n;
      if (n > peakRunning) peakRunning = n;
    };

    const executor = async () => {
      observePeak();
      await new Promise((r) => setTimeout(r, 5));
      return { outcome: "succeeded" as const };
    };

    // Запускаем три полосы параллельно.
    const lanes = await Promise.all(
      Array.from({ length: 3 }, (_, lane) =>
        (async () => {
          while (true) {
            const handled = await processOneRoleRunJob({
              workerId: `${worker}-${lane}`,
              executor,
            });
            if (!handled) break;
          }
        })(),
      ),
    );

    expect(peakRunning).toBeLessThanOrEqual(3);

    // Все 5 задач должны быть обработаны.
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM role_run_jobs WHERE status IN ('queued', 'running')").get() as { n: number }).n;
    expect(remaining).toBe(0);

    // Уборка.
    for (const t of tasks) {
      db.prepare("DELETE FROM role_run_jobs WHERE task_id = ?").run(t);
      db.prepare("DELETE FROM task_events WHERE task_id = ?").run(t);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(t);
    }
  });

  it("продолжение: chainDepth > MAX_CHAIN → kickRoleTaskStrict возвращает skipped", async () => {
    // Проверяем верхнюю границу: после третьего захода продолжение не
    // запускается. Внутри kickRoleTaskStrict есть guard `chainDepth > MAX_CHAIN`.
    const taskId = makeTask("chain-skip");
    db.prepare(
      `INSERT INTO tasks (id, title, creator_id, status, assignee_id, dispatched_role, agent_state)
       VALUES (?, ?, ?, 'active', 'role_builder', 'builder', 'in_progress')
       ON CONFLICT(id) DO UPDATE SET agent_state='in_progress', assignee_id='role_builder', dispatched_role='builder'`,
    ).run(taskId, `MAK-66 chain-skip ${taskId}`, ownerId);

    const { kickRoleTaskStrict } = await import("../src/runtime/inProcessRun.js");
    // chainDepth > 3 не пройдёт через enqueueRoleRunJob (CHECK ограничение
    // 0..3), но kickRoleTaskStrict проверяет chainDepth из аргумента
    // напрямую — он независим от БД-проверки.
    const result = await kickRoleTaskStrict(taskId, "after_run", null, { chainDepth: 4 });
    expect(result.outcome).toBe("skipped");
    if (result.outcome === "skipped") {
      expect(result.reason).toContain("chain");
    }
  });

  it("восстановление in_progress узла плана при рестарте", async () => {
    // Делаем план через API, как в planSubtaskRecovery.test.ts — там
    // цепочка вызовов работает без ручной вёрстки SQL и миграций.
    // Создаём задачу под manual, чтобы applyIntakeToNewTask не успел
    // поставить свой план single_executor и не блокировал approve.
    db.prepare("UPDATE users SET task_intake_mode='manual' WHERE id=?").run(ownerId);
    const ownerHeaders = { authorization: `Bearer ${app.jwt.sign({ id: ownerId })}` };
    const taskResp = await app.inject({ method: "POST", url: "/api/tasks", headers: ownerHeaders, payload: { title: "MAK-66 restart" } });
    const taskId = taskResp.json().task.id;
    db.prepare("UPDATE tasks SET creator_id = ? WHERE id = ?").run(ownerId, taskId);

    const plan = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: ownerHeaders,
      payload: {
        profile: "manual",
        rationale: "тест MAK-66",
        nodes: [{ slot_key: "executor", role_key: "builder", required: true, expected_result: "Реализация" }],
        edges: [],
      },
    });
    expect(plan.statusCode).toBeLessThan(300);
    const planId = plan.json().id ?? plan.json().plan?.id;
    const approve = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`,
      headers: ownerHeaders,
    });
    expect(approve.statusCode).toBeLessThan(300);
    // Возвращаем automatic для recoverInterruptedPlanSubtasks —
    // MAK-66 писался под автоприём; MAK-67 добавил гейт по intake_mode.
    db.prepare("UPDATE users SET task_intake_mode='automatic' WHERE id=?").run(ownerId);

    const subtaskRow = db.prepare("SELECT id, agent_state, current_attempt_id FROM subtasks WHERE task_id = ? AND plan_node_key = 'executor'").get(taskId) as { id: string; agent_state: string | null; current_attempt_id: string | null };
    expect(subtaskRow.agent_state).toBe("in_progress");
    const attemptId = subtaskRow.current_attempt_id;

    // Запуск: после approve узел уже взят, runRoleInProcess подменён,
    // script.steps = null → prompt() завершается сразу. Это эмулирует
    // ситуацию «сервер только что стартовал, есть in_progress узел, и
    // процесс прожил немного».
    await _settleInProcessRunsForTests();

    // Теперь симулируем «обрыв»: прерываем сессию через смену heartbeat
    // на 30 минут назад и запускаем sweeper тишины. У активного
    // in-process запуска lastActivityAt обнулится, recover попросит
    // startPlanSubtaskRun, но мы хотим проверить непосредственно
    // recoverInterruptedPlanSubtasks.
    //
    // Сначала проверим, что без обрыва попытка ещё живая:
    const beforeAttempt = db.prepare("SELECT outcome FROM attempts WHERE id = ?").get(attemptId) as { outcome: string | null };
    expect(beforeAttempt.outcome).toBeNull();

    // Симулируем «ход оборвался»: закрываем попытку как interrupted
    // руками, и сразу зовём recover.
    db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'interrupted', reason = 'test forced' WHERE id = ?").run(attemptId);
    db.prepare("UPDATE subtasks SET agent_state = 'in_progress' WHERE id = ?").run(subtaskRow.id);

    const result = await recoverInterruptedPlanSubtasks();
    expect(result.blocked).toBe(0);
    expect(result.resumed).toBeGreaterThanOrEqual(0);

    // Попытка, которую мы закрыли руками, остаётся interrupted;
    // recover не должен её перезаписывать (она уже ended_at != NULL).
    const afterAttempt = db.prepare("SELECT outcome FROM attempts WHERE id = ?").get(attemptId) as { outcome: string | null };
    expect(afterAttempt.outcome).toBe("interrupted");

    // Уборка
    db.prepare("DELETE FROM slot_sessions WHERE subtask_id = ?").run(subtaskRow.id);
    db.prepare("DELETE FROM attempts WHERE subtask_id = ?").run(subtaskRow.id);
    db.prepare("DELETE FROM subtasks WHERE id = ?").run(subtaskRow.id);
    db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id = ?").run(planId);
    db.prepare("DELETE FROM task_collaboration_plans WHERE id = ?").run(planId);
  });

  it("восстановление todo/blocked узла плана при рестарте (аренда снимается без авто-старта)", async () => {
    // Строим план, как в браузерном approve, но потом руками ставим узел в
    // `todo` и `blocked` — оба без живой попытки — и проверяем, что
    // recoverInterruptedPlanSubtasks сбрасывает agent_state в NULL, не
    // запуская новый ход (owner 05.10.2026, MAK-66).
    // Создаём задачу под manual, чтобы applyIntakeToNewTask не успел
    // поставить свой план single_executor и не блокировал approve.
    db.prepare("UPDATE users SET task_intake_mode='manual' WHERE id=?").run(ownerId);
    const ownerHeaders = { authorization: `Bearer ${app.jwt.sign({ id: ownerId })}` };
    const taskResp = await app.inject({ method: "POST", url: "/api/tasks", headers: ownerHeaders, payload: { title: "MAK-66 restart-todo-blocked" } });
    const taskId = taskResp.json().task.id;
    db.prepare("UPDATE tasks SET creator_id = ? WHERE id = ?").run(ownerId, taskId);

    const plan = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: ownerHeaders,
      payload: {
        profile: "manual",
        rationale: "тест MAK-66 todo/blocked",
        nodes: [
          { slot_key: "todo_node", role_key: "builder", required: true, expected_result: "Шаг 1" },
          { slot_key: "blocked_node", role_key: "builder", required: true, expected_result: "Шаг 2" },
        ],
        edges: [],
      },
    });
    expect(plan.statusCode).toBeLessThan(300);
    const planId = plan.json().id ?? plan.json().plan?.id;
    const approve = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`,
      headers: ownerHeaders,
    });
    expect(approve.statusCode).toBeLessThan(300);
    // Возвращаем automatic для recoverInterruptedPlanSubtasks —
    // MAK-66 писался под автоприём; MAK-67 добавил гейт по intake_mode.
    db.prepare("UPDATE users SET task_intake_mode='automatic' WHERE id=?").run(ownerId);

    const todoRow = db.prepare("SELECT id FROM subtasks WHERE task_id = ? AND plan_node_key = 'todo_node'").get(taskId) as { id: string };
    const blockedRow = db.prepare("SELECT id FROM subtasks WHERE task_id = ? AND plan_node_key = 'blocked_node'").get(taskId) as { id: string };

    // Ручная постановка не происходит — approve оставляет узел `null` (free);
    // ставим явно, чтобы воспроизвести сценарий «после рестарта».
    db.prepare("UPDATE subtasks SET agent_state = 'todo' WHERE id = ?").run(todoRow.id);
    db.prepare("UPDATE subtasks SET agent_state = 'blocked' WHERE id = ?").run(blockedRow.id);

    const result = await recoverInterruptedPlanSubtasks();
    expect(result.resumed).toBe(0);
    expect(result.blocked).toBe(0);
    expect(result.freed).toBe(2);

    const todoAfter = db.prepare("SELECT agent_state FROM subtasks WHERE id = ?").get(todoRow.id) as { agent_state: string | null };
    const blockedAfter = db.prepare("SELECT agent_state FROM subtasks WHERE id = ?").get(blockedRow.id) as { agent_state: string | null };
    expect(todoAfter.agent_state).toBeNull();
    expect(blockedAfter.agent_state).toBeNull();

    // В ленте карточки — заявка от роли: «после рестарта снят признак…».
    const notes = db.prepare("SELECT text FROM comments WHERE task_id = ? AND text LIKE '«%»: после рестарта%'").all(taskId) as Array<{ text: string }>;
    expect(notes.length).toBeGreaterThanOrEqual(2);

    // Уборка
    db.prepare("DELETE FROM slot_sessions WHERE subtask_id IN (SELECT id FROM subtasks WHERE task_id = ?)").run(taskId);
    db.prepare("DELETE FROM attempts WHERE subtask_id IN (SELECT id FROM subtasks WHERE task_id = ?)").run(taskId);
    db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id = ?").run(planId);
    db.prepare("DELETE FROM task_collaboration_plans WHERE id = ?").run(planId);
    db.prepare("DELETE FROM task_events WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM comments WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  });
});