// Брошенные после перезапуска сервера узлы плана (владелец 01.10.2026,
// T05): роль пишет в ленту и продолжает; второй обрыв подряд — blocked.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Recovery owner", email: `recovery-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };

    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: ownerAuth, payload: { title: "Фабрика шаблона" } });
    taskId = task.json().task.id;
    const plan = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: ownerAuth,
      payload: { profile: "manual", rationale: "тест", nodes: [{ slot_key: "executor", role_key: "builder", required: true, expected_result: "Реализация" }], edges: [] },
    });
    expect(plan.statusCode).toBeLessThan(300);
    const approve = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${plan.json().id ?? plan.json().plan?.id}/approve`, headers: ownerAuth });
    expect(approve.statusCode).toBeLessThan(300);
    const row = db.prepare("SELECT id, agent_state FROM subtasks WHERE task_id = ? AND plan_node_key = 'executor'").get(taskId) as { id: string; agent_state: string };
    subtaskId = row.id;
    expect(row.agent_state).toBe("in_progress");
  });

  afterAll(async () => {
    await app.close();
  });

  const subtask = () => db.prepare("SELECT agent_state, current_attempt_id FROM subtasks WHERE id = ?").get(subtaskId) as { agent_state: string | null; current_attempt_id: string | null };
  const comments = () => (db.prepare("SELECT user_id, text FROM comments WHERE task_id = ? ORDER BY rowid").all(taskId) as Array<{ user_id: string; text: string }>);

  it("первый обрыв: попытка interrupted, роль пишет в ленту и продолжает", async () => {
    const before = subtask().current_attempt_id;
    const startedBefore = runs.count;
    expect(await recoverInterruptedPlanSubtasks()).toEqual({ resumed: 1, blocked: 0 });

    const old = db.prepare("SELECT outcome, ended_at FROM attempts WHERE id = ?").get(before) as { outcome: string; ended_at: string | null };
    expect(old.outcome).toBe("interrupted");
    expect(old.ended_at).toBeTruthy();
    expect(subtask().agent_state).toBe("in_progress");
    expect(subtask().current_attempt_id).not.toBe(before);
    expect(runs.count).toBe(startedBefore + 1);
    const last = comments().at(-1)!;
    expect(last.user_id).toBe(roleUserId("builder"));
    expect(last.text).toContain("сервер перезапустился. Продолжаю");
  });

  it("второй обрыв за полчаса: blocked и сообщение владельцу, без нового запуска", async () => {
    const startedBefore = runs.count;
    expect(await recoverInterruptedPlanSubtasks()).toEqual({ resumed: 0, blocked: 1 });
    expect(subtask().agent_state).toBe("blocked");
    expect(runs.count).toBe(startedBefore);
    expect(comments().at(-1)!.text).toContain("Сам больше не продолжаю");
  });

  it("заблокированный узел при следующем старте не трогается", async () => {
    expect(await recoverInterruptedPlanSubtasks()).toEqual({ resumed: 0, blocked: 0 });
    expect(subtask().agent_state).toBe("blocked");
  });
});
