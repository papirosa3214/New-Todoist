// Закрытие шага гасит отметку «в работе» — регрессионный тест на баг,
// пойманный Максимом вечером 20.08.2026.
//
// Симптом был не в том, что закрытый шаг где-то показывался идущим (чтение
// это скрывало: withSubtaskState отдаёт state='done', а роллап задачи
// фильтрует !s.done), а в том, что остаток agent_state ЖИЛ в строке. Стоило
// владельцу снять галочку — давно доделанная работа снова выглядела живой.
// Поэтому тест проверяет ровно две вещи: колонки после закрытия пусты, и
// снятая галочка не воскрешает работу.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Закрытие шага снимает отметку работы", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentId: string;
  let agentToken: string;
  let taskId: string;
  let subtaskId: string;

  beforeAll(async () => {
    app = await buildApp();

    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Owner",
        email: "owner@subtask-done.test",
        password: "password123",
      },
    });
    ownerToken = ownerReg.json().token;

    // Тот же приём, что в e2e.test.ts: регистрация всегда даёт type='human',
    // а правило «result обязателен» касается только агента — помечаем прямым
    // UPDATE, API для этого нет.
    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Agent",
        email: "agent@subtask-done.test",
        password: "password123",
      },
    });
    agentId = agentReg.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);

    const tokenResp = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${agentReg.json().token}` },
    });
    agentToken = tokenResp.json().api_token;

    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Задача с одним шагом", assignee_id: agentId },
    });
    taskId = task.json().task.id;

    const subtask = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Единственный шаг" },
    });
    subtaskId = subtask.json().id;

    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("агент берёт шаг в работу", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "in_progress" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent_state).toBe("in_progress");
    expect(res.json().agent_id).toBe(agentId);
  });

  it("закрытие шага очищает состояние, исполнителя и аренду", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${subtaskId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { done: true, result: "шаг сделан" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.done).toBe(true);
    expect(body.state).toBe("done");
    expect(body.agent_state).toBeNull();
    expect(body.agent_id).toBeNull();
    expect(body.agent_heartbeat_at).toBeNull();
    // Итог закрытия остаётся на месте: приёмку сняли, отчётность нет.
    expect(body.result).toBe("шаг сделан");
  });

  it("снятая владельцем галочка не воскрешает работу", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${subtaskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { done: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.done).toBe(false);
    expect(body.agent_state).toBeNull();
    expect(body.state).not.toBe("running");
  });
});
