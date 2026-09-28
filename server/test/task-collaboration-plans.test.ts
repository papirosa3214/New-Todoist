import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

// unlockReadySlots теперь сама стартует роль в открывшемся slot'е
// (runRoleInProcess); этот файл проверяет только версии/переходы графа
// плана, не реальный запуск роли — подменяем runRoleInProcess лёгкой
// заглушкой, чтобы не дёргать настоящую модель.
vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: async () => ({ runId: "test-run", completion: Promise.resolve() }) };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("collaboration plans", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let researcherAuth: string;
  let architectAuth: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Plan owner", email: `plan-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = `Bearer ${reg.json().token}`;
    researcherAuth = `Bearer ${app.jwt.sign({ id: roleUserId("researcher") })}`;
    architectAuth = `Bearer ${app.jwt.sign({ id: roleUserId("architect") })}`;
  });

  it("хранит версию графа, не допускает цикл и заменяет утверждённую версию", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Plan task ${crypto.randomUUID()}` } });
    const taskId = created.json().task.id as string;
    const first = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
      profile: "full_cycle", rationale: "Нужны исследование и техническое решение", context_version: 3,
      nodes: [
        { slot_key: "research", role_key: "researcher", expected_result: "Факты и источники" },
        { slot_key: "architecture", role_key: "architect", expected_result: "Техническое решение" },
      ],
      edges: [{ from_slot_key: "research", to_slot_key: "architecture", start_condition: "accepted" }],
    } });
    expect(first.statusCode).toBe(201);
    expect(first.json().plan.revision).toBe(1);
    expect(first.json().plan.status).toBe("draft");
    expect(first.json().plan.nodes).toHaveLength(2);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${first.json().plan.id}/approve`, headers: { authorization: ownerAuth } })).json().plan.status).toBe("approved");
    const slots = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/role-slots`, headers: { authorization: ownerAuth } });
    const research = slots.json().slots.find((slot: { plan_node_key: string }) => slot.plan_node_key === "research");
    const architecture = slots.json().slots.find((slot: { plan_node_key: string }) => slot.plan_node_key === "architecture");
    expect([research.state, architecture.state]).toEqual(["ready", "waiting"]);
    expect((await app.inject({ method: "POST", url: `/api/task-role-slots/${architecture.id}/state`, headers: { authorization: architectAuth }, payload: { state: "ready" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/task-role-slots/${research.id}/state`, headers: { authorization: researcherAuth }, payload: { state: "active" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/task-role-slots/${research.id}/result`, headers: { authorization: researcherAuth }, payload: { result: "Факты", evidence: [{ path: "research.md" }] } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/task-role-slots/${research.id}/state`, headers: { authorization: ownerAuth }, payload: { state: "accepted" } })).statusCode).toBe(200);
    // architecture открылся и сразу сам стартовал (unlockReadySlots теперь
    // запускает runRoleInProcess для только что открытого slot'а) — заглушка
    // резолвится мгновенно, поэтому slot уже active, а не ready.
    expect((await app.inject({ method: "GET", url: `/api/tasks/${taskId}/role-slots`, headers: { authorization: ownerAuth } })).json().slots.find((slot: { id: string }) => slot.id === architecture.id).state).toBe("active");

    const cyclic = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
      profile: "manual", nodes: [{ slot_key: "analyst", role_key: "analyst" }, { slot_key: "designer", role_key: "designer" }],
      edges: [{ from_slot_key: "analyst", to_slot_key: "designer" }, { from_slot_key: "designer", to_slot_key: "analyst" }],
    } });
    expect(cyclic.statusCode).toBe(400);

    const second = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
      profile: "delivery", nodes: [{ slot_key: "delivery", role_key: "builder" }], edges: [],
    } });
    expect(second.json().plan.revision).toBe(2);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${second.json().plan.id}/approve`, headers: { authorization: ownerAuth } })).json().plan.status).toBe("approved");
    const plans = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth } });
    expect(plans.json().plans.map((plan: { revision: number; status: string }) => [plan.revision, plan.status])).toEqual([[2, "approved"], [1, "superseded"]]);
  });

  it("предлагает полный цикл как draft, не утверждая и не запуская роли", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `UI research ${crypto.randomUUID()}`, description: "Исследовать UX-варианты интерфейса и подготовить API-интеграцию" } });
    const proposal = await app.inject({ method: "POST", url: `/api/tasks/${created.json().task.id}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "auto", context_version: 4 } });
    expect(proposal.statusCode).toBe(201);
    expect(proposal.json().suggested).toBe(true);
    expect(proposal.json().plan.profile).toBe("full_cycle");
    expect(proposal.json().plan.status).toBe("draft");
    expect(proposal.json().plan.nodes.map((node: { role_key: string }) => node.role_key)).toEqual(expect.arrayContaining(["researcher", "analyst", "architect", "designer", "builder", "qa", "critic_verifier"]));
  });
});
