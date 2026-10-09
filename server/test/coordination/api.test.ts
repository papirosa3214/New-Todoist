// e2e: четыре эндпоинта /api/coordination/* через `app.inject` на
// собранном `buildApp()`. Минимальная БД в setup.ts (test/setup.ts)
// уже поднята и пуста; здесь заводим ровно то, что нужно — задачу,
// подзадачу, узел плана, активную попытку, job в очереди, и
// проверяем:
//
//   1. /api/coordination/subtasks/:id/resolve отдаёт 200 + правильную причину.
//   2. /api/coordination/tasks/:id/resolve возвращает массив по подзадачам.
//   3. /api/coordination/attempts/:id/resolve работает для попытки.
//   4. /api/coordination/_metrics?window=hour возвращает структуру со
//      счётчиками по `cause`/`action` (хотя бы нули).
//   5. 404 на несуществующий task/subtask/attempt.
//   6. 401 без токена.
//
// Ключевое: `contract_version === "2.0.0"` в каждом ответе.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";
import type { FastifyInstance } from "fastify";

const uid = (): string => crypto.randomUUID();

let app: FastifyInstance;
let token: string;
let userId: string;
let taskId: string;
let subtaskId: string;
let attemptId: string;
let planId: string;

function bearer(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  // Регистрация пользователя (test/setup.ts поднимает ALLOW_REGISTRATION=1).
  // Сидим seed-учётку 'u1' до обычного владельца, иначе ownerId() в
  // общих маршрутах будет возвращать её — это общий приём, см.
  // test/helpers/seedOwner.ts.
  const u1 = db.prepare("SELECT id FROM users WHERE id = 'u1'").get() as { id: string } | undefined;
  if (u1) db.prepare("UPDATE users SET role = 'agent' WHERE id = ?").run("u1");
  const email = `coord-owner-${Date.now()}@test.local`;
  const password = "test-password-strong-1";
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password, name: "Coord Owner" },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const regBody = reg.json() as { user: { id: string; role: string }; token: string };
  userId = regBody.user.id;
  token = regBody.token;

  // Делаем пользователя владельцем, чтобы он был получателем assignee_id.
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(userId);

  // Задача.
  taskId = `task_${uid()}`;
  db.prepare(
    `INSERT INTO tasks
       (id, title, status, creator_id, assignee_id, agent_state, position, archived_at)
     VALUES (?, 'coord-test', 'active', ?, ?, NULL, 0, NULL)`,
  ).run(taskId, userId, userId);

  // План совместной работы с одним узлом-«slot» роли builder.
  planId = `plan_${uid()}`;
  db.prepare(
    `INSERT INTO task_collaboration_plans
       (id, task_id, status, revision, profile, rationale, created_by)
     VALUES (?, ?, 'approved', 1, 'manual', 'coord-test', ?)`,
  ).run(planId, taskId, userId);

  // Узел builder (id=slot_builder).
  const slot = "slot_builder";
  db.prepare(
    `INSERT INTO task_collaboration_plan_nodes
       (id, plan_id, slot_key, role_key, expected_result, output_artifact_json, instructions, iteration, skipped_at, rework_of_key)
     VALUES (?, ?, ?, 'builder', 'Build something', NULL, NULL, 0, NULL, NULL)`,
  ).run(`node_${uid()}`, planId, slot);

  // Второй узел — slot_idle, без активной попытки. На нём будем
  // проверять, что R6.queued срабатывает раньше R5.ready_to_start,
  // когда у задачи есть job в очереди.
  db.prepare(
    `INSERT INTO task_collaboration_plan_nodes
       (id, plan_id, slot_key, role_key, expected_result, output_artifact_json, instructions, iteration, skipped_at, rework_of_key)
     VALUES (?, ?, ?, 'builder', 'Idle', NULL, NULL, 0, NULL, NULL)`,
  ).run(`node_${uid()}`, planId, "slot_idle");

  // Подзадача-узел плана (todo, без активной попытки) — для /tasks/:id/resolve.
  subtaskId = `sub_${uid()}`;
  db.prepare(
    `INSERT INTO subtasks
       (id, task_id, title, done, agent_state, agent_id, current_attempt_id,
        collaboration_plan_id, plan_node_key, position, result, block_type, blocked_at,
        agent_heartbeat_at, agent_session_id)
     VALUES (?, ?, 'idle slot', 0, NULL, NULL, NULL, ?, ?, 0, NULL, NULL, NULL, NULL, NULL)`,
  ).run(subtaskId, taskId, planId, "slot_idle");

  // Отдельный узел с активной попыткой — для /attempts/:id/resolve.
  const activeSlot = "slot_active";
  db.prepare(
    `INSERT INTO task_collaboration_plan_nodes
       (id, plan_id, slot_key, role_key, expected_result, output_artifact_json, instructions, iteration, skipped_at, rework_of_key)
     VALUES (?, ?, ?, 'builder', 'Active', NULL, NULL, 0, NULL, NULL)`,
  ).run(`node_${uid()}`, planId, activeSlot);
  const activeSubtaskId = `sub_${uid()}`;
  db.prepare(
    `INSERT INTO subtasks
       (id, task_id, title, done, agent_state, agent_id, current_attempt_id,
        collaboration_plan_id, plan_node_key, position, result, block_type, blocked_at,
        agent_heartbeat_at, agent_session_id)
     VALUES (?, ?, 'active slot', 0, 'in_progress', ?, NULL, ?, ?, 1, NULL, NULL, NULL, NULL, NULL)`,
  ).run(activeSubtaskId, taskId, userId, planId, activeSlot);

  // Попытка для теста 3.
  attemptId = `att_${uid()}`;
  db.prepare(
    `INSERT INTO attempts
       (id, task_id, subtask_id, executor_id, started_at, heartbeat_at, ended_at, outcome, runner, model, reason_code)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), NULL, NULL, NULL, NULL, NULL)`,
  ).run(attemptId, taskId, activeSubtaskId, userId);

  // Привязываем попытку к активной подзадаче.
  db.prepare("UPDATE subtasks SET current_attempt_id = ? WHERE id = ?").run(attemptId, activeSubtaskId);

  // Job в очереди — для теста «durable_queued_wake» на уровне карточки.
  db.prepare(
    `INSERT INTO role_run_jobs
       (id, task_id, reason, actor_id, dedupe_key, max_attempts, chain_depth, manual_start,
        status, attempts, available_at, lease_owner, lease_expires_at, last_error, started_at, finished_at, created_at, updated_at)
     VALUES (?, ?, 'after_run', NULL, ?, 3, 0, 0, 'queued', 0, datetime('now'), NULL, NULL, NULL, NULL, NULL, datetime('now'), datetime('now'))`,
  ).run(`rrj_${uid()}`, taskId, `dedupe_${uid()}`);
});

afterAll(async () => {
  if (app) await app.close();
});

describe("GET /api/coordination/subtasks/:id/resolve", () => {
  it("200 + Resolution с contract_version=2.0.0", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/coordination/subtasks/${subtaskId}/resolve`,
      headers: bearer(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { contract_version: string; cause: string; action: string };
    expect(body.contract_version).toBe("2.0.0");
    expect(typeof body.cause).toBe("string");
    expect(typeof body.action).toBe("string");
  });

  it("404 на несуществующую подзадачу", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/coordination/subtasks/sub_does_not_exist_${uid()}/resolve`,
      headers: bearer(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("401 без токена", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/coordination/subtasks/${subtaskId}/resolve`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("200 на узле, по которому есть job в очереди → cause=durable_queued_wake", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/coordination/tasks/${taskId}/resolve`,
      headers: bearer(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      task_id: string;
      resolutions: Array<{ subtask_id: string; cause: string }>;
    };
    expect(body.task_id).toBe(taskId);
    expect(Array.isArray(body.resolutions)).toBe(true);
    // Узел в todo без ожидающих предшественников и без активной попытки,
    // но у задачи есть queued job → правило R6.queued срабатывает раньше
    // R5.ready_to_start (приоритет «первый матч выигрывает»).
    const sub = body.resolutions.find((r) => r.subtask_id === subtaskId);
    expect(sub).toBeDefined();
    expect(sub!.cause).toBe("durable_queued_wake");
  });
});

describe("GET /api/coordination/attempts/:id/resolve", () => {
  it("200 + Resolution по attempt", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/coordination/attempts/${attemptId}/resolve`,
      headers: bearer(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { contract_version: string; cause: string; evidence: Array<{ kind: string; ref: string }> };
    expect(body.contract_version).toBe("2.0.0");
    expect(body.evidence.some((e) => e.kind === "attempt" && e.ref === `attempts.${attemptId}`)).toBe(true);
  });

  it("404 на несуществующую попытку", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/coordination/attempts/att_does_not_exist_${uid()}/resolve`,
      headers: bearer(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/coordination/_metrics", () => {
  it("200 + структура счётчиков", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/coordination/_metrics?window=hour",
      headers: bearer(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      window: string;
      counts: Record<string, number>;
      actions: Record<string, number>;
      top_unknown_subtasks: Array<unknown>;
    };
    expect(["hour", "day"]).toContain(body.window);
    expect(typeof body.counts).toBe("object");
    expect(typeof body.actions).toBe("object");
    expect(Array.isArray(body.top_unknown_subtasks)).toBe(true);
  });

  it("window=day работает", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/coordination/_metrics?window=day",
      headers: bearer(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { window: string };
    expect(body.window).toBe("day");
  });
});

describe("GET /api/coordination/tasks/:id/resolve", () => {
  it("404 на несуществующую карточку", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/coordination/tasks/task_does_not_exist_${uid()}/resolve`,
      headers: bearer(),
    });
    expect(res.statusCode).toBe(404);
  });
});
