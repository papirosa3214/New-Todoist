// Шаг 7 карточки 8ca87c61: «тесты на инварианты: одна действующая
// попытка, старый attempt_id, возврат в очередь». Здесь — инвариант
// «не более одной действующей попытки» на уровне БД. Часть attempt_id
// (старый/чужой отвергается) уже покрыта в attemptId.test.ts, и
// сторож (lease_expired закрывает попытку) — в agent_watch.py, отдельным
// сценарием с реальным временем там не прогоняется.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("attempts: инвариант «не более одной действующей попытки»", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("вторая попытка для той же задачи при действующей первой — UNIQUE constraint failed", () => {
    // Чистим за собой, чтобы тест был детерминирован.
    db.prepare("DELETE FROM attempts WHERE task_id = 'inv-test-task'").run();
    db.prepare("DELETE FROM tasks WHERE id = 'inv-test-task'").run();
    db.prepare(
      `INSERT INTO tasks (id, title, status) VALUES ('inv-test-task', 'inv', 'active')`,
    ).run();
    const user = db
      .prepare("SELECT id FROM users ORDER BY id LIMIT 1")
      .get() as { id: string };
    db.prepare(
      `INSERT INTO attempts (id, task_id, executor_id) VALUES (?, ?, ?)`,
    ).run("att-1", "inv-test-task", user.id);
    expect(() =>
      db.prepare(
        `INSERT INTO attempts (id, task_id, executor_id) VALUES (?, ?, ?)`,
      ).run("att-2", "inv-test-task", user.id),
    ).toThrow(/UNIQUE constraint failed/);
    db.prepare("DELETE FROM attempts WHERE task_id = 'inv-test-task'").run();
    db.prepare("DELETE FROM tasks WHERE id = 'inv-test-task'").run();
  });

  it("для разных задач действующие попытки не мешают друг другу", () => {
    db.prepare("DELETE FROM attempts WHERE id LIKE 'inv-%'").run();
    db.prepare("DELETE FROM tasks WHERE id LIKE 'inv-%'").run();
    db.prepare(
      `INSERT INTO tasks (id, title, status) VALUES
         ('inv-a', 'a', 'active'), ('inv-b', 'b', 'active')`,
    ).run();
    const user = db
      .prepare("SELECT id FROM users ORDER BY id LIMIT 1")
      .get() as { id: string };
    db.prepare(
      `INSERT INTO attempts (id, task_id, executor_id) VALUES (?, ?, ?)`,
    ).run("inv-att-a", "inv-a", user.id);
    db.prepare(
      `INSERT INTO attempts (id, task_id, executor_id) VALUES (?, ?, ?)`,
    ).run("inv-att-b", "inv-b", user.id);
    // Обе попытки действующие — это нормально, partial unique index'ы
    // ограничивают «не более одной на задачу», а не «не более одной вообще».
    const rows = db
      .prepare(
        "SELECT id, task_id FROM attempts WHERE id LIKE 'inv-%' ORDER BY task_id",
      )
      .all() as Array<{ id: string; task_id: string }>;
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.task_id).sort()).toEqual(["inv-a", "inv-b"]);
    db.prepare("DELETE FROM attempts WHERE id LIKE 'inv-%'").run();
    db.prepare("DELETE FROM tasks WHERE id LIKE 'inv-%'").run();
  });

  it("после ended_at новая попытка для той же задачи — создаётся (инвариант «не более одной действующей» соблюдён)", () => {
    db.prepare("DELETE FROM attempts WHERE id LIKE 'inv-%'").run();
    db.prepare("DELETE FROM tasks WHERE id LIKE 'inv-%'").run();
    db.prepare(
      `INSERT INTO tasks (id, title, status) VALUES ('inv-seq', 'seq', 'active')`,
    ).run();
    const user = db
      .prepare("SELECT id FROM users ORDER BY id LIMIT 1")
      .get() as { id: string };
    db.prepare(
      `INSERT INTO attempts (id, task_id, executor_id, ended_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run("inv-att-1", "inv-seq", user.id);
    // Первая попытка завершена — вторая попытка для той же задачи должна
    // пройти без UNIQUE-конфликта (partial index WHERE ended_at IS NULL).
    expect(() =>
      db.prepare(
        `INSERT INTO attempts (id, task_id, executor_id) VALUES (?, ?, ?)`,
      ).run("inv-att-2", "inv-seq", user.id),
    ).not.toThrow();
    db.prepare("DELETE FROM attempts WHERE id LIKE 'inv-%'").run();
    db.prepare("DELETE FROM tasks WHERE id LIKE 'inv-%'").run();
  });

  it("claim эндпоинт — две попытки не создаются: вторая попытка отбивается по UNIQUE", async () => {
    // Это интеграционная проверка: claim → попытка в БД; ещё один прямой
    // INSERT с тем же task_id и ended_at IS NULL должен провалиться.
    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OwnerInv",
        email: "owner-inv@test",
        password: "password123",
      },
    });
    const ownerId = ownerReg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
    const ownerToken = ownerReg.json().token;

    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "AgentInv",
        email: "agent-inv@test",
        password: "password123",
      },
    });
    const agentId = agentReg.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);
    const agentToken = (await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${agentReg.json().token}` },
    })).json().api_token;

    const taskRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Task for invariant" },
    });
    const taskId = taskRes.json().task.id;
    markReadyForPickup(taskId);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(agentId, taskId);

    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    // Прямая попытка создать ещё одну действующую попытку в БД — провал.
    expect(() =>
      db.prepare(
        `INSERT INTO attempts (id, task_id, executor_id) VALUES (?, ?, ?)`,
      ).run("inv-claim-2", taskId, agentId),
    ).toThrow(/UNIQUE constraint failed/);
  });
});
