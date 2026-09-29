import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

const runRoleInProcessMock = vi.hoisted(() => vi.fn(async () => ({ runId: "test-run", completion: Promise.resolve() })));
vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: runRoleInProcessMock };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { buildCollaborationPlanContext } from "../src/runtime/collaborationPlanContext.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("CollaborationPlanContext builder", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let analystAuth: string;
  let architectAuth: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Collab context owner", email: `collab-ctx-${Date.now()}@test`, password: "password123" } });
    const ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
    ownerAuth = `Bearer ${reg.json().token}`;
    analystAuth = `Bearer ${app.jwt.sign({ id: roleUserId("analyst") })}`;
    architectAuth = `Bearer ${app.jwt.sign({ id: roleUserId("architect") })}`;
  });

  it("собирает только прямые submitted+-артефакты предшественников, в порядке edges, без несвязанного узла", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: "Collab context " + crypto.randomUUID() } });
    const taskId = created.json().task.id as string;
    const plan = await app.inject({
      method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
        profile: "manual",
        nodes: [
          { slot_key: "analysis", role_key: "analyst", output_artifact: { key: "feature_spec", type: "specification", format: "json", required_fields: ["scope"] } },
          { slot_key: "architecture", role_key: "architect", output_artifact: { key: "architecture_decision", type: "decision", format: "json", required_fields: ["decision"] } },
          { slot_key: "unrelated", role_key: "qa" },
          { slot_key: "delivery", role_key: "builder" },
        ],
        edges: [
          { from_slot_key: "analysis", to_slot_key: "delivery", start_condition: "accepted", artifact_key: "feature_spec" },
          { from_slot_key: "architecture", to_slot_key: "delivery", start_condition: "accepted", artifact_key: "architecture_decision" },
        ],
      },
    });
    expect(plan.statusCode).toBe(201);
    const planId = plan.json().plan.id as string;
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: { authorization: ownerAuth } });

    const subtasks = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: ownerAuth } })).json() as Array<{ id: string; plan_node_key: string }>;
    const byKey = (key: string) => subtasks.find((s) => s.plan_node_key === key)!;

    // start_condition="accepted" требует статус artifact accepted — сдача
    // сама закрывает узел (done=1), явный /accept владельца — отдельная
    // запись поверх, как и раньше у slots.
    await app.inject({ method: "POST", url: `/api/subtasks/${byKey("analysis").id}/artifact`, headers: { authorization: analystAuth }, payload: { summary: "Согласован scope", payload: { scope: "в рамках" }, evidence: [{ path: "docs/spec.json" }] } });
    await app.inject({ method: "POST", url: `/api/subtasks/${byKey("analysis").id}/artifact/accept`, headers: { authorization: ownerAuth } });
    await app.inject({ method: "POST", url: `/api/subtasks/${byKey("architecture").id}/artifact`, headers: { authorization: architectAuth }, payload: { summary: "Решение принято", payload: { decision: "монолит" }, evidence: [] } });
    await app.inject({ method: "POST", url: `/api/subtasks/${byKey("architecture").id}/artifact/accept`, headers: { authorization: ownerAuth } });

    const context = buildCollaborationPlanContext(byKey("delivery").id);

    expect(context.status).toBe("ok");
    expect(context.plan_id).toBe(planId);
    expect(context.revision).toBe(1);
    expect(context.slot_key).toBe("delivery");
    expect(context.predecessor_artifacts.map((a) => a.slot_key)).toEqual(["analysis", "architecture"]);
    expect(context.predecessor_artifacts[0]).toMatchObject({ artifact_key: "feature_spec", summary: "Согласован scope", payload: { scope: "в рамках" }, evidence: [{ path: "docs/spec.json" }] });
    expect(context.predecessor_artifacts[1]).toMatchObject({ artifact_key: "architecture_decision", summary: "Решение принято", payload: { decision: "монолит" } });
    expect(context.predecessor_artifacts.map((a) => a.slot_key)).not.toContain("unrelated");
  });

  it("не открывает контекст, пока артефакт не достиг статуса gate-а edge", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: "Collab context gate " + crypto.randomUUID() } });
    const taskId = created.json().task.id as string;
    const plan = await app.inject({
      method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
        profile: "manual",
        nodes: [
          { slot_key: "analysis", role_key: "analyst", output_artifact: { key: "feature_spec", type: "specification", format: "json", required_fields: ["scope"] } },
          { slot_key: "delivery", role_key: "builder" },
        ],
        edges: [{ from_slot_key: "analysis", to_slot_key: "delivery", start_condition: "accepted", artifact_key: "feature_spec" }],
      },
    });
    const planId = plan.json().plan.id as string;
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: { authorization: ownerAuth } });
    const subtasks = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: ownerAuth } })).json() as Array<{ id: string; plan_node_key: string }>;
    const analysis = subtasks.find((s) => s.plan_node_key === "analysis")!;
    const delivery = subtasks.find((s) => s.plan_node_key === "delivery")!;

    // Сдача без accept — artifact.status остаётся "submitted", а edge этого
    // теста требует "accepted": контекст остаётся пустым до явного accept.
    await app.inject({ method: "POST", url: `/api/subtasks/${analysis.id}/artifact`, headers: { authorization: analystAuth }, payload: { summary: "Черновик", payload: { scope: "в рамках" }, evidence: [] } });

    const context = buildCollaborationPlanContext(delivery.id);
    expect(context.status).toBe("empty");
    expect(context.predecessor_artifacts).toEqual([]);
  });

  it("возвращает unavailable для несуществующего узла", () => {
    expect(buildCollaborationPlanContext("missing-subtask-id").status).toBe("unavailable");
  });
});
