import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("персональные task role slots", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let qaAuth: string;
  let builderAuth: string;

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
});
