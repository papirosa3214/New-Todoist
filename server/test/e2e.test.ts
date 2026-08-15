// Один сквозной сценарий — тот самый «полный цикл», уже описанный в
// AGENT-API.md §8.5: взял → продлил аренду → упёрся → возобновил → сдал на
// проверку → владелец принял. Через app.inject() (buildApp(), index.ts) —
// без реального порта, без вмешательства в живой сервер на :3001, на
// одноразовой временной базе (test/setup.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Сквозной сценарий: claim → heartbeat → blocked → in_progress → review → completed", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentId: string;
  let agentToken: string;
  let taskId: string;

  beforeAll(async () => {
    app = await buildApp();

    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Owner",
        email: "owner@e2e.test",
        password: "password123",
      },
    });
    expect(ownerReg.statusCode).toBe(200);
    ownerToken = ownerReg.json().token;

    // Регистрация всегда пишет type='human' (auth.ts — намеренно, клиент
    // не может сам выдать себе type='ai'). Помечаем учётку агентом тем же
    // путём, что и системные боты (db.ts, is_system_bot для u2/u3): прямой
    // UPDATE, не через API, которого для этого нет.
    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Agent",
        email: "agent@e2e.test",
        password: "password123",
      },
    });
    const agentBody = agentReg.json();
    agentId = agentBody.user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);

    const tokenResp = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${agentBody.token}` },
    });
    agentToken = tokenResp.json().api_token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("владелец заводит задачу на агента", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Сквозной тест протокола", assignee_id: agentId },
    });
    expect(res.statusCode).toBe(200);
    taskId = res.json().task.id;
  });

  it("агент берёт задачу в работу", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.agent_state).toBe("in_progress");
  });

  it("агент продлевает аренду", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/heartbeat`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lease_expires_at).toBeTruthy();
  });

  it("без комментария в blocked уйти нельзя — 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "blocked" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("агент упирается — blocked с комментарием", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "blocked", comment: "нужен доступ к внешнему API" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.agent_state).toBe("blocked");
  });

  it("агент возобновляет работу", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "in_progress" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.agent_state).toBe("in_progress");
  });

  it("агент сдаёт на проверку", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        state: "review",
        comment: "готово: доступ получен, задача выполнена",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.agent_state).toBe("review");
  });

  it("агент не может сам принять свою задачу — 403", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { status: "completed" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("владелец принимает", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "completed" },
    });
    expect(res.statusCode).toBe(200);
    const task = res.json().task;
    expect(task.status).toBe("completed");
    expect(task.agent_state).toBe(null);
  });

  it("журнал зафиксировал весь цикл", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const kinds = res.json().events.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("task_created");
    expect(kinds).toContain("claimed");
    // claimed + 4× blocked/in_progress/review/(status->completed идёт
    // отдельным field:'status', тоже kind state_changed) — минимум 4
    // смены состояния за цикл: in_progress, blocked, in_progress, review.
    expect(
      kinds.filter((k: string) => k === "state_changed").length,
    ).toBeGreaterThanOrEqual(4);
  });
});
