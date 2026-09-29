import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

// unlockReadySlots (LOCK автостарта) теперь сама вызывает runRoleInProcess
// для только что открывшегося slot'а — подменяем его инспектируемой
// заглушкой, чтобы адресный тест ниже мог проверить сам факт вызова и не
// дёргал настоящую модель.
const runRoleInProcessMock = vi.hoisted(() => vi.fn(async () => ({ runId: "test-run", completion: Promise.resolve() })));
vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: runRoleInProcessMock };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("персональные task role slots", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let qaAuth: string;
  let builderAuth: string;
  let analystAuth: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Slots owner", email: `slots-${Date.now()}@test`, password: "password123" } });
    const ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
    ownerAuth = `Bearer ${reg.json().token}`;
    qaAuth = `Bearer ${app.jwt.sign({ id: roleUserId("qa") })}`;
    builderAuth = `Bearer ${app.jwt.sign({ id: roleUserId("builder") })}`;
    analystAuth = "Bearer " + app.jwt.sign({ id: roleUserId("analyst") });
  });

  it("выделяет QA отдельный slot и не пускает туда другую роль", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Slot task ${crypto.randomUUID()}` } });
    const taskId = created.json().task.id as string;
    expect((await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, headers: { authorization: ownerAuth }, payload: { assignee_id: roleUserId("builder") } })).statusCode).toBe(200);
    const slotCreated = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/role-slots`, headers: { authorization: ownerAuth }, payload: { slot_key: "qa_verifier", role_key: "qa" } });
    expect(slotCreated.statusCode).toBe(201);
    const slotId = slotCreated.json().slot.id as string;
    expect(slotCreated.json().slot.participant_id).toBe(roleUserId("qa"));

    const hidden = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/role-slots`, headers: { authorization: builderAuth } });
    expect(hidden.json().slots).toEqual([]);
    const intruder = await app.inject({ method: "POST", url: `/api/task-role-slots/${slotId}/state`, headers: { authorization: builderAuth }, payload: { state: "ready" } });
    expect(intruder.statusCode).toBe(403);

    expect((await app.inject({ method: "POST", url: `/api/task-role-slots/${slotId}/state`, headers: { authorization: qaAuth }, payload: { state: "ready" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/task-role-slots/${slotId}/state`, headers: { authorization: qaAuth }, payload: { state: "active" } })).statusCode).toBe(200);
    const submitted = await app.inject({ method: "POST", url: `/api/task-role-slots/${slotId}/result`, headers: { authorization: qaAuth }, payload: { result: "Проверил сценарий", evidence: [{ path: "reports/qa.md" }] } });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().slot.state).toBe("submitted");
    expect((await app.inject({ method: "POST", url: `/api/task-role-slots/${slotId}/state`, headers: { authorization: ownerAuth }, payload: { state: "accepted" } })).json().slot.state).toBe("accepted");
  });

  it("открывшийся по графу slot сам стартует роль — без ручного /run", async () => {
    runRoleInProcessMock.mockClear();
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Autostart task ${crypto.randomUUID()}` } });
    const taskId = created.json().task.id as string;
    const plan = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
      profile: "delivery", rationale: "тест автостарта",
      nodes: [
        { slot_key: "build", role_key: "builder", expected_result: "Код готов" },
        { slot_key: "qa", role_key: "qa", expected_result: "Проверено" },
      ],
      edges: [{ from_slot_key: "build", to_slot_key: "qa", start_condition: "submitted" }],
    } });
    expect(plan.statusCode).toBe(201);
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${plan.json().plan.id}/approve`, headers: { authorization: ownerAuth } });

    const slotsBefore = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/role-slots`, headers: { authorization: ownerAuth } })).json().slots;
    const buildSlot = slotsBefore.find((s: { plan_node_key: string }) => s.plan_node_key === "build");
    const qaSlot = slotsBefore.find((s: { plan_node_key: string }) => s.plan_node_key === "qa");
    // Корневой slot при approve тоже стартует сам — не только через
    // unlockReadySlots, но и напрямую в /approve (LOCK-249): владелец не
    // должен после утверждения ещё и дёргать /run руками для первого узла.
    expect(buildSlot.state).toBe("active");
    expect(qaSlot.state).toBe("waiting");
    expect(runRoleInProcessMock).toHaveBeenCalledTimes(1);
    expect(runRoleInProcessMock).toHaveBeenCalledWith(expect.objectContaining({ taskId, role: "builder", slotId: buildSlot.id, mode: "work" }));

    const submitted = await app.inject({ method: "POST", url: `/api/task-role-slots/${buildSlot.id}/result`, headers: { authorization: builderAuth }, payload: { result: "Готово", evidence: [{ path: "build.md" }] } });
    expect(submitted.statusCode).toBe(200);

    // QA открылся по графу (edge build -> qa, start_condition submitted) и,
    // без единого ручного /run, сам дошёл до active — unlockReadySlots его
    // и открыла, и сразу впрягла в работу через runRoleInProcess.
    const slotsAfter = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/role-slots`, headers: { authorization: ownerAuth } })).json().slots;
    const qaAfter = slotsAfter.find((s: { plan_node_key: string }) => s.plan_node_key === "qa");
    expect(qaAfter.state).toBe("active");
    expect(runRoleInProcessMock).toHaveBeenCalledTimes(2);
    expect(runRoleInProcessMock).toHaveBeenCalledWith(expect.objectContaining({ taskId, role: "qa", slotId: qaSlot.id, mode: "work" }));

    const startedEvent = db.prepare("SELECT field FROM task_events WHERE task_id = ? AND kind = 'role_slot_started'").all(taskId) as Array<{ field: string }>;
    expect(startedEvent.map((e) => e.field)).toEqual(expect.arrayContaining([buildSlot.slot_key, qaAfter.slot_key]));
  });
  it("versions structured artifacts and gates successor after owner acceptance", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: "Artifact lifecycle " + crypto.randomUUID() } });
    const taskId = created.json().task.id as string;
    const plan = await app.inject({ method: "POST", url: "/api/tasks/" + taskId + "/collaboration-plans", headers: { authorization: ownerAuth }, payload: {
      profile: "manual",
      nodes: [
        { slot_key: "analysis", role_key: "analyst", output_artifact: { key: "feature_spec", type: "specification", format: "json", required_fields: ["scope", "acceptance_criteria"] } },
        { slot_key: "delivery", role_key: "builder" },
      ],
      edges: [{ from_slot_key: "analysis", to_slot_key: "delivery", start_condition: "accepted", artifact_key: "feature_spec" }],
    } });
    await app.inject({ method: "POST", url: "/api/tasks/" + taskId + "/collaboration-plans/" + plan.json().plan.id + "/approve", headers: { authorization: ownerAuth } });
    const analysis = (await app.inject({ method: "GET", url: "/api/tasks/" + taskId + "/role-slots", headers: { authorization: ownerAuth } })).json().slots.find((s: { plan_node_key: string }) => s.plan_node_key === "analysis");

    expect((await app.inject({ method: "POST", url: "/api/task-role-slots/" + analysis.id + "/artifact", headers: { authorization: analystAuth }, payload: { summary: "incomplete", payload: { scope: "only scope" }, evidence: [] } })).statusCode).toBe(400);
    const submitted = await app.inject({ method: "POST", url: "/api/task-role-slots/" + analysis.id + "/artifact", headers: { authorization: analystAuth }, payload: { summary: "agreed", payload: { scope: "in", acceptance_criteria: ["works"] }, evidence: [{ path: "docs/spec.json" }] } });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().artifact.version_no).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/task-role-slots/" + analysis.id + "/artifact/accept", headers: { authorization: ownerAuth } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/tasks/" + taskId + "/role-slots", headers: { authorization: ownerAuth } })).json().slots.find((s: { plan_node_key: string }) => s.plan_node_key === "delivery").state).toBe("active");
  });

  it("uses only the latest artifact version for artifact_ready and revision", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: "Artifact revision " + crypto.randomUUID() } });
    const taskId = created.json().task.id as string;
    const plan = await app.inject({ method: "POST", url: "/api/tasks/" + taskId + "/collaboration-plans", headers: { authorization: ownerAuth }, payload: {
      profile: "manual",
      nodes: [
        { slot_key: "research", role_key: "analyst", output_artifact: { key: "research_brief", type: "brief", format: "json", required_fields: ["finding"] } },
        { slot_key: "qa", role_key: "qa" },
      ],
      edges: [{ from_slot_key: "research", to_slot_key: "qa", start_condition: "artifact_ready", artifact_key: "research_brief" }],
    } });
    expect(plan.statusCode).toBe(201);
    await app.inject({ method: "POST", url: "/api/tasks/" + taskId + "/collaboration-plans/" + plan.json().plan.id + "/approve", headers: { authorization: ownerAuth } });
    const research = (await app.inject({ method: "GET", url: "/api/tasks/" + taskId + "/role-slots", headers: { authorization: ownerAuth } })).json().slots.find((s: { plan_node_key: string }) => s.plan_node_key === "research");

    expect((await app.inject({ method: "POST", url: "/api/task-role-slots/" + research.id + "/artifact", headers: { authorization: analystAuth }, payload: { summary: "draft", payload: { finding: "first" }, evidence: [] } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/task-role-slots/" + research.id + "/artifact/revision-request", headers: { authorization: ownerAuth }, payload: { reason: "need evidence" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/task-role-slots/" + research.id + "/artifact", headers: { authorization: analystAuth }, payload: { summary: "rejected", payload: { finding: "second" }, evidence: [] } })).json().artifact.version_no).toBe(2);
    expect((await app.inject({ method: "POST", url: "/api/task-role-slots/" + research.id + "/artifact/reject", headers: { authorization: ownerAuth }, payload: { reason: "not sufficient" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/task-role-slots/" + research.id + "/artifact", headers: { authorization: analystAuth }, payload: { summary: "final", payload: { finding: "third" }, evidence: [{ path: "research.md" }] } })).json().artifact.version_no).toBe(3);

    const slots = (await app.inject({ method: "GET", url: "/api/tasks/" + taskId + "/role-slots", headers: { authorization: ownerAuth } })).json().slots;
    expect(slots.find((s: { plan_node_key: string }) => s.plan_node_key === "qa").state).toBe("active");
    expect(db.prepare("SELECT status FROM role_slot_artifact_versions WHERE slot_id = ? ORDER BY version_no").all(research.id)).toEqual([{ status: "revision_requested" }, { status: "rejected" }, { status: "submitted" }]);
  });

});
