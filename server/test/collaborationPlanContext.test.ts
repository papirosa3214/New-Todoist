import { roleReport } from "./helpers/roleReport.js";
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
import { canPlanSubtaskBecomeReady, waitingForPredecessors, type PlanSubtask } from "../src/runtime/planSubtaskAdmission.js";
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
    expect(db.prepare("SELECT start_condition FROM task_collaboration_plan_edges WHERE plan_id=?").all(planId)).toEqual(expect.arrayContaining([{start_condition:"submitted"}]));
    expect((await app.inject({method:"PATCH",url:`/api/tasks/${taskId}/integration-responsibility`,headers:{authorization:ownerAuth},payload:{mode:"manual",owner_id:"role_builder"}})).statusCode).toBe(200);
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: { authorization: ownerAuth } });

    const subtasks = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: ownerAuth } })).json() as Array<{ id: string; plan_node_key: string }>;
    const byKey = (key: string) => subtasks.find((s) => s.plan_node_key === key)!;

    // Сдача открывает передачу без предварительной приёмки владельца.
    await app.inject({ method: "POST", url: `/api/subtasks/${byKey("analysis").id}/artifact`, headers: { authorization: analystAuth }, payload: { report_markdown: roleReport, summary: "Согласован scope", payload: { scope: "в рамках" }, evidence: [{ path: "docs/spec.json" }] } });
    await app.inject({ method: "POST", url: `/api/subtasks/${byKey("architecture").id}/artifact`, headers: { authorization: architectAuth }, payload: { report_markdown: roleReport, summary: "Решение принято", payload: { decision: "монолит" }, evidence: [] } });

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

  it("передаёт submitted по старому ребру accepted без /accept", async () => {
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
    expect(db.prepare("SELECT start_condition FROM task_collaboration_plan_edges WHERE plan_id=?").all(planId)).toEqual(expect.arrayContaining([{start_condition:"submitted"}]));
    expect((await app.inject({method:"PATCH",url:`/api/tasks/${taskId}/integration-responsibility`,headers:{authorization:ownerAuth},payload:{mode:"manual",owner_id:"role_builder"}})).statusCode).toBe(200);
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: { authorization: ownerAuth } });
    const subtasks = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: ownerAuth } })).json() as Array<{ id: string; plan_node_key: string }>;
    db.prepare("UPDATE task_collaboration_plan_edges SET start_condition='accepted' WHERE plan_id=?").run(planId);
    const analysis = subtasks.find((s) => s.plan_node_key === "analysis")!;
    const delivery = subtasks.find((s) => s.plan_node_key === "delivery")!;

    // Старое ребро accepted тоже передаёт submitted-результат.
    await app.inject({ method: "POST", url: `/api/subtasks/${analysis.id}/artifact`, headers: { authorization: analystAuth }, payload: { report_markdown: roleReport, summary: "Черновик", payload: { scope: "в рамках" }, evidence: [] } });

    const context = buildCollaborationPlanContext(delivery.id);
    expect(context.status).toBe("ok");
    expect(context.predecessor_artifacts).toHaveLength(1);
    const row = db.prepare("SELECT * FROM subtasks WHERE id=?").get(delivery.id) as PlanSubtask;
    expect(canPlanSubtaskBecomeReady(row)).toBe(true);
    expect(waitingForPredecessors(row)).toEqual([]);
    expect((db.prepare("SELECT status FROM subtask_artifact_versions WHERE subtask_id=?").get(analysis.id) as {status:string}).status).toBe("submitted");
    expect(runRoleInProcessMock.mock.calls.length).toBeGreaterThan(0);
    for (const status of ["revision_requested", "rejected"]) {
      db.prepare("UPDATE subtask_artifact_versions SET status=? WHERE subtask_id=?").run(status, analysis.id);
      expect(canPlanSubtaskBecomeReady(row)).toBe(false);
      expect(buildCollaborationPlanContext(delivery.id).status).toBe("empty");
      expect(waitingForPredecessors(row)).toHaveLength(1);
    }

  });

  it("возвращает unavailable для несуществующего узла", () => {
    expect(buildCollaborationPlanContext("missing-subtask-id").status).toBe("unavailable");
  });
});
