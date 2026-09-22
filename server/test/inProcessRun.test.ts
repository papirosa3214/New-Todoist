// Агент роли внутри сервера (владелец 23.09.2026: «как у Гермеса, без
// ключей»). Модель подменена: «агент» по заданию вызывает инструменты
// трекера — проверяем, что всё записывается от имени роли и без ключей.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const script = vi.hoisted(() => ({
  steps: null as null | ((tools: Map<string, any>) => Promise<void>),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: async (options: any) => {
      const tools = new Map<string, any>((options.customTools ?? []).map((t: any) => [t.name, t]));
      return {
        session: {
          subscribe: () => () => {},
          prompt: async () => {
            if (script.steps) await script.steps(tools);
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

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");
const { runRoleInProcess, _settleInProcessRunsForTests } = await import("../src/runtime/inProcessRun.js");

describe("агент роли внутри сервера", () => {
  let app: FastifyInstance;
  let ownerId: string;

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

  it("сбой запуска — карточка заблокирована с причиной", async () => {
    const { taskId } = builderTask("Упадёт посреди работы");
    script.steps = async (tools) => {
      await call(tools, "taskflow_claim", { id: taskId });
      throw new Error("провайдер не ответил");
    };
    await runRoleInProcess({ taskId, role: "builder" });
    await _settleInProcessRunsForTests();

    const task = db.prepare("SELECT agent_state FROM tasks WHERE id = ?").get(taskId) as { agent_state: string };
    expect(task.agent_state).toBe("blocked");
    const c = db
      .prepare("SELECT text FROM comments WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(taskId) as { text: string };
    expect(c.text).toContain("провайдер не ответил");
  });

  it("роль не из списка не запускается", async () => {
    const { taskId } = builderTask("Чужая роль");
    await expect(runRoleInProcess({ taskId, role: "synthesizer" })).rejects.toThrow(/нет или она отключена/);
  });
});
