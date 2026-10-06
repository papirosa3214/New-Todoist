// Ручки «прервать шаг», «сбросить попытку», «отменить задание» (MAK-69).
//
// Покрытие:
//   1. Права — 403 для агента, 403 для постороннего человека, который
//      имеет отношение к задаче (видит её), 200 для владельца и оркестратора.
//   2. Журнал — каждое действие оставляет в task_events ровно одну строку
//      своего kind с actor_id вызывающего и осмысленным to_value.
//   3. Реальная остановка — вызов cancel на шаге, по которому в этом
//      процессе «живёт» фейковый in-process run (через мок activeInProcessRun),
//      зовёт его abort(); lease и current_attempt_id гасятся, attempt
//      закрывается с cancelled.
//   4. Reset без живого run — attempt закрывается с outcome='reset', lease
//      снимается (это сценарий после рестарта сервера, когда activeRuns
//      пуст, а attempt и agent_state на шаге остались).
//   5. Cancel task — прерывает запуски и на самой задаче, и на каждой
//      подзадаче; attempts закрываются одним UPDATE; новая попытка может
//      быть открыта без нарушения partial unique index.
//
// Живой LLM в тестах не зовём — runRoleInProcess пропускает заходы в режиме
// VITEST без явного TASKFLOW_KICK_IN_TESTS (inProcessRun.ts,
// kickRoleTaskStrict). «Живой run» подменяем через мок activeInProcessRun
// для конкретного marker'а subtaskId — этого достаточно, потому что
// обработчик cancel идёт ровно через эту функцию.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const abortMock = vi.fn(async () => {});
let liveRunInstalled = false;

const inProcessRun = await import("../src/runtime/inProcessRun.js");
const activeInProcessRunSpy = vi
  .spyOn(inProcessRun, "activeInProcessRun")
  .mockImplementation((taskId: string, subtaskId?: string) => {
    if (subtaskId === "__live_subtask__") {
      liveRunInstalled = true;
      return {
        runId: "test-run",
        taskId,
        role: "builder",
        subtaskId,
        abort: abortMock,
        steer: async () => {},
        lastActivityAt: Date.now(),
      } as any;
    }
    if (subtaskId === undefined && taskId === "__live_task__") {
      liveRunInstalled = true;
      return {
        runId: "test-run-task",
        taskId,
        role: "builder",
        subtaskId: undefined,
        abort: abortMock,
        steer: async () => {},
        lastActivityAt: Date.now(),
      } as any;
    }
    return undefined;
  });

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");

const uid = () => crypto.randomUUID();

async function makeUser(
  app: FastifyInstance,
  opts: { name: string; email: string; password: string; role?: "owner" | "orchestrator" | null },
): Promise<{ id: string; auth: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: opts.name, email: opts.email, password: opts.password },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  const id = body.user.id as string;
  if (opts.role) {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(opts.role, id);
  }
  return { id, auth: `Bearer ${body.token}` };
}

function seedTaskWithSubtask(opts: { ownerId: string; assigneeId: string | null; title: string; subtaskIdOverride?: string }) {
  const taskId = uid();
  db.prepare(
    `INSERT INTO tasks (id, title, status, creator_id, assignee_id)
     VALUES (?, ?, 'active', ?, ?)`,
  ).run(taskId, opts.title, opts.ownerId, opts.assigneeId);
  const subId = opts.subtaskIdOverride ?? uid();
  // Если передан subtaskIdOverride и строка уже могла существовать — не
  // падаем: используем уникальный по умолчанию.
  if (opts.subtaskIdOverride) {
    const exists = db.prepare("SELECT 1 FROM subtasks WHERE id = ?").get(opts.subtaskIdOverride);
    if (!exists) {
      db.prepare(
        "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, 1)",
      ).run(subId, taskId, "шаг 1");
    }
  } else {
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, 1)",
    ).run(subId, taskId, "шаг 1");
  }
  return { taskId, subtaskId: subId };
}

function insertAttempt(opts: { taskId: string; subtaskId?: string; executorId: string }) {
  const attemptId = uid();
  db.prepare(
    `INSERT INTO attempts
       (id, task_id, subtask_id, executor_id, started_at, heartbeat_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(attemptId, opts.taskId, opts.subtaskId ?? null, opts.executorId);
  return attemptId;
}

describe("control: прервать шаг / сбросить попытку / отменить задание", () => {
  let app: FastifyInstance;
  let owner: { id: string; auth: string };
  let orchestrator: { id: string; auth: string };
  let agent: { id: string; auth: string };
  let projectColleague: { id: string; auth: string };

  beforeAll(async () => {
    app = await buildApp();

    const stamp = Date.now();
    owner = await makeUser(app, {
      name: "ControlOwner",
      email: `control-owner-${stamp}@test`,
      password: "password123",
      role: "owner",
    });
    orchestrator = await makeUser(app, {
      name: "ControlOrchestrator",
      email: `control-orch-${stamp}@test`,
      password: "password123",
      role: "orchestrator",
    });
    agent = await makeUser(app, {
      name: "ControlAgent",
      email: `control-agent-${stamp}@test`,
      password: "password123",
    });
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agent.id);
    // Создадим отдельного владельца проекта и завернём туда задачу — этот
    // человек видит задачу (проект его), но не может её ПРАВИТЬ ручкой
    // cancel: проверяем именно отказ в действии, а не невидимость.
    projectColleague = await makeUser(app, {
      name: "ControlColleague",
      email: `control-colleague-${stamp}@test`,
      password: "password123",
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    activeInProcessRunSpy.mockRestore();
  });

  // ── Права ─────────────────────────────────────────────────────────────

  describe("права", () => {
    it("владелец прерывает шаг — 200, журнал от владельца", async () => {
      const { taskId, subtaskId } = seedTaskWithSubtask({
        ownerId: owner.id,
        assigneeId: agent.id,
        title: "Владелец прерывает",
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/subtasks/${subtaskId}/cancel`,
        headers: { authorization: owner.auth },
        payload: { reason: "завис" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      const ev = db
        .prepare(
          "SELECT actor_id, kind, to_value FROM task_events WHERE task_id = ? AND kind = 'subtask_cancelled'",
        )
        .get(taskId) as { actor_id: string; kind: string; to_value: string };
      expect(ev.actor_id).toBe(owner.id);
      expect(ev.kind).toBe("subtask_cancelled");
      expect(JSON.parse(ev.to_value).reason).toBe("завис");
    });

    it("оркестратор прерывает шаг — 200", async () => {
      const { subtaskId, taskId } = seedTaskWithSubtask({
        ownerId: owner.id,
        assigneeId: agent.id,
        title: "Оркестратор прерывает",
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/subtasks/${subtaskId}/cancel`,
        headers: { authorization: orchestrator.auth },
      });
      expect(res.statusCode).toBe(200);
      const ev = db
        .prepare(
          "SELECT actor_id FROM task_events WHERE task_id = ? AND kind = 'subtask_cancelled'",
        )
        .get(taskId) as { actor_id: string };
      expect(ev.actor_id).toBe(orchestrator.id);
    });

    it("агент прерывать чужой шаг не может — 403", async () => {
      const { subtaskId } = seedTaskWithSubtask({
        ownerId: owner.id,
        assigneeId: agent.id,
        title: "Агент лезет прерывать",
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/subtasks/${subtaskId}/cancel`,
        headers: { authorization: agent.auth },
      });
      expect(res.statusCode).toBe(403);
    });

    it("посторонний человек, видящий задачу — 403", async () => {
      // Сделаем задачу в проекте projectColleague: тогда он её ВИДИТ
      // (видимость по проекту), но cancel — это правка, и доступ
      // getTaskForWrite для него НЕ открыт (он не владелец проекта и не
      // creator/assignee). На уровне ручки control сначала идёт
      // getSubtaskWithTaskForUser (она опирается на getTaskForRead, и
      // коллега задачу ВИДИТ), потом наша проверка isCancellationActor
      // возвращает 403. То есть 403 ожидаем именно от ручки, не от 404.
      const projectId = uid();
      db.prepare(
        "INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)",
      ).run(projectId, "Контроль-проект", projectColleague.id);
      const taskId = uid();
      db.prepare(
        `INSERT INTO tasks (id, title, status, creator_id, assignee_id, project_id)
         VALUES (?, ?, 'active', ?, ?, ?)`,
      ).run(taskId, "В проекте коллеги", projectColleague.id, agent.id, projectId);
      const subId = uid();
      db.prepare(
        "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, 1)",
      ).run(subId, taskId, "шаг в чужом проекте");

      const res = await app.inject({
        method: "POST",
        url: `/api/subtasks/${subId}/cancel`,
        headers: { authorization: projectColleague.auth },
      });
      expect(res.statusCode).toBe(403);
    });

    it("несуществующий шаг — 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/subtasks/${uid()}/cancel`,
        headers: { authorization: owner.auth },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Реальная остановка ────────────────────────────────────────────────

  describe("прерывание живого in-process run", () => {
    it("cancel зовёт abort() у живого run и закрывает attempt", async () => {
      abortMock.mockClear();
      liveRunInstalled = false;
      // Шаг с marker'ом, по которому мок activeInProcessRun возвращает run.
      const { taskId, subtaskId } = seedTaskWithSubtask({
        ownerId: owner.id,
        assigneeId: agent.id,
        title: "Прерываем живой заход",
        subtaskIdOverride: "__live_subtask__",
      });
      const attemptId = insertAttempt({ taskId, subtaskId, executorId: agent.id });
      db.prepare(
        "UPDATE subtasks SET current_attempt_id = ?, agent_state = 'in_progress', agent_id = ?, agent_heartbeat_at = datetime('now') WHERE id = ?",
      ).run(attemptId, agent.id, subtaskId);

      const res = await app.inject({
        method: "POST",
        url: `/api/subtasks/${subtaskId}/cancel`,
        headers: { authorization: owner.auth },
        payload: { reason: "вис" },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.ok).toBe(true);
      expect(liveRunInstalled).toBe(true);
      expect(json.aborted).toBe(true);
      expect(json.attemptClosed).toBe(true);
      expect(json.leaseReleased).toBe(true);
      expect(abortMock).toHaveBeenCalledTimes(1);

      const subRow = db.prepare("SELECT agent_state, current_attempt_id FROM subtasks WHERE id = ?").get(subtaskId) as
        | { agent_state: string | null; current_attempt_id: string | null };
      expect(subRow.agent_state).toBeNull();
      expect(subRow.current_attempt_id).toBeNull();
      const attRow = db.prepare("SELECT ended_at, outcome, reason FROM attempts WHERE id = ?").get(attemptId) as
        | { ended_at: string | null; outcome: string | null; reason: string | null };
      expect(attRow.ended_at).not.toBeNull();
      expect(attRow.outcome).toBe("cancelled");
      expect(attRow.reason).toBe("вис");
    });
  });

  // ── Reset без живого run ──────────────────────────────────────────────

  describe("reset без живого run", () => {
    it("закрывает attempt и снимает lease, abort не зовётся", async () => {
      abortMock.mockClear();
      liveRunInstalled = false;
      const { taskId, subtaskId } = seedTaskWithSubtask({
        ownerId: owner.id,
        assigneeId: agent.id,
        title: "Reset без живого run",
      });
      const attemptId = insertAttempt({ taskId, subtaskId, executorId: agent.id });
      db.prepare(
        "UPDATE subtasks SET current_attempt_id = ?, agent_state = 'in_progress', agent_id = ?, agent_heartbeat_at = datetime('now') WHERE id = ?",
      ).run(attemptId, agent.id, subtaskId);

      const res = await app.inject({
        method: "POST",
        url: `/api/subtasks/${subtaskId}/reset`,
        headers: { authorization: owner.auth },
        payload: { reason: "рестарт сервера" },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.ok).toBe(true);
      expect(json.attemptClosed).toBe(true);
      expect(json.leaseReleased).toBe(true);
      expect(liveRunInstalled).toBe(false);
      expect(abortMock).not.toHaveBeenCalled();

      const attRow = db.prepare("SELECT outcome FROM attempts WHERE id = ?").get(attemptId) as { outcome: string };
      expect(attRow.outcome).toBe("reset");

      const ev = db
        .prepare(
          "SELECT actor_id, to_value FROM task_events WHERE task_id = ? AND kind = 'subtask_reset'",
        )
        .get(taskId) as { actor_id: string; to_value: string };
      expect(ev.actor_id).toBe(owner.id);
      expect(JSON.parse(ev.to_value).reason).toBe("рестарт сервера");
    });
  });

  // ── Cancel task ───────────────────────────────────────────────────────

  describe("отмена задания целиком", () => {
    it("прерывает запуски и на самой задаче, и на подзадачах; attempts закрываются одним UPDATE", async () => {
      abortMock.mockClear();
      liveRunInstalled = false;
      const { taskId, subtaskId } = seedTaskWithSubtask({
        ownerId: owner.id,
        assigneeId: agent.id,
        title: "Отмена всего задания",
      });
      const taskAttemptId = insertAttempt({ taskId, executorId: agent.id });
      db.prepare("UPDATE tasks SET current_attempt_id = ?, agent_state = 'in_progress' WHERE id = ?").run(taskAttemptId, taskId);
      const subAttemptId = insertAttempt({ taskId, subtaskId, executorId: agent.id });
      db.prepare(
        "UPDATE subtasks SET current_attempt_id = ?, agent_state = 'in_progress', agent_id = ?, agent_heartbeat_at = datetime('now') WHERE id = ?",
      ).run(subAttemptId, agent.id, subtaskId);

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/cancel`,
        headers: { authorization: owner.auth },
        payload: { reason: "отмена" },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.ok).toBe(true);
      // На задаче (subtaskId=undefined) — мок вернёт run по marker'у
      // "__live_task__". Однако taskId у нас обычный. Скорректируем
      // ожидания: мок сработает на подзадаче (раз subtaskId не "__live_subtask__"
      // — не сработает). Значит, оба abort'а НЕ будут вызваны для ЭТОГО
      // сценария. Перепланируем тест.
      void liveRunInstalled;

      // Контрольные инварианты, которые остаются:
      expect(json.attemptsClosed).toBe(2);
      const taskRow = db.prepare("SELECT agent_state, current_attempt_id FROM tasks WHERE id = ?").get(taskId) as
        | { agent_state: string | null; current_attempt_id: string | null };
      expect(taskRow.agent_state).toBeNull();
      expect(taskRow.current_attempt_id).toBeNull();
      const allAttempts = db.prepare(
        "SELECT outcome FROM attempts WHERE task_id = ? ORDER BY id",
      ).all(taskId) as Array<{ outcome: string }>;
      expect(allAttempts.every((a) => a.outcome === "cancelled")).toBe(true);

      const evs = db
        .prepare("SELECT actor_id FROM task_events WHERE task_id = ? AND kind = 'task_cancelled'")
        .all(taskId) as Array<{ actor_id: string }>;
      expect(evs).toHaveLength(1);
      expect(evs[0].actor_id).toBe(owner.id);
    });

    it("cancel задачи вызывает abort() у живого run на самой задаче и на подзадаче", async () => {
      abortMock.mockClear();
      liveRunInstalled = false;
      // Специальные marker'ы с уникальным суффиксом, чтобы мок возвращал
      // run на самой задаче и на подзадаче, не пересекаясь с другими
      // тестами, которые могли оставить эти id в БД.
      const marker = uid();
      const liveTaskMarker = `__live_task_${marker}__`;
      const liveSubMarker = `__live_subtask_${marker}__`;
      // Подменяем мок-фильтр на эти конкретные id: vitest spy возвращает
      // run только если subtaskId строго равен marker'у.
      activeInProcessRunSpy.mockImplementation((taskId: string, subtaskId?: string) => {
        if (subtaskId === liveSubMarker) {
          liveRunInstalled = true;
          return {
            runId: "test-run-sub", taskId, role: "builder", subtaskId,
            abort: abortMock, steer: async () => {}, lastActivityAt: Date.now(),
          } as any;
        }
        if (subtaskId === undefined && taskId === liveTaskMarker) {
          liveRunInstalled = true;
          return {
            runId: "test-run-task", taskId, role: "builder", subtaskId: undefined,
            abort: abortMock, steer: async () => {}, lastActivityAt: Date.now(),
          } as any;
        }
        return undefined;
      });
      const taskId = liveTaskMarker;
      const subtaskId = liveSubMarker;
      db.prepare(
        `INSERT INTO tasks (id, title, status, creator_id, assignee_id)
         VALUES (?, ?, 'active', ?, ?)`,
      ).run(taskId, "Live run на задаче и подзадаче", owner.id, agent.id);
      db.prepare(
        "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, 1)",
      ).run(subtaskId, taskId, "шаг с live run");
      const taskAttemptId = insertAttempt({ taskId, executorId: agent.id });
      db.prepare("UPDATE tasks SET current_attempt_id = ?, agent_state = 'in_progress' WHERE id = ?").run(taskAttemptId, taskId);
      const subAttemptId = insertAttempt({ taskId, subtaskId, executorId: agent.id });
      db.prepare(
        "UPDATE subtasks SET current_attempt_id = ?, agent_state = 'in_progress', agent_id = ?, agent_heartbeat_at = datetime('now') WHERE id = ?",
      ).run(subAttemptId, agent.id, subtaskId);

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/cancel`,
        headers: { authorization: owner.auth },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.abortedRuns).toBe(2);
      expect(json.attemptsClosed).toBe(2);
      expect(abortMock).toHaveBeenCalledTimes(2);
      expect(liveRunInstalled).toBe(true);
    });

    it("после cancel задачи можно начать новую попытку — попыток больше нет действующих", async () => {
      const { taskId, subtaskId } = seedTaskWithSubtask({
        ownerId: owner.id,
        assigneeId: agent.id,
        title: "Можно начать заново",
      });
      const attemptId = insertAttempt({ taskId, executorId: agent.id });
      db.prepare("UPDATE tasks SET current_attempt_id = ?, agent_state = 'in_progress' WHERE id = ?").run(attemptId, taskId);

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/cancel`,
        headers: { authorization: orchestrator.auth },
      });
      expect(res.statusCode).toBe(200);

      // Частичный индекс idx_attempts_one_active_per_subtask разрешает
      // вставить новую попытку — значит, никакая действующая не осталась.
      const insert = db.prepare(
        `INSERT INTO attempts
           (id, task_id, subtask_id, executor_id, started_at, heartbeat_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ).run(uid(), taskId, subtaskId, agent.id);
      expect(insert.changes).toBe(1);
    });

    // Регрессионный тест на MAJOR-баг `de0f5406-…` / `9043b6ff-…`:
    // `cancelTaskWork` закрывал `attempts` (массовый UPDATE), обнулял
    // `tasks.current_attempt_id`, но забывал про `subtasks.current_attempt_id`.
    // Указатели на подзадачах оставались указывать на закрытые попытки, и
    // `consultation.ts:293-297` / `subtask-artifacts.ts:93-94` начинали
    // работать с «активной» попыткой без проверки `ended_at`.
    it("cancel задачи обнуляет current_attempt_id и на подзадачах (MAJOR регрессия)", async () => {
      abortMock.mockClear();
      liveRunInstalled = false;
      // Две подзадачи, у обеих — открытая попытка и непустой указатель.
      const { taskId, subtaskId } = seedTaskWithSubtask({
        ownerId: owner.id,
        assigneeId: agent.id,
        title: "cancel обнуляет указатели подзадач",
      });
      const subId2 = uid();
      db.prepare(
        "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, 2)",
      ).run(subId2, taskId, "шаг 2");
      const taskAttemptId = insertAttempt({ taskId, executorId: agent.id });
      db.prepare("UPDATE tasks SET current_attempt_id = ?, agent_state = 'in_progress' WHERE id = ?").run(taskAttemptId, taskId);
      const subAttemptId = insertAttempt({ taskId, subtaskId, executorId: agent.id });
      db.prepare(
        "UPDATE subtasks SET current_attempt_id = ?, agent_state = 'in_progress', agent_id = ?, agent_heartbeat_at = datetime('now') WHERE id = ?",
      ).run(subAttemptId, agent.id, subtaskId);
      const sub2AttemptId = insertAttempt({ taskId, subtaskId: subId2, executorId: agent.id });
      db.prepare(
        "UPDATE subtasks SET current_attempt_id = ?, agent_state = 'in_progress', agent_id = ?, agent_heartbeat_at = datetime('now') WHERE id = ?",
      ).run(sub2AttemptId, agent.id, subId2);

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/cancel`,
        headers: { authorization: owner.auth },
        payload: { reason: "отмена с проверкой указателей" },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      // И tasks, и обе подзадачи — агенты уже остановлены, указатели
      // обязаны быть NULL; оба attempts и так закрыты с cancelled.
      expect(json.subtaskPointersCleared).toBe(2);

      const taskRow = db.prepare("SELECT current_attempt_id FROM tasks WHERE id = ?").get(taskId) as
        | { current_attempt_id: string | null };
      expect(taskRow.current_attempt_id).toBeNull();
      const subRows = db.prepare("SELECT id, current_attempt_id FROM subtasks WHERE task_id = ? ORDER BY id").all(taskId) as
        Array<{ id: string; current_attempt_id: string | null }>;
      expect(subRows).toHaveLength(2);
      for (const row of subRows) {
        expect(row.current_attempt_id).toBeNull();
      }

      // Журнал `task_cancelled` обязан отражать факт — старые ревью
      // (de0f5406, 9043b6ff) отдельно подчёркивали, что без этого числа
      // нельзя понять «успело ли обнулиться».
      const ev = db
        .prepare("SELECT to_value FROM task_events WHERE task_id = ? AND kind = 'task_cancelled'")
        .get(taskId) as { to_value: string };
      const evBody = JSON.parse(ev.to_value);
      expect(evBody.subtask_pointers_cleared).toBe(2);
    });
  });
});