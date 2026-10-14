// Чтение плана карточки рабочей ролью (14.10.2026): инструмент
// taskflow_plan_read отдаёт граф — кто за какой этап, в каком порядке и что
// уже сдано. Управление планом при этом остаётся за владельцем и
// оркестратором, а агент без роли плана не видит вовсе. Правило менялось без
// теста — закрываем здесь.
import { roleReport } from "./helpers/roleReport.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("Роль читает план карточки, но не управляет им", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let builderAuth: string;
  let plainAgentAuth: string;
  let taskId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Plan read owner", email: `plan-read-${Date.now()}@test`, password: "password123" },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = `Bearer ${reg.json().token}`;
    builderAuth = `Bearer ${app.jwt.sign({ id: roleUserId("builder") })}`;
    // Агент без role_key: исключение открыто РОЛЯМ, а не любому агенту.
    db.prepare(
      "INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,?,?,?)",
    ).run("plan-read-plain-agent", "Agent", "plan-read-plain-agent@test", "x", "agent", "ai");
    plainAgentAuth = `Bearer ${app.jwt.sign({ id: "plan-read-plain-agent" })}`;

    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: ownerAuth },
      payload: { title: "Чтение плана ролью " + crypto.randomUUID() },
    });
    taskId = task.json().task.id as string;
    const plan = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: { authorization: ownerAuth },
      payload: {
        profile: "manual",
        nodes: [
          { slot_key: "design", role_key: "designer", expected_result: "макет экрана" },
          { slot_key: "build", role_key: "builder", expected_result: "код и проверки" },
        ],
        edges: [{ from_slot_key: "design", to_slot_key: "build", start_condition: "submitted" }],
      },
    });
    expect(plan.statusCode).toBe(201);
  });
  afterAll(async () => {
    await app.close();
  });

  it("рабочая роль читает граф: кто за какой этап, порядок и состояние узлов", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: { authorization: builderAuth },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plans).toHaveLength(1);
    const nodes = body.plans[0].nodes as Array<{ role_key: string; execution_state: string }>;
    expect(nodes.map((n) => n.role_key).sort()).toEqual(["builder", "designer"]);
    expect(nodes.every((n) => typeof n.execution_state === "string" && n.execution_state.length > 0)).toBe(true);
    expect(body.plans[0].edges).toEqual([
      { from_slot_key: "design", to_slot_key: "build", start_condition: "submitted", artifact_key: null },
    ]);
  });

  it("роль не может ни создать, ни изменить план", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: { authorization: builderAuth },
      payload: { profile: "manual", nodes: [{ slot_key: "only", role_key: "builder", expected_result: "правка" }] },
    });
    expect(created.statusCode).toBe(403);
  });

  it("агенту без роли план по-прежнему не виден", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: { authorization: plainAgentAuth },
    });
    expect(res.statusCode).toBe(403);
  });
});
