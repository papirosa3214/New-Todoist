import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { contextVersionOf } from "../src/runtime/taskContextVersion.js";

// Мост между обычной попыткой (assignee_id, /claim, /state) и её узлом в
// collaboration plan: основной исполнитель работает через обычный
// workflow, а не через slot API, и без моста узел плана никогда бы не
// сдвинулся — зависимые ноды (QA) вечно ждали бы события, которого не
// будет. См. docs/2026-09-28-parent-child-execution-context/JOURNAL.md.
describe("основная попытка ↔ узел collaboration plan", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let builderAuth: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Bridge owner", email: `bridge-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = `Bearer ${reg.json().token}`;
    builderAuth = `Bearer ${app.jwt.sign({ id: roleUserId("builder") })}`;
  });

  it("сдача основной попытки в review открывает QA-node и поднимает версию контекста", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `Bridge task ${crypto.randomUUID()}` } });
    const taskId = created.json().task.id as string;
    const versionBefore = contextVersionOf(taskId);

    const plan = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
      profile: "delivery", rationale: "тест моста",
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
    expect(buildSlot.state).toBe("ready");
    expect(qaSlot.state).toBe("waiting");

    await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, headers: { authorization: ownerAuth }, payload: { assignee_id: roleUserId("builder"), ready_for_pickup: true } });
    expect((await app.inject({ method: "POST", url: `/api/tasks/${taskId}/claim`, headers: { authorization: builderAuth }, payload: {} })).statusCode).toBe(200);
    const submit = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/state`, headers: { authorization: builderAuth }, payload: { state: "review", comment: "Готово: реализовано" } });
    expect(submit.statusCode).toBe(200);

    const slotsAfter = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/role-slots`, headers: { authorization: ownerAuth } })).json().slots;
    expect(slotsAfter.find((s: { plan_node_key: string }) => s.plan_node_key === "build").state).toBe("submitted");
    expect(slotsAfter.find((s: { plan_node_key: string }) => s.plan_node_key === "qa").state).toBe("ready");

    const bridged = db.prepare("SELECT to_value FROM task_events WHERE task_id = ? AND kind = 'primary_plan_slot_advanced'").all(taskId) as Array<{ to_value: string }>;
    expect(bridged).toHaveLength(1);
    expect(bridged[0].to_value).toBe("submitted");

    expect(contextVersionOf(taskId)).toBeGreaterThan(versionBefore);

    // Принятие владельцем поднимает основной узел до accepted, а не
    // возвращает его назад (SLOT_ORDER не откатывает уже пройденное).
    await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, headers: { authorization: ownerAuth }, payload: { status: "completed" } });
    const slotsFinal = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/role-slots`, headers: { authorization: ownerAuth } })).json().slots;
    expect(slotsFinal.find((s: { plan_node_key: string }) => s.plan_node_key === "build").state).toBe("accepted");
  });

  it("без approved plan мост молча ничего не делает", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `No plan ${crypto.randomUUID()}` } });
    const taskId = created.json().task.id as string;
    await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, headers: { authorization: ownerAuth }, payload: { assignee_id: roleUserId("builder"), ready_for_pickup: true } });
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/claim`, headers: { authorization: builderAuth }, payload: {} });
    const submit = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/state`, headers: { authorization: builderAuth }, payload: { state: "review", comment: "Готово" } });
    expect(submit.statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'primary_plan_slot_advanced'").get(taskId)).toEqual({ n: 0 });
  });
});
