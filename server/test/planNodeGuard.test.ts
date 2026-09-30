// Шаг плана совместной работы — только своей роли (docs/2026-09-30-live-
// collaboration-plan-spec.md, инцидент 30.09.2026): архитектор взял в работу
// и закрыл шаги QA и критика обычным /work + галочкой. Теперь ИИ берёт и
// закрывает только узел своей роли и только когда открылись предшественники.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("шаг плана — только своей роли", () => {
  let app: FastifyInstance;
  let owner: { authorization: string };
  const as = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ id })}` });
  let taskId: string;
  let archStep: string;
  let qaStep: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "GuardOwner", email: `guard-${Date.now()}@test`, password: "password123" },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    owner = { authorization: `Bearer ${reg.json().token}` };

    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: owner, payload: { title: "Guard " + Date.now() } });
    taskId = created.json().task.id;
    // Утверждённый план «архитектор → QA» прямо в БД: /approve запустил бы роли.
    db.prepare("UPDATE task_collaboration_plans SET status = 'superseded' WHERE task_id = ?").run(taskId);
    const planId = "tcp_" + crypto.randomUUID();
    db.prepare(`INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, rationale, created_by, approved_by, approved_at)
                VALUES (?, ?, 99, 'approved', 'manual', 'guard', ?, ?, datetime('now'))`)
      .run(planId, taskId, reg.json().user.id, reg.json().user.id);
    const node = db.prepare("INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result) VALUES (?, ?, ?, ?, 1, ?)");
    node.run("tcpn_" + crypto.randomUUID(), planId, "architecture", "architect", "Решение");
    node.run("tcpn_" + crypto.randomUUID(), planId, "qa", "qa", "Проверка");
    db.prepare("INSERT INTO task_collaboration_plan_edges (id, plan_id, from_slot_key, to_slot_key, start_condition) VALUES (?, ?, 'architecture', 'qa', 'accepted')")
      .run("tcpe_" + crypto.randomUUID(), planId);
    archStep = crypto.randomUUID();
    qaStep = crypto.randomUUID();
    const step = db.prepare("INSERT INTO subtasks (id, task_id, title, position, agent_id, collaboration_plan_id, plan_node_key) VALUES (?, ?, ?, ?, ?, ?, ?)");
    step.run(archStep, taskId, "Решение", 1, "role_architect", planId, "architecture");
    step.run(qaStep, taskId, "Проверка", 2, "role_qa", planId, "qa");
    db.prepare("UPDATE tasks SET assignee_id = 'role_architect' WHERE id = ?").run(taskId);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("архитектор не берёт в работу и не закрывает шаг QA", async () => {
    const work = await app.inject({
      method: "POST",
      url: `/api/subtasks/${qaStep}/work`,
      headers: as("role_architect"),
      payload: { state: "in_progress" },
    });
    expect(work.statusCode).toBe(403);
    expect(work.json().error).toContain("QA");

    const close = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${qaStep}`,
      headers: as("role_architect"),
      payload: { done: true, result: "Не выполнялось Архитектором" },
    });
    expect(close.statusCode).toBe(403);
    expect((db.prepare("SELECT done FROM subtasks WHERE id = ?").get(qaStep) as { done: number }).done).toBe(0);
  });

  it("QA не начинает свой шаг, пока архитектор не сдал", async () => {
    const early = await app.inject({
      method: "POST",
      url: `/api/subtasks/${qaStep}/work`,
      headers: as("role_qa"),
      payload: { state: "in_progress" },
    });
    expect(early.statusCode).toBe(403);
    expect(early.json().error).toContain("предшественников");
  });

  it("свой шаг роль по-прежнему ведёт, владелец вмешивается явно", async () => {
    const own = await app.inject({
      method: "POST",
      url: `/api/subtasks/${archStep}/work`,
      headers: as("role_architect"),
      payload: { state: "in_progress" },
    });
    expect(own.statusCode).not.toBe(403);

    const byOwner = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${qaStep}`,
      headers: owner,
      payload: { done: true },
    });
    expect(byOwner.statusCode).toBe(200);
  });
});
