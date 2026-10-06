// Г1-л (06.10.2026): узел `critic_verifier` (revision ≥ 2) вынес
// `changes_requested`, его собственный узел плана остался `in_progress`,
// `builder_fix_*`/`critic_recheck_*` не открылись. `completePlanFinalReview`
// закрывает только финального проверяющего с маркером `[taskflow:final-review]`;
// здесь — обычный critic-узел без маркера, его должен закрыть
// `closeOpenCriticPlanNode` и при `changes_requested` открыть доработку.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime/inProcessRun.js")>()),
  runRoleInProcess: vi.fn(async () => ({ runId: "test-critic-run", completion: Promise.resolve() })),
}));

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { closeOpenCriticPlanNode } from "../src/runtime/planSubtaskAdmission.js";

describe("closeOpenCriticPlanNode (Г1-л)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: string;
  let auth: Record<string, string>;
  let task: string;
  let plan: string;
  let criticNode: { id: string; slot_key: string };

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    db.prepare("UPDATE users SET reviewer=1 WHERE id='role_critic_verifier'").run();
    db.prepare("UPDATE users SET task_intake_mode='manual' WHERE role='owner'").run();
    owner = `critic-owner-${crypto.randomUUID()}`;
    db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES(?,'Critic owner',?,'!','owner','human')").run(owner, `${owner}@test`);
    auth = { authorization: `Bearer ${app.jwt.sign({ id: owner })}` };

    const taskId = (await app.inject({ method: "POST", url: "/api/tasks", headers: auth, payload: { title: "Critic plan" } })).json().task.id as string;
    task = taskId;
    const planId = (await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: auth,
      payload: {
        profile: "manual",
        nodes: [
          { slot_key: "executor", role_key: "builder", required: true, expected_result: "Реализация" },
          { slot_key: "verifier", role_key: "critic_verifier", required: true, expected_result: "Верификация" },
        ],
        edges: [{ from_slot_key: "executor", to_slot_key: "verifier", start_condition: "submitted" }],
      },
    })).json().plan.id as string;
    plan = planId;
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: auth });
    // executor закрываем руками, чтобы `verifier` дождался предка.
    db.prepare("UPDATE subtasks SET done=1, agent_state=NULL, result='ok', agent_heartbeat_at=NULL WHERE task_id=? AND plan_node_key='executor'").run(taskId);
    // Запускаем critic-узел, чтобы он был `in_progress` (как в реальной жизни).
    const startCritic = app.inject({ method: "POST", url: `/api/tasks/${taskId}/subtasks/start`, headers: auth, payload: { slot_key: "verifier" } }).catch(() => null);
    void startCritic;
    const row = db.prepare("SELECT id, plan_node_key FROM subtasks WHERE task_id=? AND plan_node_key='verifier'").get(taskId) as { id: string; plan_node_key: string };
    criticNode = { id: row.id, slot_key: row.plan_node_key };
    // Если автозапуск не поднял, поднимем руками через прямой SQL.
    db.prepare("UPDATE subtasks SET agent_state='in_progress', agent_id=?, agent_heartbeat_at=datetime('now') WHERE id=?").run("role_critic_verifier", criticNode.id);
  });

  afterAll(async () => {
    await app.close();
  });

  it("changes_requested: закрывает critic-узел и помечает результат вердикта", () => {
    const before = db.prepare("SELECT done, agent_state, result FROM subtasks WHERE id=?").get(criticNode.id) as { done: number; agent_state: string | null; result: string | null };
    expect(before.done).toBe(0);
    expect(before.agent_state).toBe("in_progress");
    const closed = closeOpenCriticPlanNode(task, "changes_requested", "Нужны правки в финале", ["executor"]);
    expect(closed).toBe(true);
    const after = db.prepare("SELECT done, agent_state, result FROM subtasks WHERE id=?").get(criticNode.id) as { done: number; agent_state: string | null; result: string | null };
    expect(after.done).toBe(1);
    expect(after.agent_state).toBeNull();
    expect(after.result).toContain("changes_requested");
    // Должны были открыться rework-узлы (`executor_fix_*` + `critic_recheck_*`).
    const rework = db.prepare("SELECT slot_key, role_key, origin FROM task_collaboration_plan_nodes WHERE plan_id=? AND origin='rework' ORDER BY rowid").all(plan) as Array<{ slot_key: string; role_key: string; origin: string }>;
    expect(rework.length).toBeGreaterThan(0);
    expect(rework.some((n) => n.role_key === "builder")).toBe(true);
    // Recheck-узел — тоже critic_verifier.
    expect(rework.some((n) => n.role_key === "critic_verifier")).toBe(true);
  });

  it("approved: закрывает critic-узел без открытия rework", async () => {
    // Создадим отдельный план с critic-узлом, чтобы не ломать предыдущий тест.
    const task2 = (await app.inject({ method: "POST", url: "/api/tasks", headers: auth, payload: { title: "Critic plan approved" } })).json().task.id as string;
    const plan2 = (await app.inject({
      method: "POST",
      url: `/api/tasks/${task2}/collaboration-plans`,
      headers: auth,
      payload: {
        profile: "manual",
        nodes: [
          { slot_key: "executor", role_key: "builder", required: true, expected_result: "Реализация" },
          { slot_key: "verifier", role_key: "critic_verifier", required: true, expected_result: "Верификация" },
        ],
        edges: [{ from_slot_key: "executor", to_slot_key: "verifier", start_condition: "submitted" }],
      },
    })).json().plan.id as string;
    await app.inject({ method: "POST", url: `/api/tasks/${task2}/collaboration-plans/${plan2}/approve`, headers: auth });
    db.prepare("UPDATE subtasks SET done=1, agent_state=NULL, result='ok', agent_heartbeat_at=NULL WHERE task_id=? AND plan_node_key='executor'").run(task2);
    const verifier = db.prepare("SELECT id FROM subtasks WHERE task_id=? AND plan_node_key='verifier'").get(task2) as { id: string };
    db.prepare("UPDATE subtasks SET agent_state='in_progress', agent_id=?, agent_heartbeat_at=datetime('now') WHERE id=?").run("role_critic_verifier", verifier.id);
    const closed = closeOpenCriticPlanNode(task2, "approved", "OK", null);
    expect(closed).toBe(true);
    const after = db.prepare("SELECT done, agent_state, result FROM subtasks WHERE id=?").get(verifier.id) as { done: number; agent_state: string | null; result: string | null };
    expect(after.done).toBe(1);
    expect(after.result).toContain("approved");
    // Без rework: ни одного rework-узла.
    const rework = db.prepare("SELECT slot_key FROM task_collaboration_plan_nodes WHERE plan_id=? AND origin='rework'").all(plan2) as Array<{ slot_key: string }>;
    expect(rework.length).toBe(0);
  });
});
