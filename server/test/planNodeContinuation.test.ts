// Находка А30 (06.10.2026): шаг плана закончил ход без сдачи. Сервер сам
// продолжает его при прогрессе (до 3 раз) или видимо блокирует.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { settleStalledPlanNode } from "../src/runtime/planSubtaskAdmission.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

describe("шаг плана без сдачи: продолжить или заблокировать", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerToken: string;
  let taskId: string;
  let planId: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Owner", email: "owner@a30.test", password: "password123" } });
    ownerToken = reg.json().token;
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
    seedRoleAccounts(db);
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: `Bearer ${ownerToken}` }, payload: { title: "A30 demo" } });
    taskId = task.json().task.id;
    planId = crypto.randomUUID();
    db.prepare("INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, created_by) VALUES (?, ?, 1, 'approved', 'full_cycle', ?)").run(planId, taskId, ownerId);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Шаг «в работе» с открытой попыткой, как после хода без сдачи. */
  function makeNode(slot: string): { subtaskId: string; attemptId: string } {
    db.prepare("INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result, output_artifact_json, source_subtask_id) VALUES (?, ?, ?, 'builder', 1, 'x', '{}', NULL)")
      .run(crypto.randomUUID(), planId, slot);
    const subtaskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    db.prepare("INSERT INTO attempts (id, task_id, subtask_id, executor_id, started_at) VALUES (?, ?, NULL, ?, datetime('now'))").run(attemptId, taskId, ownerId);
    db.prepare("INSERT INTO subtasks (id, task_id, title, done, position, agent_state, current_attempt_id, collaboration_plan_id, plan_node_key) VALUES (?, ?, ?, 0, 0, 'in_progress', ?, ?, ?)")
      .run(subtaskId, taskId, `шаг ${slot}`, attemptId, planId, slot);
    db.prepare("UPDATE attempts SET subtask_id = ? WHERE id = ?").run(subtaskId, attemptId);
    return { subtaskId, attemptId };
  }
  const state = (id: string) => db.prepare("SELECT agent_state, current_attempt_id FROM subtasks WHERE id = ?").get(id) as { agent_state: string | null; current_attempt_id: string | null };
  const outcome = (id: string) => (db.prepare("SELECT outcome FROM attempts WHERE id = ?").get(id) as { outcome: string | null }).outcome;
  const okStarter = (calls: string[]) => async (id: string) => {
    calls.push(id);
    return { ok: true as const, runId: "stub" };
  };

  it("есть прогресс — шаг продолжается, попытка помечена «continued»", async () => {
    const { subtaskId, attemptId } = makeNode("cont1");
    const calls: string[] = [];
    const res = await settleStalledPlanNode({ subtaskId, madeProgress: true }, okStarter(calls));
    expect(res).toBe("continued");
    expect(calls).toEqual([subtaskId]);
    expect(outcome(attemptId)).toBe("continued");
    expect(state(subtaskId).agent_state).toBeNull();
  });

  it("нет прогресса — шаг блокируется, причина в ленте", async () => {
    const { subtaskId, attemptId } = makeNode("noprog");
    const calls: string[] = [];
    const res = await settleStalledPlanNode({ subtaskId, madeProgress: false }, okStarter(calls));
    expect(res).toBe("blocked");
    expect(calls).toEqual([]);
    expect(state(subtaskId).agent_state).toBe("blocked");
    expect(outcome(attemptId)).toBe("stalled");
    const note = db.prepare("SELECT text FROM comments WHERE task_id = ? AND text LIKE '«шаг noprog»%'").get(taskId) as { text: string } | undefined;
    expect(note?.text).toContain("заблокирован");
  });

  it("ошибка запуска — блокировка с причиной, а не вечное «в работе»", async () => {
    const { subtaskId, attemptId } = makeNode("fail");
    // Берём НЕПОВТОРЯЕМУЮ причину (доступ, MAK-97): временный сбой сервер
    // теперь повторяет сам, а фатальный — сразу блокирует, и вечно «в работе»
    // он не висит.
    const res = await settleStalledPlanNode({ subtaskId, madeProgress: true, failure: "403 Forbidden: invalid api key" }, okStarter([]));
    expect(res).toBe("blocked");
    expect(state(subtaskId).agent_state).toBe("blocked");
    expect(outcome(attemptId)).toBe("failed");
  });

  it("после трёх продолжений шаг блокируется, четвёртого нет", async () => {
    const { subtaskId } = makeNode("limit");
    const calls: string[] = [];
    for (let i = 0; i < 3; i++) {
      // каждый раз шаг снова «в работе» с новой открытой попыткой
      const res = await settleStalledPlanNode({ subtaskId, madeProgress: true }, async (id: string) => {
        calls.push(id);
        const att = crypto.randomUUID();
        db.prepare("INSERT INTO attempts (id, task_id, subtask_id, executor_id, started_at) VALUES (?, ?, ?, ?, datetime('now'))").run(att, taskId, id, ownerId);
        db.prepare("UPDATE subtasks SET agent_state='in_progress', current_attempt_id=? WHERE id=?").run(att, id);
        return { ok: true as const, runId: "stub" };
      });
      expect(res).toBe("continued");
    }
    expect(calls.length).toBe(3);
    const fourth = await settleStalledPlanNode({ subtaskId, madeProgress: true }, okStarter(calls));
    expect(fourth).toBe("blocked");
    expect(calls.length).toBe(3);
    expect(state(subtaskId).agent_state).toBe("blocked");
  });

  it("сданный шаг и шаг без запуска не трогаются", async () => {
    const { subtaskId } = makeNode("done1");
    db.prepare("UPDATE subtasks SET done = 1 WHERE id = ?").run(subtaskId);
    expect(await settleStalledPlanNode({ subtaskId, madeProgress: false }, okStarter([]))).toBe("skipped");
    const idle = makeNode("idle1");
    db.prepare("UPDATE subtasks SET agent_state = NULL WHERE id = ?").run(idle.subtaskId);
    expect(await settleStalledPlanNode({ subtaskId: idle.subtaskId, madeProgress: true }, okStarter([]))).toBe("skipped");
  });
});
