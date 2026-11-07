// tcpo_791b4519: согласование владельца остаётся доступным и возобновляет
// работу (карточка 61043857, владелец 09.10.2026).
//
// Сценарии (прямые вызовы, без API-approve — approve поднимает роль, что
// здесь лишнее; в остальных тестах approve покрыт):
//   1. Пока proposal ждёт владельца, finishPlanIfComplete НЕ переводит
//      карточку в review (корень инцидента).
//   2. Когда proposal закрыт (approve), карточка идёт на проверку штатно.
//   3. Когда proposal закрыт (reject), повторный reject/approve → 409.
//   4. Уведомление владельцу создаётся с типом plan_approval_request и
//      содержит идентификаторы task/plan/op в тексте.
//   5. После approve карточка остаётся активной, пока узлы плана не done.
//
// Владелец явно ограничил зону правки: finishPlanIfComplete +
// planMutations/notify + decidePlanProposal/apply. Уведомление —
// plan_approval_request вместо скрытого agent_state.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: async () => ({ runId: "test-run", completion: Promise.resolve() }) };
});

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { finishPlanIfComplete } from "../src/runtime/planSubtaskAdmission.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { applyPlanOps, decidePlanProposal, pendingPlanProposals } from "../src/runtime/planMutations.js";
import { roleUserId } from "../src/roleRouting.js";

describe("tcpo_791b4519: согласование владельца удерживает карточку и возобновляет шаг", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerIdValue: string;
  let researcherRole: string;
  let analystRole: string;

  function makeCardWithPlan(): { taskId: string; planId: string } {
    const taskId = "task_" + Math.random().toString(36).slice(2);
    const planId = "tcp_" + Math.random().toString(36).slice(2);
    db.prepare("INSERT INTO tasks (id, title, status, agent_state, creator_id, assignee_id, requires_reviewer_review, project_id) VALUES (?, 'Coordination approval test', 'active', NULL, ?, NULL, 1, NULL)")
      .run(taskId, ownerIdValue);
    db.prepare("INSERT INTO task_collaboration_plans (id, task_id, status, profile, rationale, revision, version, created_by, approved_by, approved_at) VALUES (?, ?, 'approved', 'manual', 'тест согласования', 1, 1, ?, ?, datetime('now'))")
      .run(planId, taskId, ownerIdValue, ownerIdValue);
    const insertNode = db.prepare(`INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result, origin, added_by) VALUES (?, ?, ?, ?, 1, ?, 'owner', ?)`);
    const insertEdge = db.prepare(`INSERT INTO task_collaboration_plan_edges (id, plan_id, from_slot_key, to_slot_key, start_condition) VALUES (?, ?, ?, ?, 'accepted')`);
    insertNode.run("tcpn_" + Math.random().toString(36).slice(2), planId, "research", "researcher", "Документ с фактами", ownerIdValue);
    insertNode.run("tcpn_" + Math.random().toString(36).slice(2), planId, "reviewer", "critic_verifier", "Итоговый вердикт", ownerIdValue);
    insertEdge.run("tcpe_" + Math.random().toString(36).slice(2), planId, "research", "reviewer");
    const insertSubtask = db.prepare(`INSERT INTO subtasks (id, task_id, title, position, agent_id, collaboration_plan_id, plan_node_key) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insertSubtask.run("sub_" + Math.random().toString(36).slice(2), taskId, "Документ с фактами", 1, researcherRole, planId, "research");
    insertSubtask.run("sub_" + Math.random().toString(36).slice(2), taskId, "Итоговый вердикт", 2, roleUserId("critic_verifier"), planId, "reviewer");
    return { taskId, planId };
  }

  // Возвращает opId. Требует, чтобы research был in_progress и не done —
  // тогда applyPlanOps примет правку от роли-research.
  function proposeOverBudget(planId: string): string {
    db.prepare("UPDATE subtasks SET agent_state='in_progress', done=0 WHERE collaboration_plan_id=? AND plan_node_key='research'").run(planId);
    const actor = { kind: "role" as const, id: researcherRole, slotKey: "research" };
    const bigOps = Array.from({ length: 6 }, (_, i) => ({ op: "add_step" as const, slot_key: `helper_${i}`, role_key: "researcher", expected_result: `Доп. шаг ${i}` }));
    const result = applyPlanOps(planId, bigOps, actor, { reason: "сверх бюджета" });
    expect(result.status).toBe("proposed");
    return (result as { opId: string }).opId;
  }
  function setDone(planId: string, key: string) {
    db.prepare("UPDATE subtasks SET done=1, agent_state=NULL, result=? WHERE collaboration_plan_id=? AND plan_node_key=?")
      .run(`итог ${key}`, planId, key);
  }
  const card = (taskId: string) => db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(taskId) as { agent_state: string | null };

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Coordination owner", email: `coord-owner-${Date.now()}@test`, password: "password123" } });
    ownerIdValue = reg.json().user.id as string;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerIdValue);
    researcherRole = (db.prepare("SELECT id FROM users WHERE role_key='researcher' LIMIT 1").get() as { id: string }).id;
    analystRole = (db.prepare("SELECT id FROM users WHERE role_key='analyst' LIMIT 1").get() as { id: string }).id;
  });
  afterAll(async () => { await app.close(); });

  it("pending proposal удерживает карточку — finishPlanIfComplete возвращает false", () => {
    const { taskId, planId } = makeCardWithPlan();
    const opId = proposeOverBudget(planId);
    // Proposal открыт, узлы плана не done — финализация не сработает.
    expect(finishPlanIfComplete(planId, taskId, null)).toBe(false);
    expect(card(taskId).agent_state).not.toBe("review");
    // Узлы плана done, proposal открыт — финализация всё равно не сработает.
    setDone(planId, "research");
    setDone(planId, "reviewer");
    expect(finishPlanIfComplete(planId, taskId, null)).toBe(false);
    expect(card(taskId).agent_state).not.toBe("review");
    // Уведомление владельцу — отдельный тип, с opId/planId/taskId в тексте.
    const notif = db.prepare("SELECT type, text FROM notifications WHERE user_id=? AND type='plan_approval_request' ORDER BY created_at DESC LIMIT 1").get(ownerIdValue) as { type: string; text: string } | undefined;
    expect(notif).toBeDefined();
    expect(notif!.text).toContain(`[op:${opId}`);
    expect(notif!.text).toContain(`plan:${planId}`);
    expect(notif!.text).toContain(`task:${taskId}`);
    // pendingPlanProposals возвращает запись.
    const pending = pendingPlanProposals(planId);
    expect(pending.find((p) => p.id === opId)).toBeDefined();
    // Чистим proposal.
    decidePlanProposal(opId, ownerIdValue, false);
  });

  it("после approve с выполненными всеми узлами — карточка уходит на проверку штатно", () => {
    const { taskId, planId } = makeCardWithPlan();
    const opId = proposeOverBudget(planId);
    const decided = decidePlanProposal(opId, ownerIdValue, true);
    expect(decided.status).toBe("applied");
    // Все узлы плана (включая добавленных помощников) — done.
    setDone(planId, "research");
    setDone(planId, "reviewer");
    for (let i = 0; i < 6; i++) setDone(planId, `helper_${i}`);
    expect(finishPlanIfComplete(planId, taskId, null)).toBe(true);
    expect(card(taskId).agent_state).toBe("review");
  });

  it("после reject — proposal закрыт, повторный reject/approve → 409", () => {
    const { planId } = makeCardWithPlan();
    const opId = proposeOverBudget(planId);
    const dec1 = decidePlanProposal(opId, ownerIdValue, false);
    expect(dec1.status).toBe("rejected");
    expect(() => decidePlanProposal(opId, ownerIdValue, false)).toThrow();
    expect(() => decidePlanProposal(opId, ownerIdValue, true)).toThrow();
    expect(pendingPlanProposals(planId)).toEqual([]);
  });

  it("approve не закрывает карточку сам по себе — карточка остаётся активной, пока узлы плана не done", () => {
    const { taskId, planId } = makeCardWithPlan();
    const opId = proposeOverBudget(planId);
    const decided = decidePlanProposal(opId, ownerIdValue, true);
    expect(decided.status).toBe("applied");
    // Узлы плана ещё не done — карточка остаётся активной.
    expect(finishPlanIfComplete(planId, taskId, null)).toBe(false);
    expect(card(taskId).agent_state).not.toBe("review");
  });
});
