// План совместной работы сдан → карточка на проверку (владелец 01.10.2026,
// T05). Считаются только узлы плана; к владельцу — после проверяющего.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: async () => ({ runId: "test-run", completion: Promise.resolve() }) };
});

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { finishCompletedPlans, finishPlanIfComplete } from "../src/runtime/planSubtaskAdmission.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("план сдан — карточка на проверку", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };

  async function cardWithPlan(title: string): Promise<{ taskId: string; planId: string }> {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: ownerAuth, payload: { title } });
    const taskId = task.json().task.id as string;
    // Личный шаг роли — не узел плана; сдачу держать не должен.
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/subtasks`, headers: ownerAuth, payload: { title: "Личная заметка архитектора" } });
    const plan = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: ownerAuth,
      payload: {
        profile: "manual",
        rationale: "тест",
        nodes: [
          { slot_key: "research", role_key: "researcher", required: true, expected_result: "Факты" },
          { slot_key: "critic", role_key: "critic_verifier", required: true, expected_result: "Итоговый вердикт" },
        ],
        edges: [{ from_slot_key: "research", to_slot_key: "critic", start_condition: "accepted" }],
      },
    });
    const planId = (plan.json().id ?? plan.json().plan?.id) as string;
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: ownerAuth });
    return { taskId, planId };
  }

  const setDone = (planId: string, key: string) =>
    db.prepare("UPDATE subtasks SET done = 1, agent_state = NULL, result = ? WHERE collaboration_plan_id = ? AND plan_node_key = ?")
      .run(`итог ${key}`, planId, key);
  const card = (taskId: string) => db.prepare("SELECT agent_state FROM tasks WHERE id = ?").get(taskId) as { agent_state: string | null };

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Plan owner", email: `plan-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };
  });

  afterAll(async () => {
    await app.close();
  });

  it("пока не все узлы сданы — карточка не трогается", async () => {
    const { taskId, planId } = await cardWithPlan("Неполный план");
    setDone(planId, "research");
    expect(finishPlanIfComplete(planId, taskId, null)).toBe(false);
    expect(card(taskId).agent_state).not.toBe("review");
  });

  it("все узлы сданы — review, версия результата, проверяющий в очереди; второй раз — ничего", async () => {
    const { taskId, planId } = await cardWithPlan("Полный план");
    setDone(planId, "research");
    setDone(planId, "critic");
    expect(finishPlanIfComplete(planId, taskId, null)).toBe(true);
    expect(card(taskId).agent_state).toBe("review");
    const version = db.prepare("SELECT result FROM artifact_versions WHERE task_id = ? ORDER BY version_no DESC LIMIT 1").get(taskId) as { result: string };
    expect(version.result).toContain("План совместной работы сдан");
    expect(version.result).toContain("итог critic");
    const job = db.prepare("SELECT reason FROM role_run_jobs WHERE task_id = ? AND dedupe_key = ?").get(taskId, `plan-review:${planId}`) as { reason: string };
    expect(job.reason).toBe("review");
    expect(finishPlanIfComplete(planId, taskId, null)).toBe(false);
  });

  it("при старте сервера подбирается уже сданный план", async () => {
    const { taskId, planId } = await cardWithPlan("Сдан до правки");
    setDone(planId, "research");
    setDone(planId, "critic");
    expect(finishCompletedPlans()).toBeGreaterThanOrEqual(1);
    expect(card(taskId).agent_state).toBe("review");
  });

  it("закрытие последнего узла через API сдаёт карточку", async () => {
    const { taskId, planId } = await cardWithPlan("Через API");
    setDone(planId, "research");
    const critic = db.prepare("SELECT id FROM subtasks WHERE collaboration_plan_id = ? AND plan_node_key = 'critic'").get(planId) as { id: string };
    const res = await app.inject({ method: "PATCH", url: `/api/subtasks/${critic.id}`, headers: ownerAuth, payload: { done: true } });
    expect(res.statusCode).toBeLessThan(300);
    expect(card(taskId).agent_state).toBe("review");
  });
});
