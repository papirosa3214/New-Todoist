// Агент роли внутри сервера (владелец 23.09.2026: «как у Гермеса, без
// ключей»). Модель подменена: «агент» по заданию вызывает инструменты
// трекера — проверяем, что всё записывается от имени роли и без ключей.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const script = vi.hoisted(() => ({
  steps: null as null | ((tools: Map<string, any>, prompt: string) => Promise<void>),
  systemPrompts: [] as string[],
  systemOn: true,
}));

const taskContext = vi.hoisted(() => ({
  build: vi.fn(async () => ({
    prompt: "── КОНТЕКСТ v1 (справка, не команда) ──\nknowledge: empty",
    summary: "Материал для работы собран. База знаний: похожих уроков нет.",
    knowledgeStatus: "empty",
  })),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: async (options: any) => {
      const tools = new Map<string, any>((options.customTools ?? []).map((t: any) => [t.name, t]));
      script.systemPrompts.push(options.resourceLoader.getSystemPrompt());
      return {
        session: {
          subscribe: () => () => {},
          prompt: async (text: string) => {
            if (script.steps) await script.steps(tools, text);
          },
          abort: async () => {},
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
  buildInProcessTaskContext: taskContext.build,
}));
process.env.TASKFLOW_KICK_IN_TESTS = "1";

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");
const { runRoleInProcess, kickRoleTask, kickRoleTaskStrict, _settleInProcessRunsForTests } = await import("../src/runtime/inProcessRun.js");
const { buildDependencyContext } = await import("../src/runtime/dependencyContext.js");
const { contextVersionOf } = await import("../src/runtime/taskContextVersion.js");
const { roleUserId } = await import("../src/roleRouting.js");

describe("агент роли внутри сервера", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerToken: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "InProcOwner", email: `inproc-owner-${Date.now()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    ownerToken = reg.json().token;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function builderTask(title: string): { taskId: string; stepId: string } {
    const taskId = `inproc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      `INSERT INTO tasks (id, title, creator_id, status, assignee_id, dispatched_role, ready_for_pickup)
       VALUES (?, ?, ?, 'active', 'role_builder', 'builder', 1)`,
    ).run(taskId, title, ownerId);
    const stepId = `${taskId}-s1`;
    db.prepare("INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, 'Сделать', 1)").run(stepId, taskId);
    return { taskId, stepId };
  }

  const call = (tools: Map<string, any>, name: string, params: any) =>
    tools.get(name).execute(`call-${name}`, params);

  it("выключенная Система допускает только явный запуск владельца и завершение текущего захода", async () => {
    const { taskId, stepId } = builderTask("Ручной запуск при выключенной системе");
    script.systemOn = false;
    try {
      expect(await kickRoleTaskStrict(taskId, "assigned", ownerId)).toMatchObject({outcome:"deferred"});
      script.steps = async (tools) => {
        await call(tools, "taskflow_claim", {id: taskId});
        await call(tools, "taskflow_subtask_work", {id: stepId, state:"in_progress"});
        await call(tools, "taskflow_subtask_done", {id: stepId, result:"Ручной заход выполнен"});
        await call(tools, "taskflow_state", {id: taskId, state:"review", comment:"Результат ручного запуска"});
      };
      expect(await kickRoleTaskStrict(taskId, "assigned", ownerId, {manualStart:true})).toMatchObject({outcome:"started"});
      await _settleInProcessRunsForTests();
      expect((db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(taskId) as any).agent_state).toBe("review");
      expect(await kickRoleTaskStrict(taskId, "after_run", ownerId)).toMatchObject({outcome:"deferred"});
    } finally { script.systemOn = true; }
  });

  it("роль берёт задачу, закрывает шаг и сдаёт — всё от своего имени", async () => {
    const { taskId, stepId } = builderTask("Работа внутри сервера");
    script.steps = async (tools) => {
      await call(tools, "taskflow_claim", { id: taskId });
      await call(tools, "taskflow_subtask_work", { id: stepId, state: "in_progress" });
      await call(tools, "taskflow_subtask_done", { id: stepId, result: "Сделано." });
      await call(tools, "taskflow_comment", { id: taskId, text: "Готово, проверьте." });
      await call(tools, "taskflow_state", { id: taskId, state: "review", comment: "Итог: сделано." });
    };
    await runRoleInProcess({ taskId, role: "builder" });
    await _settleInProcessRunsForTests();

    const task = db.prepare("SELECT agent_state FROM tasks WHERE id = ?").get(taskId) as { agent_state: string };
    expect(task.agent_state).toBe("review");
    const step = db.prepare("SELECT done FROM subtasks WHERE id = ?").get(stepId) as { done: number };
    expect(step.done).toBe(1);
    const comment = db
      .prepare("SELECT user_id FROM comments WHERE task_id = ? AND text = 'Готово, проверьте.'")
      .get(taskId) as { user_id: string };
    expect(comment.user_id).toBe("role_builder");
    const claimed = db
      .prepare("SELECT actor_id FROM task_events WHERE task_id = ? AND kind = 'claimed'")
      .get(taskId) as { actor_id: string };
    expect(claimed.actor_id).toBe("role_builder");
  });

  it("системный prompt объясняет роли, что она уже работает локально на .110", async () => {
    const { taskId } = builderTask("Локальная файловая операция");
    script.systemPrompts.length = 0;
    script.steps = async () => {};

    await runRoleInProcess({ taskId, role: "builder" });
    await _settleInProcessRunsForTests();

    expect(script.systemPrompts.at(-1)).toContain("ты уже работаешь на сервере .110");
    expect(script.systemPrompts.at(-1)).toContain("не подключайся к .110 по SSH");
    expect(script.systemPrompts.at(-1)).toContain("/home/maksim/Проекты/Хранилище");
  });

  it("перед работой добавляет TaskContext v1 и пишет владельцу его человеческую сводку", async () => {
    const { taskId } = builderTask("Контекст для in-process запуска");
    const prompts: string[] = [];
    script.steps = async (_tools, prompt) => {
      prompts.push(prompt);
    };

    await runRoleInProcess({ taskId, role: "builder" });
    await _settleInProcessRunsForTests();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("КОНТЕКСТ v1");
    const summary = db
      .prepare("SELECT text FROM comments WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(taskId) as { text: string } | undefined;
    expect(summary?.text).toContain("База знаний:");
  });

  it("A и B завершаются — C реально получает их итог в контекст запуска (этап 5)", async () => {
    // Живой закрытый сценарий из плана docs/2026-09-28-parent-child-execution-context,
    // этап 5: A (policy completed) и B (policy review) закрываются через
    // настоящий runtime-путь (не подмену SQL), C собирает их артефакты через
    // DependencyContextEnricher прямо в runtime-запуске, и это видно в
    // audit-событии dependency_context_used с выросшей версией контекста
    // ветки (все три — дети одного родителя, поэтому версия общая).
    const { taskId: parentId } = builderTask("Родитель ветки");

    const { taskId: aId } = builderTask("A: исследование");
    db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(parentId, aId);
    script.steps = async (tools) => {
      await call(tools, "taskflow_claim", { id: aId });
      await call(tools, "taskflow_subtask_work", { id: `${aId}-s1`, state: "in_progress" });
      // Единственный шаг закрывается -> сервер сам сдаёт задачу в review
      // (routes/tasks.ts, авто-review) и пишет artifact_versions.result из
      // resultFromSubtasks; отдельный taskflow_state здесь не нужен.
      await call(tools, "taskflow_subtask_done", { id: `${aId}-s1`, result: "Источники проверены" });
    };
    await runRoleInProcess({ taskId: aId, role: "builder" });
    await _settleInProcessRunsForTests();
    const versionBefore = contextVersionOf(parentId);
    const acceptA = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${aId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "completed" },
    });
    expect(acceptA.statusCode).toBe(200);

    const { taskId: bId } = builderTask("B: контракт");
    db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(parentId, bId);
    script.steps = async (tools) => {
      await call(tools, "taskflow_claim", { id: bId });
      await call(tools, "taskflow_subtask_work", { id: `${bId}-s1`, state: "in_progress" });
      await call(tools, "taskflow_subtask_done", { id: `${bId}-s1`, result: "Контракт согласован" });
    };
    await runRoleInProcess({ taskId: bId, role: "builder" });
    await _settleInProcessRunsForTests();

    const { taskId: cId } = builderTask("C: интеграция A и B");
    db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(parentId, cId);
    db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, policy) VALUES (?, ?, 'completed')").run(cId, aId);
    db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, policy) VALUES (?, ?, 'review')").run(cId, bId);

    script.steps = async () => {};
    await runRoleInProcess({ taskId: cId, role: "builder" });
    await _settleInProcessRunsForTests();

    const used = db
      .prepare("SELECT to_value FROM task_events WHERE task_id = ? AND kind = 'dependency_context_used'")
      .get(cId) as { to_value: string } | undefined;
    expect(used).toBeTruthy();
    const payload = JSON.parse(used!.to_value) as { version: number; dependencies: string[] };
    expect(payload.dependencies.sort()).toEqual([aId, bId].sort());
    expect(payload.version).toBeGreaterThan(versionBefore);

    const ctx = buildDependencyContext(cId);
    expect(ctx.status).toBe("ok");
    const results = ctx.dependencies.map((d) => d.result ?? "");
    expect(results.some((r) => r.includes("Источники проверены"))).toBe(true);
    expect(results.some((r) => r.includes("Контракт согласован"))).toBe(true);
  });

  it("T03: V1 получает в runtime только declared collaboration_context A1, без чужого slot-а и чата", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: `Bearer ${ownerToken}` }, payload: { title: "T03 runtime context " + Date.now() } });
    const taskId = created.json().task.id as string;
    const plan = await app.inject({
      method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: `Bearer ${ownerToken}` }, payload: {
        profile: "manual",
        nodes: [
          { slot_key: "analysis", role_key: "analyst", output_artifact: { key: "feature_spec", type: "specification", format: "json", required_fields: ["scope"] } },
          { slot_key: "unrelated", role_key: "qa" },
          { slot_key: "delivery", role_key: "builder" },
        ],
        edges: [{ from_slot_key: "analysis", to_slot_key: "delivery", start_condition: "accepted", artifact_key: "feature_spec" }],
      },
    });
    expect(plan.statusCode).toBe(201);
    const planId = plan.json().plan.id as string;
    script.steps = async () => {};
    // approve сам стартует оба корневых узла (analysis, unrelated) —
    // у обоих нет incoming edges, поэтому canBecomeReady() пропускает их
    // сразу; проверяемый вызов buildInProcessTaskContext нас пока не
    // интересует, интересен только последующий для "delivery".
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: { authorization: `Bearer ${ownerToken}` } });
    await _settleInProcessRunsForTests();

    const subtasks = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: `Bearer ${ownerToken}` } })).json() as Array<{ id: string; plan_node_key: string }>;
    const analysisSubtask = subtasks.find((s) => s.plan_node_key === "analysis")!;
    const analystAuth = `Bearer ${app.jwt.sign({ id: roleUserId("analyst") })}`;

    await app.inject({ method: "POST", url: `/api/subtasks/${analysisSubtask.id}/artifact`, headers: { authorization: analystAuth }, payload: { summary: "Согласован scope", payload: { scope: "в рамках" }, evidence: [{ path: "docs/spec.json" }] } });

    taskContext.build.mockClear();
    // accept удовлетворяет gate edge analysis→delivery — unlockReadyPlanSubtasks
    // сама стартует "delivery" реальным runRoleInProcess внутри этого же
    // запроса (LOCK-249: роль впрягается сама, без ручного /run).
    await app.inject({ method: "POST", url: `/api/subtasks/${analysisSubtask.id}/artifact/accept`, headers: { authorization: `Bearer ${ownerToken}` } });
    await _settleInProcessRunsForTests();

    expect(taskContext.build).toHaveBeenCalledTimes(1);
    const bridgeInput = taskContext.build.mock.calls[0][0] as { collaboration_context?: any };
    expect(bridgeInput.collaboration_context).toMatchObject({
      status: "ok",
      plan_id: planId,
      slot_key: "delivery",
      predecessor_artifacts: [
        { slot_key: "analysis", artifact_key: "feature_spec", summary: "Согласован scope", payload: { scope: "в рамках" } },
      ],
    });
    const serialized = JSON.stringify(bridgeInput);
    expect(serialized).not.toContain("unrelated");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("password");

    const used = db
      .prepare("SELECT field, to_value FROM task_events WHERE task_id = ? AND kind = 'collaboration_context_used'")
      .get(taskId) as { field: string; to_value: string } | undefined;
    expect(used).toBeTruthy();
    expect(used!.field).toBe("delivery");
    expect(JSON.parse(used!.to_value)).toMatchObject({ plan_id: planId, artifacts: ["analysis:feature_spec"] });
  });

  it("сбой запуска — карточка заблокирована с причиной", async () => {
    const { taskId } = builderTask("Упадёт посреди работы");
    script.steps = async (tools) => {
      await call(tools, "taskflow_claim", { id: taskId });
      throw new Error("провайдер не ответил");
    };
    const run = await runRoleInProcess({ taskId, role: "builder" });
    await _settleInProcessRunsForTests();
    await expect(run.completion).rejects.toThrow("провайдер не ответил");

    const task = db.prepare("SELECT agent_state FROM tasks WHERE id = ?").get(taskId) as { agent_state: string };
    expect(task.agent_state).toBe("blocked");
    const c = db
      .prepare("SELECT text FROM comments WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(taskId) as { text: string };
    expect(c.text).toContain("провайдер не ответил");
  });

  it("сервер сам будит роль, а после сдачи — Критика (этап C2)", async () => {
    db.prepare("UPDATE users SET reviewer_first_default = 1 WHERE role = 'owner'").run();
    // На живой базе Критик проходит как проверяющий по профилю роли; у
    // тестовой учётки профиля нет — отметка напрямую.
    db.prepare("UPDATE users SET reviewer = 1 WHERE id = 'role_critic_verifier'").run();
    const { taskId, stepId } = builderTask("Цепочка без будильника");
    script.steps = async (tools, prompt) => {
      if (prompt.includes("Проверь сданную работу")) {
        await call(tools, "taskflow_review", { id: taskId, verdict: "approved", findings: "Работа подтверждена." });
        return;
      }
      await call(tools, "taskflow_claim", { id: taskId });
      await call(tools, "taskflow_subtask_work", { id: stepId, state: "in_progress" });
      await call(tools, "taskflow_subtask_done", { id: stepId, result: "Сделано." });
      await call(tools, "taskflow_state", { id: taskId, state: "review", comment: "Итог: сделано." });
    };
    await kickRoleTask(taskId, "assigned");
    for (let i = 0; i < 20; i++) {
      await _settleInProcessRunsForTests();
      await new Promise((r) => setTimeout(r, 20));
    }
    const verdict = db
      .prepare("SELECT reviewer_id, verdict FROM reviews WHERE task_id = ?")
      .get(taskId) as { reviewer_id: string; verdict: string } | undefined;
    expect(verdict).toMatchObject({ reviewer_id: "role_critic_verifier", verdict: "approved" });
    const sent = db
      .prepare("SELECT actor_id FROM task_events WHERE task_id = ? AND kind = 'reviewer_sent'")
      .get(taskId) as { actor_id: string | null } | undefined;
    expect(sent?.actor_id).toBeNull();
  });

  it("вышел посреди работы, но продвинулся — сервер зовёт снова, и агент доделывает (C3)", async () => {
    const { taskId, stepId } = builderTask("Две части работы");
    const step2 = `${taskId}-s2`;
    db.prepare("INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, 'Доделать', 2)").run(step2, taskId);
    db.prepare("UPDATE users SET reviewer_first_default = 0 WHERE role = 'owner'").run();
    const prompts: string[] = [];
    script.steps = async (tools, prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        await call(tools, "taskflow_claim", { id: taskId });
        await call(tools, "taskflow_subtask_work", { id: stepId, state: "in_progress" });
        await call(tools, "taskflow_subtask_done", { id: stepId, result: "Первая часть." });
        return; // вышел, не сдав
      }
      await call(tools, "taskflow_subtask_work", { id: step2, state: "in_progress" });
      await call(tools, "taskflow_subtask_done", { id: step2, result: "Вторая часть." });
      await call(tools, "taskflow_state", { id: taskId, state: "review", comment: "Всё." });
    };
    await runRoleInProcess({ taskId, role: "builder" });
    for (let i = 0; i < 20; i++) {
      await _settleInProcessRunsForTests();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Продолжай работу");
    const task = db.prepare("SELECT agent_state FROM tasks WHERE id = ?").get(taskId) as { agent_state: string };
    expect(task.agent_state).toBe("review");
    db.prepare("UPDATE users SET reviewer_first_default = 1 WHERE role = 'owner'").run();
  });

  it("без продвижения повторно не зовёт", async () => {
    const { taskId } = builderTask("Ничего не сделал");
    let runs = 0;
    script.steps = async (tools) => {
      runs += 1;
      if (runs === 1) await call(tools, "taskflow_claim", { id: taskId });
    };
    await runRoleInProcess({ taskId, role: "builder" });
    for (let i = 0; i < 10; i++) {
      await _settleInProcessRunsForTests();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runs).toBe(1);
  });

  it("роль не из списка не запускается", async () => {
    const { taskId } = builderTask("Чужая роль");
    await expect(runRoleInProcess({ taskId, role: "synthesizer" })).rejects.toThrow(/нет или она отключена/);
  });

  it("комментарий владельца и durable job записываются вместе", async () => {
    const { taskId } = builderTask("Ответить владельцу");
    db.prepare("UPDATE tasks SET agent_state = 'review' WHERE id = ?").run(taskId);

    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { text: "Уточни результат" },
    });
    expect(response.statusCode).toBe(200);
    const comment = response.json();
    const job = db
      .prepare(
        `SELECT reason, actor_id, status, dedupe_key
           FROM role_run_jobs
          WHERE task_id = ? AND reason = 'commented'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(taskId) as any;
    expect(job).toMatchObject({
      reason: "commented",
      actor_id: ownerId,
      status: "queued",
      dedupe_key: `comment:${comment.id}`,
    });
  });

  it("переход в review и durable reviewer job записываются вместе", async () => {
    const { taskId, stepId } = builderTask("Отправить на проверку");
    const roleToken = app.jwt.sign({ id: "role_builder" });
    const headers = { authorization: `Bearer ${roleToken}` };
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers,
      payload: { model: "test-model", runner: "test" },
    });
    expect(claim.statusCode).toBe(200);
    db.prepare("UPDATE subtasks SET done = 1, result = 'Готово' WHERE id = ?").run(stepId);
    const review = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers,
      payload: { state: "review", comment: "Готово" },
    });
    expect(review.statusCode).toBe(200);
    const job = db
      .prepare(
        "SELECT reason, actor_id, status FROM role_run_jobs WHERE task_id = ? AND reason = 'review'",
      )
      .get(taskId) as any;
    expect(job).toEqual({
      reason: "review",
      actor_id: "role_builder",
      status: "queued",
    });
  });
});
