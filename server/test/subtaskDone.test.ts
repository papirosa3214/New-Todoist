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
  let secondSubtaskId: string;

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
    // Флаг готовности поднимает только ВЛАДЕЛЕЦ ТРЕКЕРА (role='owner'), а не
    // просто автор задачи — регистрация такой роли не даёт, ставим прямым
    // UPDATE, как и type='ai' ниже.
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(
      ownerReg.json().user.id,
    );

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

    // Второй шаг создаём СРАЗУ, а не по ходу проверок: закрытие последнего
    // незакрытого шага автоматически уводит всю задачу в review, а из review
    // агент её обратно не возьмёт — дальше падало бы всё, что идёт после.
    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Второй шаг" },
    });
    secondSubtaskId = second.json().id;

    // Флаг готовности — обязательная ступень перед самозахватом: задачу,
    // собранную не владельцем, агент взять не может, пока владелец её не
    // подтвердил. Без этой строки claim молча отдавал 400, задача оставалась
    // невзятой, и дальше падал уже /work с «сначала возьмите саму задачу».
    const readyRes = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { ready_for_pickup: true },
    });
    expect(readyRes.statusCode).toBe(200);

    // Результат claim проверяем: молчаливый отказ здесь уводил диагностику в
    // сторону — падал не тот тест, который сломан.
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(claim.statusCode).toBe(200);
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

  it("агенту закрыт review на шаге — шаги закрываются галочкой", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "review", result: "сдаю шаг" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("галочкой");
    expect(res.json().error).toContain("на всю задачу");
  });

  // Дальше проверки идут по ВТОРОМУ шагу: первый уже закрыт, а закрытие
  // гасит отметку работы — продолжать на нём значит проверять не то.
  it("шаг нельзя закрыть, не взяв его в работу", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${secondSubtaskId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { done: true, result: "сделал молча" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("не взяв его в работу");

    // И шаг действительно остался незакрытым — отказ не половинчатый.
    const row = db
      .prepare("SELECT done FROM subtasks WHERE id = ?")
      .get(secondSubtaskId) as { done: number };
    expect(row.done).toBe(0);
  });

  it("владелец закрывает шаг без отметки работы — правило только для агента", async () => {
    const third = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Шаг владельца" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${third.json().id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { done: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().done).toBe(true);
  });

  it("длинный итог отклоняется: владельцу нужны одно-два предложения", async () => {
    // Закрытие предыдущего шага гасит аренду и на самой задаче — берём заново.
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    const work = await app.inject({
      method: "POST",
      url: `/api/subtasks/${secondSubtaskId}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "in_progress" },
    });
    expect(work.statusCode).toBe(200);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${secondSubtaskId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { done: true, result: "и".repeat(900) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("одно-два предложения");
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
