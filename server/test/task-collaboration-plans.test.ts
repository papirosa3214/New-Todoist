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
    // Корневой research стартует сам при approve (новая правка: startSlotRun
    // для корневых nodes, не только для открывшихся через unlockReadySlots)
    // — заглушка runRoleInProcess резолвится сразу, поэтому slot уже active.
    expect([research.state, architecture.state]).toEqual(["active", "waiting"]);
    expect((await app.inject({ method: "POST", url: `/api/task-role-slots/${architecture.id}/state`, headers: { authorization: architectAuth }, payload: { state: "ready" } })).statusCode).toBe(409);
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
  it("persists an artifact contract and validates artifact edge keys", async () => {
    const createPlan = async (nodes: unknown[], edges: unknown[]) => {
      const task = await app.inject({
        method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth },
        payload: { title: `Artifact contract ${crypto.randomUUID()}` },
      });
      return app.inject({
        method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans`, headers: { authorization: ownerAuth },
        payload: { profile: "manual", nodes, edges },
      });
    };
    const featureSpec = {
      key: "feature_spec", type: "specification", format: "json",
      required_fields: ["scope", "acceptance_criteria"],
    };
    const validNodes = [
      { slot_key: "analysis", role_key: "analyst", output_artifact: featureSpec },
      { slot_key: "delivery", role_key: "builder" },
    ];
    const valid = await createPlan(validNodes, [
      { from_slot_key: "analysis", to_slot_key: "delivery", artifact_key: "feature_spec" },
    ]);
    expect(valid.statusCode).toBe(201);
    expect(valid.json().plan.nodes.find((node: { slot_key: string }) => node.slot_key === "analysis").output_artifact).toEqual(featureSpec);
    expect(valid.json().plan.edges[0].artifact_key).toBe("feature_spec");

    expect((await createPlan([
      ...validNodes,
      { slot_key: "architecture", role_key: "architect", output_artifact: featureSpec },
    ], [])).statusCode).toBe(400);
    expect((await createPlan([
      { slot_key: "analysis", role_key: "analyst", output_artifact: { ...featureSpec, key: "Feature Spec" } },
    ], [])).statusCode).toBe(400);
    expect((await createPlan(validNodes, [
      { from_slot_key: "analysis", to_slot_key: "delivery", artifact_key: "implementation_pack" },
    ])).statusCode).toBe(400);
  });

  it("T03 product_feature: минимальный маршрут A1→V1 без флагов", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `T03 minimal ${crypto.randomUUID()}` } });
    const proposal = await app.inject({ method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "product_feature" } });
    expect(proposal.statusCode).toBe(201);
    const plan = proposal.json().plan;
    expect(plan.profile).toBe("product_feature");
    expect(plan.nodes.map((n: { slot_key: string }) => n.slot_key).sort()).toEqual(["analysis", "delivery"]);
    expect(plan.nodes.find((n: { slot_key: string }) => n.slot_key === "analysis").output_artifact).toMatchObject({ key: "feature_spec", required_fields: ["scope", "out_of_scope", "acceptance_criteria", "nfr", "open_questions"] });
    expect(plan.nodes.find((n: { slot_key: string }) => n.slot_key === "delivery").output_artifact).toMatchObject({ key: "implementation_pack" });
    expect(plan.edges).toEqual([{ from_slot_key: "analysis", to_slot_key: "delivery", start_condition: "accepted", artifact_key: "feature_spec" }]);

    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans/${plan.id}/approve`, headers: { authorization: ownerAuth } })).json().plan.status).toBe("approved");
    const slots = (await app.inject({ method: "GET", url: `/api/tasks/${task.json().task.id}/role-slots`, headers: { authorization: ownerAuth } })).json().slots as Array<{ plan_node_key: string; state: string }>;
    expect(slots.find((s) => s.plan_node_key === "analysis")!.state).toBe("active");
    expect(slots.find((s) => s.plan_node_key === "delivery")!.state).toBe("waiting");
  });

  it("T03 product_feature: включённые H1/D1/Q1 без висячих edges, отключённые — без ссылок на себя", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `T03 full ${crypto.randomUUID()}` } });
    const proposal = await app.inject({
      method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans/propose`, headers: { authorization: ownerAuth },
      payload: { profile: "product_feature", include_architecture: true, include_design: true, include_qa: true },
    });
    expect(proposal.statusCode).toBe(201);
    const plan = proposal.json().plan;
    expect(plan.nodes.map((n: { slot_key: string }) => n.slot_key).sort()).toEqual(["analysis", "architecture", "delivery", "design", "qa"]);
    const edgeSet = plan.edges.map((e: { from_slot_key: string; to_slot_key: string; start_condition: string; artifact_key: string }) => `${e.from_slot_key}->${e.to_slot_key}:${e.start_condition}:${e.artifact_key}`).sort();
    expect(edgeSet).toEqual([
      "analysis->architecture:accepted:feature_spec",
      "analysis->delivery:accepted:feature_spec",
      "analysis->design:accepted:feature_spec",
      "architecture->delivery:accepted:architecture_decision",
      "delivery->qa:artifact_ready:implementation_pack",
      "design->delivery:accepted:feature_ux_spec",
    ].sort());
    expect(plan.nodes.find((n: { slot_key: string }) => n.slot_key === "architecture").output_artifact).toMatchObject({ key: "architecture_decision" });
    expect(plan.nodes.find((n: { slot_key: string }) => n.slot_key === "design").output_artifact).toMatchObject({ key: "feature_ux_spec" });
    expect(plan.nodes.find((n: { slot_key: string }) => n.slot_key === "qa").output_artifact).toMatchObject({ key: "feature_test_report" });

    // Только Q1 без H1/D1 — delivery не должен получить висячую ссылку на
    // отключённые узлы, а qa-edge остаётся на месте.
    const task2 = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `T03 qa only ${crypto.randomUUID()}` } });
    const proposal2 = await app.inject({
      method: "POST", url: `/api/tasks/${task2.json().task.id}/collaboration-plans/propose`, headers: { authorization: ownerAuth },
      payload: { profile: "product_feature", include_qa: true },
    });
    const plan2 = proposal2.json().plan;
    expect(plan2.nodes.map((n: { slot_key: string }) => n.slot_key).sort()).toEqual(["analysis", "delivery", "qa"]);
    expect(plan2.edges.map((e: { from_slot_key: string; to_slot_key: string }) => `${e.from_slot_key}->${e.to_slot_key}`).sort()).toEqual(["analysis->delivery", "delivery->qa"]);

    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans/${plan.id}/approve`, headers: { authorization: ownerAuth } })).json().plan.status).toBe("approved");
    const slots = (await app.inject({ method: "GET", url: `/api/tasks/${task.json().task.id}/role-slots`, headers: { authorization: ownerAuth } })).json().slots as Array<{ plan_node_key: string; state: string }>;
    expect(slots).toHaveLength(5);
    expect(slots.find((s) => s.plan_node_key === "analysis")!.state).toBe("active");
    expect(["architecture", "design", "delivery", "qa"].every((key) => slots.find((s) => s.plan_node_key === key)!.state === "waiting")).toBe(true);
  });

  it("T03 product_feature: неизвестный профиль по-прежнему отклоняется, auto не подбирает T03 сам", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `T03 auto guard ${crypto.randomUUID()}`, description: "Добавить новую фичу с acceptance criteria" } });
    const badProfile = await app.inject({ method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "not_a_real_profile" } });
    expect(badProfile.statusCode).toBe(422);

    const autoProposal = await app.inject({ method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "auto" } });
    expect(autoProposal.json().plan.profile).not.toBe("product_feature");
  });
});
