// MAK-76: кнопки владельца «Возобновить зависшие шаги» и «Перезапустить сервер».
// Проверяем права, подтверждение перезапуска, отбор зависших шагов
// (пульс, живой запуск) и действие возобновления без запуска настоящей роли.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { _setRestarterForTests, findStuckSubtasks } from "../src/routes/owner-controls.js";

describe("MAK-76: кнопки владельца", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentToken: string;
  let taskId: string;
  let planId: string;
  const ids = { stuck: "", fresh: "", todo: "" };

  const insertSubtask = (title: string, state: string | null, heartbeat: string | null): string => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO subtasks (id, task_id, title, done, position, agent_state, agent_heartbeat_at, collaboration_plan_id, plan_node_key)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    ).run(id, taskId, title, state, heartbeat, planId, `ghost_${id.slice(0, 8)}`);
    return id;
  };

  beforeAll(async () => {
    app = await buildApp();
    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Owner", email: "owner@mak76.test", password: "password123" },
    });
    ownerToken = ownerReg.json().token;
    ownerId = ownerReg.json().user.id;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);

    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Agent", email: "agent@mak76.test", password: "password123" },
    });
    db.prepare("UPDATE users SET type='ai' WHERE id=?").run(agentReg.json().user.id);
    const apiResp = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${agentReg.json().token}` },
    });
    agentToken = apiResp.json().api_token;

    const taskResp = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "MAK-76 demo" },
    });
    taskId = taskResp.json().task.id;

    planId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, created_by) VALUES (?, ?, 1, 'approved', 'full_cycle', ?)",
    ).run(planId, taskId, ownerId);

    ids.stuck = insertSubtask("Зависший", "in_progress", "2000-01-01 00:00:00");
    ids.fresh = insertSubtask("Свежий пульс", "in_progress", new Date().toISOString().slice(0, 19).replace("T", " "));
    ids.todo = insertSubtask("Ждёт очереди", "todo", null);
  });

  afterAll(async () => {
    _setRestarterForTests(null);
    await app.close();
  });

  it("все три действия закрыты для не-владельца", async () => {
    for (const [method, url] of [
      ["GET", "/api/owner/runtime-status"],
      ["POST", "/api/owner/resume-stuck"],
      ["POST", "/api/owner/restart-server"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: method === "POST" ? { confirm: true } : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("зависшим считается только шаг «в работе» без свежего пульса", async () => {
    const stuck = findStuckSubtasks().map((r) => r.id);
    expect(stuck).toContain(ids.stuck);
    expect(stuck).not.toContain(ids.fresh);
    expect(stuck).not.toContain(ids.todo);
    const res = await app.inject({
      method: "GET",
      url: "/api/owner/runtime-status",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stuck.map((s: { subtask_id: string }) => s.subtask_id)).toContain(ids.stuck);
  });

  it("возобновление трогает только зависший шаг, пишет событие, сервер не перезапускается", async () => {
    let restarted = 0;
    _setRestarterForTests(() => {
      restarted += 1;
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/owner/resume-stuck",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBeGreaterThanOrEqual(1);
    const row = (id: string) => db.prepare("SELECT agent_state FROM subtasks WHERE id = ?").get(id) as { agent_state: string | null };
    // У узла нет живой роли в плане — он освобождён.
    expect(row(ids.stuck).agent_state).toBeNull();
    // Шаг со свежим пульсом и шаг «todo» не тронуты.
    expect(row(ids.fresh).agent_state).toBe("in_progress");
    expect(row(ids.todo).agent_state).toBe("todo");
    const ev = db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'owner_resume_stuck'").get(taskId) as { n: number };
    expect(ev.n).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 700));
    expect(restarted).toBe(0);
  });

  it("перезапуск требует подтверждения и после ответа вызывает перезапуск", async () => {
    let restarted = 0;
    _setRestarterForTests(() => {
      restarted += 1;
    });
    const noConfirm = await app.inject({
      method: "POST",
      url: "/api/owner/restart-server",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {},
    });
    expect(noConfirm.statusCode).toBe(400);
    expect(noConfirm.json()).toHaveProperty("active_runs");
    await new Promise((r) => setTimeout(r, 700));
    expect(restarted).toBe(0);

    const ok = await app.inject({
      method: "POST",
      url: "/api/owner/restart-server",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { confirm: true },
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().accepted).toBe(true);
    await new Promise((r) => setTimeout(r, 900));
    expect(restarted).toBe(1);
  });
});
