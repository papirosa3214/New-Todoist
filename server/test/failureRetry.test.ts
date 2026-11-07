// Повтор шага по коду причины на сервере (MAK-97, пункт 3): временный сбой
// `settleStalledPlanNode` повторяет сам (число повторов ограничено), доступ и
// отсутствие модели блокируют сразу, переполнение контекста продолжается.
// Запуск роли подменён: проверяем именно решение сервера.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

const started: string[] = [];
vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: async () => ({ runId: "stub", completion: Promise.resolve() }) };
});

import db from "../src/db.js";
import { roleUserId } from "../src/roleRouting.js";
import { settleStalledPlanNode } from "../src/runtime/planSubtaskAdmission.js";
import { buildApp } from "../src/index.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
  seedRoleAccounts(db);
});
afterAll(async () => { await app.close(); });

let seq = 0;
/** Плановый шаг «в работе» с открытой попыткой. */
function makeInProgressStep(role = "builder"): { taskId: string; subtaskId: string } {
  const ownerId = "u1";
  const taskId = crypto.randomUUID();
  db.prepare("INSERT INTO tasks (id, title, status, creator_id) VALUES (?, ?, 'active', ?)").run(taskId, `retry ${++seq}`, ownerId);
  const planId = crypto.randomUUID();
  db.prepare("INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, created_by) VALUES (?, ?, 1, 'approved', 'full_cycle', ?)").run(planId, taskId, ownerId);
  const slot = "executor";
  db.prepare("INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result, output_artifact_json) VALUES (?, ?, ?, ?, 1, 'x', '{}')")
    .run(crypto.randomUUID(), planId, slot, role);
  const subtaskId = crypto.randomUUID();
  db.prepare("INSERT INTO subtasks (id, task_id, title, done, position, collaboration_plan_id, plan_node_key) VALUES (?, ?, 'шаг', 0, 0, ?, ?)")
    .run(subtaskId, taskId, planId, slot);
  const attemptId = crypto.randomUUID();
  db.prepare("INSERT INTO attempts (id, task_id, subtask_id, executor_id, started_at) VALUES (?, ?, ?, ?, datetime('now'))")
    .run(attemptId, taskId, subtaskId, roleUserId(role));
  db.prepare("UPDATE subtasks SET agent_state='in_progress', agent_id=?, current_attempt_id=? WHERE id=?").run(roleUserId(role), attemptId, subtaskId);
  return { taskId, subtaskId };
}

/** Следы предыдущих повторов по коду — как их оставил бы прошлый ход. */
function seedRetries(subtaskId: string, taskId: string, code: string, n: number): void {
  for (let i = 0; i < n; i++) {
    db.prepare("INSERT INTO attempts (id, task_id, subtask_id, executor_id, started_at, ended_at, outcome, reason) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 'transient_retry', ?)")
      .run(crypto.randomUUID(), taskId, subtaskId, roleUserId("builder"), `${code}: след прошлого повтора`);
  }
}

const attemptOutcomes = (taskId: string): string[] =>
  (db.prepare("SELECT outcome FROM attempts WHERE task_id = ? ORDER BY started_at, rowid").all(taskId) as Array<{ outcome: string | null }>).map((r) => r.outcome ?? "");

const events = (taskId: string, kind: string): Array<{ to_value: string }> =>
  db.prepare("SELECT to_value FROM task_events WHERE task_id = ? AND kind = ? ORDER BY rowid").all(taskId, kind) as Array<{ to_value: string }>;

describe("повтор по коду причины", () => {
  beforeEach(() => {
    started.length = 0;
  });

  it("временная ошибка сервера повторяется: попытка помечена retry, шаг перезапущен", async () => {
    const { taskId, subtaskId } = makeInProgressStep();
    const result = await settleStalledPlanNode(
      { subtaskId, madeProgress: false, failure: "502 Bad Gateway: upstream server error" },
      async (id) => { started.push(id); return { ok: true, runId: "stub" }; },
    );
    expect(result).toBe("continued");
    expect(started).toEqual([subtaskId]);
    expect(attemptOutcomes(taskId)).toContain("transient_retry");
    expect(events(taskId, "plan_subtask_transient_retry")).toHaveLength(1);
  });

  it("после исчерпания потолка повторов временный сбой блокирует шаг", async () => {
    const { taskId, subtaskId } = makeInProgressStep();
    seedRetries(subtaskId, taskId, "provider_server_error", 2);
    const result = await settleStalledPlanNode(
      { subtaskId, madeProgress: false, failure: "503 service unavailable" },
      async (id) => { started.push(id); return { ok: true, runId: "stub" }; },
    );
    expect(result).toBe("blocked");
    expect(started).toEqual([]);
    const sub = db.prepare("SELECT agent_state FROM subtasks WHERE id = ?").get(subtaskId) as { agent_state: string };
    expect(sub.agent_state).toBe("blocked");
    expect(events(taskId, "step_abandoned")).toHaveLength(1);
  });

  it("403 — доступ: сразу блок, без повтора и без запуска", async () => {
    const { taskId, subtaskId } = makeInProgressStep();
    const result = await settleStalledPlanNode(
      { subtaskId, madeProgress: false, failure: "403 Forbidden: invalid api key" },
      async (id) => { started.push(id); return { ok: true, runId: "stub" }; },
    );
    expect(result).toBe("blocked");
    expect(started).toEqual([]);
    expect(attemptOutcomes(taskId)).not.toContain("transient_retry");
  });

  it("недоступная модель: сразу блок", async () => {
    const { taskId, subtaskId } = makeInProgressStep();
    const result = await settleStalledPlanNode(
      { subtaskId, madeProgress: false, failure: "model `opencode-go/qwen` is not available" },
      async (id) => { started.push(id); return { ok: true, runId: "stub" }; },
    );
    expect(result).toBe("blocked");
    expect(started).toEqual([]);
  });

  it("переполнение контекста сжимается и шаг продолжается", async () => {
    const { taskId, subtaskId } = makeInProgressStep();
    const result = await settleStalledPlanNode(
      { subtaskId, madeProgress: false, failure: "context_length_exceeded: too many tokens" },
      async (id) => { started.push(id); return { ok: true, runId: "stub" }; },
    );
    expect(result).toBe("continued");
    expect(started).toEqual([subtaskId]);
    expect(events(taskId, "plan_subtask_compress_continue")).toHaveLength(1);
  });

  it("лимит с исчерпанной цепочкой моделей блокирует, а не повторяет", async () => {
    const { taskId, subtaskId } = makeInProgressStep();
    const result = await settleStalledPlanNode(
      { subtaskId, madeProgress: false, failure: "лимит провайдера, запасных моделей нет: 429", failureCode: "provider_quota_limit" },
      async (id) => { started.push(id); return { ok: true, runId: "stub" }; },
    );
    expect(result).toBe("blocked");
    expect(started).toEqual([]);
    void taskId;
  });
});
