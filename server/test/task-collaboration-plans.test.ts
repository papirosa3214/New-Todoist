import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

// unlockReadyPlanSubtasks теперь сама стартует роль в открывшемся узле
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
import { buildCollaborationPlanContext } from "../src/runtime/collaborationPlanContext.js";

type PlanSubtask = { id: string; plan_node_key: string; done: number; agent_state: string | null };

describe("collaboration plans", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let researcherAuth: string;
  let architectAuth: string;
  let analystAuth: string;
  let designerAuth: string;
  let builderAuth: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Plan owner", email: `plan-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = `Bearer ${reg.json().token}`;
    researcherAuth = `Bearer ${app.jwt.sign({ id: roleUserId("researcher") })}`;
    architectAuth = `Bearer ${app.jwt.sign({ id: roleUserId("architect") })}`;
    analystAuth = `Bearer ${app.jwt.sign({ id: roleUserId("analyst") })}`;
    designerAuth = `Bearer ${app.jwt.sign({ id: roleUserId("designer") })}`;
    builderAuth = `Bearer ${app.jwt.sign({ id: roleUserId("builder") })}`;
  });

  const planSubtasks = async (taskId: string): Promise<Record<string, PlanSubtask>> => {
    const subtasks = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: ownerAuth } })).json() as Array<PlanSubtask & { collaboration_plan_id: string | null }>;
    return Object.fromEntries(subtasks.filter((s) => s.collaboration_plan_id).map((s) => [s.plan_node_key, s]));
  };

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

    let subtasks = await planSubtasks(taskId);
    // Корневой research стартует сам при approve — заглушка runRoleInProcess
    // резолвится сразу, поэтому узел уже in_progress ("active").
    expect(subtasks.research.agent_state).toBe("in_progress");
    expect(subtasks.architecture.agent_state).toBeNull();
    expect(subtasks.architecture.done).toBe(0);

    // Закрытие research (done=true, ai-исполнитель) — это и есть «сдал
    // результат»; на subtasks нет отдельного промежуточного submitted-без-
    // accept состояния, edge start_condition="accepted" без артефактного
    // контракта схлопывается в done=1 (см. planSubtaskAdmission.ts).
    expect((await app.inject({ method: "PATCH", url: `/api/subtasks/${subtasks.research.id}`, headers: { authorization: researcherAuth }, payload: { done: true, result: "Факты" } })).statusCode).toBe(200);

    // architecture открылся и сразу сам стартовал (unlockReadyPlanSubtasks
    // запускает runRoleInProcess для только что открытого узла) — заглушка
    // резолвится мгновенно, поэтому узел уже in_progress.
    subtasks = await planSubtasks(taskId);
    expect(subtasks.architecture.agent_state).toBe("in_progress");

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
    expect(plan.edges).toEqual([{ from_slot_key: "analysis", to_slot_key: "delivery", start_condition: "artifact_ready", artifact_key: "feature_spec" }]);

    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans/${plan.id}/approve`, headers: { authorization: ownerAuth } })).json().plan.status).toBe("approved");
    const subtasks = await planSubtasks(task.json().task.id);
    expect(subtasks.analysis.agent_state).toBe("in_progress");
    expect(subtasks.delivery.agent_state).toBeNull();
    expect(subtasks.delivery.done).toBe(0);
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
      "analysis->architecture:artifact_ready:feature_spec",
      "analysis->delivery:artifact_ready:feature_spec",
      "analysis->design:artifact_ready:feature_spec",
      "architecture->delivery:artifact_ready:architecture_decision",
      "delivery->qa:artifact_ready:implementation_pack",
      "design->delivery:artifact_ready:feature_ux_spec",
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
    const subtasks = await planSubtasks(task.json().task.id);
    expect(Object.keys(subtasks)).toHaveLength(5);
    expect(subtasks.analysis.agent_state).toBe("in_progress");
    expect(["architecture", "design", "delivery", "qa"].every((key) => subtasks[key].agent_state === null && subtasks[key].done === 0)).toBe(true);
  });

  it("T03 product_feature: неизвестный профиль по-прежнему отклоняется", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `T03 auto guard ${crypto.randomUUID()}` } });
    const badProfile = await app.inject({ method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "not_a_real_profile" } });
    expect(badProfile.statusCode).toBe(422);
  });

  it("T03 auto: диспетчер сам предлагает product_feature для ограниченной фичи с acceptance criteria", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `T03 auto pick ${crypto.randomUUID()}`, description: "Добавить новую фичу с acceptance criteria: новый экран с интерфейсом настроек" } });
    const autoProposal = await app.inject({ method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "auto" } });
    expect(autoProposal.statusCode).toBe(201);
    const plan = autoProposal.json().plan;
    expect(plan.profile).toBe("product_feature");
    // Есть сигнал "экран/интерфейс" — D1 должен включиться сам; про
    // архитектуру/миграции в тексте ни слова — H1 включаться не должен.
    expect(plan.nodes.map((n: { slot_key: string }) => n.slot_key).sort()).toEqual(["analysis", "delivery", "design", "qa"]);
  });

  it("T03 auto: подтверждённый баг/регрессия не подбирается как product_feature", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Баг в форме ${crypto.randomUUID()}`, description: "Экран не работает: форма падает с ошибкой при сохранении, нужно исправить регрессию" } });
    const autoProposal = await app.inject({ method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "auto" } });
    expect(autoProposal.json().plan.profile).not.toBe("product_feature");
  });

  it("T03 auto: чистый исследовательский вопрос без acceptance criteria не подбирается как product_feature", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Нужно ли это делать ${crypto.randomUUID()}`, description: "Стоит ли вообще добавлять такую фичу — нужно исследовать спрос" } });
    const autoProposal = await app.inject({ method: "POST", url: `/api/tasks/${task.json().task.id}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "auto" } });
    expect(autoProposal.json().plan.profile).not.toBe("product_feature");
  });

  it("T03 сквозной прогон (Task 5, владелец 29.09.2026): владелец утверждает только старт — дальше вся цепочка идёт по artifact_ready, без единого /accept", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `T03 e2e ${crypto.randomUUID()}` } });
    const taskId = task.json().task.id as string;
    const proposal = await app.inject({
      method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/propose`, headers: { authorization: ownerAuth },
      payload: { profile: "product_feature", include_architecture: true, include_design: true, include_qa: true },
    });
    const plan = proposal.json().plan;
    expect((await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${plan.id}/approve`, headers: { authorization: ownerAuth } })).json().plan.status).toBe("approved");

    // Analysis — корневой, стартует сам при approve. Это и есть
    // единственное участие владельца во всём пути — сам approve плана.
    let subtasks = await planSubtasks(taskId);
    expect(subtasks.analysis.agent_state).toBe("in_progress");
    expect(["architecture", "design", "delivery", "qa"].every((k) => subtasks[k].agent_state === null && subtasks[k].done === 0)).toBe(true);

    // Ни разу не вызываем /artifact/accept — gate artifact_ready требует
    // только submitted-статус с непустым evidence, дальше сервер открывает
    // successor сам, без участия владельца. Сдача структурного артефакта
    // сама закрывает узел (done=1) — см. subtask-artifacts.ts.
    const submitArtifact = async (subtaskId: string, auth: string, summary: string, payload: Record<string, unknown>, evidence: unknown[]) => {
      const submitted = await app.inject({ method: "POST", url: `/api/subtasks/${subtaskId}/artifact`, headers: { authorization: auth }, payload: { summary, payload, evidence } });
      expect(submitted.statusCode).toBe(201);
    };

    await submitArtifact(subtasks.analysis.id, analystAuth, "Согласован scope", { scope: "в рамках", out_of_scope: "не входит", acceptance_criteria: ["работает"], nfr: "нет", open_questions: ["нет"] }, [{ path: "docs/spec.json" }]);

    // Сдача A1 сама открыла и стартовала H1 и D1 — без единого /accept.
    subtasks = await planSubtasks(taskId);
    expect(subtasks.analysis.done).toBe(1);
    expect(subtasks.architecture.agent_state).toBe("in_progress");
    expect(subtasks.design.agent_state).toBe("in_progress");
    expect(subtasks.delivery.agent_state).toBeNull();

    await submitArtifact(subtasks.architecture.id, architectAuth, "Решение принято", { context: "фича", options: ["A", "B"], decision: "монолит", consequences: "проще эксплуатировать", rollout_rollback: "фиче-флаг" }, [{ path: "docs/adr.md" }]);
    await submitArtifact(subtasks.design.id, designerAuth, "UX согласован", { screens: ["main"], state_matrix: "loading/empty/ok", accessibility: "контраст AA", open_questions: ["нет"] }, [{ path: "docs/ux.md" }]);

    // V1 получает ровно три declared артефакта предшественников — не больше
    // и не меньше — прямо из builder-а Task 3, а не заново руками. Владелец
    // за весь путь не сделал ни одного /accept.
    subtasks = await planSubtasks(taskId);
    expect(subtasks.delivery.agent_state).toBe("in_progress");
    const deliveryContext = buildCollaborationPlanContext(subtasks.delivery.id);
    expect(deliveryContext.status).toBe("ok");
    expect(deliveryContext.predecessor_artifacts.map((a) => a.slot_key).sort()).toEqual(["analysis", "architecture", "design"]);
    expect(deliveryContext.predecessor_artifacts.map((a) => a.artifact_key).sort()).toEqual(["architecture_decision", "feature_spec", "feature_ux_spec"]);

    // V1 сдаёт implementation_pack — Q1 стартует сам по одному только
    // artifact_ready (submitted + evidence), как и было для этого шага раньше.
    const v1Submit = await app.inject({
      method: "POST", url: `/api/subtasks/${subtasks.delivery.id}/artifact`, headers: { authorization: builderAuth },
      payload: {
        summary: "Реализовано и собрано",
        payload: { change_refs: ["src/feature.ts"], build_id: "b123", test_report: "unit зелёные", deployment_notes: "фиче-флаг выключен по умолчанию", known_limitations: "нет" },
        evidence: [{ path: "docs/build-log.txt" }],
      },
    });
    expect(v1Submit.statusCode).toBe(201);

    subtasks = await planSubtasks(taskId);
    expect(subtasks.delivery.done).toBe(1);
    expect(subtasks.qa.agent_state).toBe("in_progress");

    const qaContext = buildCollaborationPlanContext(subtasks.qa.id);
    expect(qaContext.status).toBe("ok");
    expect(qaContext.predecessor_artifacts).toEqual([
      expect.objectContaining({ slot_key: "delivery", artifact_key: "implementation_pack" }),
    ]);
  });

  it("повторный /propose гасит старый draft — не плодит дубли рядом (живой инцидент 30.09.2026)", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Повторное предложение ${crypto.randomUUID()}` } });
    const taskId = task.json().task.id as string;
    const first = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "research" } });
    expect(first.json().plan.status).toBe("draft");
    const second = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "delivery" } });
    expect(second.json().plan.status).toBe("draft");

    const plans = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth } })).json().plans;
    expect(plans.map((p: { id: string; status: string }) => [p.id === first.json().plan.id, p.status])).toEqual(
      expect.arrayContaining([[true, "superseded"], [false, "draft"]]),
    );
    // Утвердить погашенный старый draft теперь нельзя.
    const approveOld = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${first.json().plan.id}/approve`, headers: { authorization: ownerAuth } });
    expect(approveOld.statusCode).toBe(409);
  });

  it("PATCH редактирует draft (нельзя редактировать approved/чужой профиль)", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Правка черновика ${crypto.randomUUID()}` } });
    const taskId = task.json().task.id as string;
    const created = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
      profile: "research", rationale: "Черновая причина",
      nodes: [{ slot_key: "research", role_key: "researcher", expected_result: "Факты" }],
      edges: [],
    } });
    const planId = created.json().plan.id as string;

    const patched = await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}/collaboration-plans/${planId}`, headers: { authorization: ownerAuth }, payload: {
      rationale: "Уточнённая причина",
      nodes: [
        { slot_key: "research", role_key: "researcher", expected_result: "Факты" },
        { slot_key: "analysis", role_key: "analyst", expected_result: "Выводы" },
      ],
      edges: [{ from_slot_key: "research", to_slot_key: "analysis" }],
    } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().plan.rationale).toBe("Уточнённая причина");
    expect(patched.json().plan.nodes.map((n: { slot_key: string }) => n.slot_key).sort()).toEqual(["analysis", "research"]);
    expect(patched.json().plan.revision).toBe(created.json().plan.revision); // правка на месте, не новая ревизия

    // Цикл в правке отклоняется, как и при создании.
    const cyclic = await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}/collaboration-plans/${planId}`, headers: { authorization: ownerAuth }, payload: {
      nodes: [{ slot_key: "step_one", role_key: "researcher" }, { slot_key: "step_two", role_key: "analyst" }],
      edges: [{ from_slot_key: "step_one", to_slot_key: "step_two" }, { from_slot_key: "step_two", to_slot_key: "step_one" }],
    } });
    expect(cyclic.statusCode).toBe(400);
    expect(cyclic.json().error).toContain("цикл");

    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: { authorization: ownerAuth } });
    const afterApprove = await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}/collaboration-plans/${planId}`, headers: { authorization: ownerAuth }, payload: { rationale: "поздно" } });
    expect(afterApprove.statusCode).toBe(409);
  });

  it("source_subtask_id: approve занимает уже существующую подзадачу вместо дубля (умная параллелизация)", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Занять подзадачу узлом ${crypto.randomUUID()}` } });
    const taskId = task.json().task.id as string;
    const plainSubtask = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: ownerAuth }, payload: { title: "Разобрать интеграцию с внешним API" } });
    expect(plainSubtask.statusCode).toBe(200);
    const subtaskId = plainSubtask.json().id as string;

    const plan = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
      profile: "manual",
      nodes: [{ slot_key: "delivery", role_key: "builder", expected_result: "Интеграция реализована", source_subtask_id: subtaskId }],
      edges: [],
    } });
    expect(plan.statusCode).toBe(201);
    expect(plan.json().plan.nodes[0].source_subtask_id).toBe(subtaskId);

    const before = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: ownerAuth } });
    expect(before.json()).toHaveLength(1); // ещё не approved — дубля нет, подзадача одна

    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${plan.json().plan.id}/approve`, headers: { authorization: ownerAuth } });

    const after = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: ownerAuth } });
    const afterList = after.json() as Array<{ id: string; collaboration_plan_id: string | null; plan_node_key: string | null; agent_id: string | null }>;
    expect(afterList).toHaveLength(1); // approve НЕ создал вторую строку — та же самая подзадача стала узлом
    expect(afterList[0].id).toBe(subtaskId);
    expect(afterList[0].collaboration_plan_id).toBe(plan.json().plan.id);
    expect(afterList[0].plan_node_key).toBe("delivery");
    expect(afterList[0].agent_id).toBe(roleUserId("builder"));
  });

  it("source_subtask_id: нельзя занять чужую/закрытую/уже-в-плане подзадачу", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Защита source_subtask_id ${crypto.randomUUID()}` } });
    const taskId = task.json().task.id as string;
    const otherTask = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Другая карточка ${crypto.randomUUID()}` } });
    const foreignSubtask = await app.inject({ method: "POST", url: `/api/tasks/${otherTask.json().task.id}/subtasks`, headers: { authorization: ownerAuth }, payload: { title: "Чужая подзадача" } });

    const rejected = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
      profile: "manual",
      nodes: [{ slot_key: "delivery", role_key: "builder", source_subtask_id: foreignSubtask.json().id }],
      edges: [],
    } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("source_subtask_id");
  });

  it("DELETE явно отклоняет draft, не трогая approved", async () => {
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Отказ от черновика ${crypto.randomUUID()}` } });
    const taskId = task.json().task.id as string;
    const created = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "delivery" } });
    const planId = created.json().plan.id as string;

    const declined = await app.inject({ method: "DELETE", url: `/api/tasks/${taskId}/collaboration-plans/${planId}`, headers: { authorization: ownerAuth } });
    expect(declined.statusCode).toBe(200);
    const plans = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth } })).json().plans;
    expect(plans[0].status).toBe("superseded");

    // Повторный DELETE на уже погашенном — 409, не тихий успех.
    const again = await app.inject({ method: "DELETE", url: `/api/tasks/${taskId}/collaboration-plans/${planId}`, headers: { authorization: ownerAuth } });
    expect(again.statusCode).toBe(409);

    // Не владелец (оркестратор/роль) отклонить не может — только владелец.
    const created2 = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/propose`, headers: { authorization: ownerAuth }, payload: { profile: "research" } });
    const forbidden = await app.inject({ method: "DELETE", url: `/api/tasks/${taskId}/collaboration-plans/${created2.json().plan.id}`, headers: { authorization: researcherAuth } });
    expect(forbidden.statusCode).toBe(403);
  });
});
