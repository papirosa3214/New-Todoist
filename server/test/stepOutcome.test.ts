// Событие-исход запуска шага (MAK-96): любое завершение хода — сдача, блок,
// сбой, прерывание — пишет одно типизированное событие `step_outcome` с кодом
// из закрытого словаря. Проверяем каждое место записи сбоя и то, что исход
// виден в ленте карточки и попадает в сводку следующего шага.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

// Подмена запуска роли: сбой старта должен родить исход, а не настоящую модель.
const mock = vi.hoisted(() => ({
  impl: async (..._args: unknown[]) => ({ runId: `stub-${Math.random()}`, completion: Promise.resolve() }),
}));
vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: (...args: unknown[]) => mock.impl(...args) };
});

import db, { hashApiToken } from "../src/db.js";
import { buildApp } from "../src/index.js";
import { roleUserId } from "../src/roleRouting.js";
import { settleStalledPlanNode, unlockReadyPlanSubtasks } from "../src/runtime/planSubtaskAdmission.js";
import { buildTaskHistory } from "../src/runtime/taskHistoryContext.js";
import { latestStepOutcome, type StepOutcome } from "../src/runtime/stepOutcome.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

type OutcomeRow = { id: string; field: string | null; to_value: string; created_at: string };

const BUILDER_TOKEN = "step-outcome-builder-token";

describe("событие-исход запуска шага", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let ownerId: string;
  let builderAuth: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    db.prepare("UPDATE users SET task_intake_mode='manual' WHERE role='owner'").run();
    db.prepare("UPDATE users SET api_token = ? WHERE id = ?").run(hashApiToken(BUILDER_TOKEN), roleUserId("builder"));

    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Step outcome owner", email: `step-outcome-${Date.now()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };
    builderAuth = { authorization: `Bearer ${BUILDER_TOKEN}` };
  });

  afterAll(async () => {
    await app.close();
  });

  /** Тестовая карточка + утверждённый план с одним узлом роли-владельца шага. */
  async function makeCard(role: string = "builder"): Promise<{ taskId: string; subtaskId: string; planId: string }> {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: ownerAuth, payload: { title: `Исход шага ${Math.random()}` } });
    const taskId = task.json().task.id;
    const planId = crypto.randomUUID();
    db.prepare("INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, created_by) VALUES (?, ?, 1, 'approved', 'full_cycle', ?)").run(planId, taskId, ownerId);
    const slot = "executor";
    db.prepare("INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result, output_artifact_json, source_subtask_id) VALUES (?, ?, ?, ?, 1, 'x', '{}', NULL)")
      .run(crypto.randomUUID(), planId, slot, role);
    const subtaskId = crypto.randomUUID();
    db.prepare("INSERT INTO subtasks (id, task_id, title, done, position, collaboration_plan_id, plan_node_key) VALUES (?, ?, 'шаг исполнителя', 0, 0, ?, ?)")
      .run(subtaskId, taskId, planId, slot);
    return { taskId, subtaskId, planId };
  }

  /** Шаг «в работе» с открытой попыткой. */
  function markInProgress(subtaskId: string, role: string): void {
    const attemptId = crypto.randomUUID();
    db.prepare("INSERT INTO attempts (id, task_id, subtask_id, executor_id, started_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run(attemptId, (db.prepare("SELECT task_id FROM subtasks WHERE id=?").get(subtaskId) as { task_id: string }).task_id, subtaskId, roleUserId(role));
    db.prepare("UPDATE subtasks SET agent_state='in_progress', agent_id=?, current_attempt_id=? WHERE id=?").run(roleUserId(role), attemptId, subtaskId);
  }

  function outcomes(taskId: string): OutcomeRow[] {
    return db.prepare("SELECT id, field, to_value, created_at FROM task_events WHERE task_id = ? AND kind = 'step_outcome' ORDER BY rowid").all(taskId) as OutcomeRow[];
  }

  it("сбой старта шага (TaskContext таймаут) — исход failed с кодом taskcontext_timeout", async () => {
    const { taskId, planId } = await makeCard();
    mock.impl = async () => {
      throw new Error("сборка TaskContext v1 превысила 15 секунд");
    };
    await unlockReadyPlanSubtasks(planId, taskId, ownerId);
    mock.impl = async () => ({ runId: "stub", completion: Promise.resolve() });

    const rows = outcomes(taskId);
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0].to_value) as StepOutcome;
    expect(parsed.outcome).toBe("failed");
    expect(parsed.code).toBe("taskcontext_timeout");
    expect(parsed.slot_key).toBe("executor");
  });

  it("429 при старте шага — provider_rate_limit", async () => {
    const { taskId, planId } = await makeCard();
    mock.impl = async () => {
      throw new Error('429 {"error":{"message":"Rate limit reached"}}');
    };
    await unlockReadyPlanSubtasks(planId, taskId, ownerId);
    mock.impl = async () => ({ runId: "stub", completion: Promise.resolve() });

    const parsed = JSON.parse(outcomes(taskId)[0].to_value) as StepOutcome;
    expect(parsed.code).toBe("provider_rate_limit");
  });

  it("шаг без сдачи блокируется исходом blocked с кодом причины", async () => {
    const { taskId, subtaskId } = await makeCard();
    markInProgress(subtaskId, "builder");
    const result = await settleStalledPlanNode(
      { subtaskId, madeProgress: false, failure: "модель «opencode-go/qwen» недоступна" },
      async () => ({ ok: true, runId: "stub" }),
    );
    expect(result).toBe("blocked");

    const parsed = JSON.parse(outcomes(taskId)[0].to_value) as StepOutcome;
    expect(parsed.outcome).toBe("blocked");
    expect(parsed.code).toBe("model_unavailable");
    expect(latestStepOutcome(subtaskId)?.code).toBe("model_unavailable");
  });

  it("блок шага ролью через API — исход с кодом из текста блокера", async () => {
    const { taskId, subtaskId } = await makeCard("builder");
    markInProgress(subtaskId, "builder");
    const res = await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: builderAuth,
      payload: {
        state: "blocked",
        block_type: "capability",
        result: "403 Forbidden: invalid api key у провайдера",
        help_skip_reason: "это доступ к провайдеру, другая роль не снимет",
      },
    });
    expect(res.statusCode).toBeLessThan(300);

    const parsed = JSON.parse(outcomes(taskId)[0].to_value) as StepOutcome;
    expect(parsed.outcome).toBe("blocked");
    expect(parsed.code).toBe("provider_auth_or_access");
  });

  it("сдача шага галочкой — исход submitted без кода", async () => {
    const { taskId, subtaskId } = await makeCard("builder");
    markInProgress(subtaskId, "builder");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${subtaskId}`,
      headers: builderAuth,
      payload: { done: true, result: "Шаг выполнен и сдан." },
    });
    expect(res.statusCode).toBeLessThan(300);

    const parsed = JSON.parse(outcomes(taskId)[0].to_value) as StepOutcome;
    expect(parsed.outcome).toBe("submitted");
    expect(parsed.code).toBeNull();
  });

  it("исход виден в ленте карточки и попадает в сводку следующего шага", async () => {
    const { taskId, subtaskId } = await makeCard();
    mock.impl = async () => {
      throw new Error("сборка TaskContext v1 превысила 15 секунд");
    };
    const { planId } = db.prepare("SELECT collaboration_plan_id AS planId FROM subtasks WHERE id = ?").get(subtaskId) as { planId: string };
    await unlockReadyPlanSubtasks(planId, taskId, ownerId);
    mock.impl = async () => ({ runId: "stub", completion: Promise.resolve() });

    // Лента карточки: событие отдаётся владельцу как есть.
    const feed = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: ownerAuth });
    const events = (feed.json().events ?? []) as Array<{ kind: string; to_value: string }>;
    const outcomeEvents = events.filter((e) => e.kind === "step_outcome");
    expect(outcomeEvents).toHaveLength(1);
    expect((JSON.parse(outcomeEvents[0].to_value) as StepOutcome).code).toBe("taskcontext_timeout");

    // Сводка, которую получит следующий шаг карточки.
    const history = buildTaskHistory({ taskId, subtaskId: null });
    expect(history.block).toContain("Исходы запусков шагов");
    expect(history.block).toContain("taskcontext_timeout");
  });
});
