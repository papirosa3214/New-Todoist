// Карточка 8aa95906, шаг admission: durable fingerprint и admission_cycle.
// Покрывает четыре сценария admission: 1) compare-and-swap-claim по
// fingerprint отбивает второй старт, не создавая новый attempts;
// 2) recovery между claim и dispatch закрывает старую попытку;
// 3) changes_requested от critic увеличивает admission_cycle и сбрасывает
// fingerprint у открытых узлов того же плана; 4) повторный старт после
// interrupted идёт в новом цикле.
//
// runRoleInProcess подменён через vi.spyOn (паттерн из slotRestart.test.ts):
// мок на лету не затыкается на внутренний http-обмен при activity-эмите.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import {
  closeOpenCriticPlanNode,
  recoverInterruptedPlanSubtasks,
  startPlanSubtaskRun,
} from "../src/runtime/planSubtaskAdmission.js";
import * as runtime from "../src/runtime/inProcessRun.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

const uid = () => crypto.randomUUID();

function seedPlan(taskId: string): {
  planId: string;
  executorId: string;
  reviewerId: string;
  followUpId: string;
} {
  const planId = uid();
  db.prepare(
    `INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, rationale, created_by)
     VALUES (?, ?, 1, 'approved', 'manual', 'тест admission cycle', 'role_builder')`,
  ).run(planId, taskId);
  const executorId = uid();
  const reviewerId = uid();
  const followUpId = uid();
  db.prepare(
    `INSERT INTO subtasks (id, task_id, title, position, collaboration_plan_id, plan_node_key, done)
     VALUES (?, ?, 'work', 1, ?, 'work', 0),
            (?, ?, 'follow_up', 3, ?, 'follow_up', 0),
            (?, ?, 'review', 4, ?, 'review', 0)`,
  ).run(
    executorId, taskId, planId,
    followUpId, taskId, planId,
    reviewerId, taskId, planId,
  );
  db.prepare(
    `INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result)
     VALUES (?, ?, 'work', 'builder', 1, 'результат'),
            (?, ?, 'review', 'critic_verifier', 1, 'вердикт'),
            (?, ?, 'follow_up', 'builder', 1, 'доработка')`,
  ).run(uid(), planId, uid(), planId, uid(), planId);
  db.prepare(
    `INSERT INTO task_collaboration_plan_edges (id, plan_id, from_slot_key, to_slot_key, start_condition)
     VALUES (?, ?, 'work', 'follow_up', 'submitted'),
            (?, ?, 'follow_up', 'review', 'submitted')`,
  ).run(uid(), planId, uid(), planId);
  return { planId, executorId, reviewerId, followUpId };
}

describe("admission: durable fingerprint и cycle", () => {
  let app: FastifyInstance;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    db.prepare("UPDATE users SET task_intake_mode='manual' WHERE role='owner'").run();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Cycle owner", email: `cycle-${Date.now()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  }, 15000);

  beforeEach(() => {
    db.pragma("foreign_keys = OFF");
    try {
      db.prepare("DELETE FROM comments WHERE task_id LIKE 'task-cycle-%'").run();
      db.prepare("DELETE FROM attempts WHERE task_id LIKE 'task-cycle-%'").run();
      db.prepare("DELETE FROM task_collaboration_plan_edges WHERE plan_id IN (SELECT id FROM task_collaboration_plans WHERE task_id LIKE 'task-cycle-%')").run();
      db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id IN (SELECT id FROM task_collaboration_plans WHERE task_id LIKE 'task-cycle-%')").run();
      db.prepare("DELETE FROM subtasks WHERE task_id LIKE 'task-cycle-%'").run();
      db.prepare("DELETE FROM task_collaboration_plans WHERE task_id LIKE 'task-cycle-%'").run();
      db.prepare("DELETE FROM tasks WHERE id LIKE 'task-cycle-%'").run();
    } finally {
      db.pragma("foreign_keys = ON");
    }
    vi.spyOn(runtime, "runRoleInProcess").mockResolvedValue({
      runId: "spy-run-id",
      completion: Promise.resolve(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function makeTask(): {
    taskId: string;
    executorId: string;
    reviewerId: string;
    followUpId: string;
    planId: string;
  } {
    const taskId = `task-cycle-${uid()}`;
    db.prepare(
      "INSERT INTO tasks (id, title, creator_id, assignee_id, status) VALUES (?, 'admission cycle', ?, ?, 'active')",
    ).run(taskId, ownerId, ownerId);
    const { planId, executorId, reviewerId, followUpId } = seedPlan(taskId);
    return { taskId, executorId, reviewerId, followUpId, planId };
  }

  it("одновременные claim'ы для одного узла дают только одну попытку", async () => {
    const { executorId } = makeTask();
    const first = await startPlanSubtaskRun(executorId, roleUserId("builder"));
    expect(first.ok).toBe(true);
    const second = await startPlanSubtaskRun(executorId, roleUserId("builder"));
    expect(second.ok).toBe(false);
    const active = db
      .prepare("SELECT COUNT(*) AS n FROM attempts WHERE subtask_id = ? AND ended_at IS NULL")
      .get(executorId) as { n: number };
    expect(active.n).toBe(1);
    const cycleRow = db
      .prepare("SELECT admission_cycle, admission_fingerprint FROM subtasks WHERE id = ?")
      .get(executorId) as { admission_cycle: number; admission_fingerprint: string | null };
    expect(cycleRow.admission_cycle).toBe(1);
    expect(cycleRow.admission_fingerprint).toBeTruthy();
  });

  it("recovery: попытка становится interrupted, новый старт получает cycle=2", async () => {
    const { executorId } = makeTask();
    const first = await startPlanSubtaskRun(executorId, roleUserId("builder"));
    expect(first.ok).toBe(true);
    const beforeAttempt = db
      .prepare("SELECT id FROM attempts WHERE subtask_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
      .get(executorId) as { id: string };
    const result = await recoverInterruptedPlanSubtasks();
    expect(result.resumed).toBe(1);
    const oldAttempt = db
      .prepare("SELECT outcome FROM attempts WHERE id = ?")
      .get(beforeAttempt.id) as { outcome: string };
    expect(oldAttempt.outcome).toBe("interrupted");
    const cycleRow = db
      .prepare("SELECT admission_cycle, admission_fingerprint FROM subtasks WHERE id = ?")
      .get(executorId) as { admission_cycle: number; admission_fingerprint: string | null };
    expect(cycleRow.admission_cycle).toBe(2);
    expect(cycleRow.admission_fingerprint).toBeTruthy();
  });

  it("changes_requested сбрасывает admission_fingerprint и поднимает admission_cycle у открытого follow_up", () => {
    const { taskId, executorId, reviewerId, followUpId } = makeTask();
    db.prepare("UPDATE subtasks SET done = 1 WHERE id = ?").run(executorId);
    db.prepare("UPDATE subtasks SET admission_cycle = 0, admission_fingerprint = ? WHERE id = ?").run("stale-fingerprint", followUpId);
    db.prepare("UPDATE subtasks SET agent_state = NULL, current_attempt_id = NULL WHERE id = ?").run(reviewerId);
    const closed = closeOpenCriticPlanNode(taskId, "changes_requested", "переделать", null);
    expect(closed).toBe(true);
    const row = db
      .prepare("SELECT admission_cycle, admission_fingerprint FROM subtasks WHERE id = ?")
      .get(followUpId) as { admission_cycle: number; admission_fingerprint: string | null };
    expect(row.admission_cycle).toBe(1);
    expect(row.admission_fingerprint).toBeNull();
  });

  it("повторный startPlanSubtaskRun после interrupted стартует новый цикл", async () => {
    const { executorId } = makeTask();
    const first = await startPlanSubtaskRun(executorId, roleUserId("builder"));
    expect(first.ok).toBe(true);
    // Имитация сбоя: тот же effect, что делает recoverInterruptedPlanSubtasks
    // для в-progress узла, но без повторного auto-runner'а — мы сразу
    // проверим, что новый startPlanSubtaskRun стартует в новом цикле.
    db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'interrupted', reason = 'manual' WHERE subtask_id = ? AND ended_at IS NULL").run(executorId);
    db.prepare("UPDATE subtasks SET agent_state = NULL, agent_id = NULL, current_attempt_id = NULL WHERE id = ?").run(executorId);
    const second = await startPlanSubtaskRun(executorId, roleUserId("builder"));
    expect(second.ok).toBe(true);
    const after = db
      .prepare("SELECT admission_cycle, admission_fingerprint FROM subtasks WHERE id = ?")
      .get(executorId) as { admission_cycle: number; admission_fingerprint: string | null };
    expect(after.admission_cycle).toBe(2);
    expect(after.admission_fingerprint).toBeTruthy();
  });
});
