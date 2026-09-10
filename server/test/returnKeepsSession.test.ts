// Возврат задачи владельцем не должен стирать сессию агента.
//
// Симптом, пойманный Максимом 21.08.2026: он вернул карточку из review на
// доработку через трекер, написал комментарий — и ничего не произошло.
// «Я чисто через TaskFlow решил с тобой прокоммуницировать, и у меня это не
// получилось».
//
// Причина была не в будильнике, а здесь: при переходе в in_progress маршрут
// писал agent_session_id = sessionOf(req), а у запроса из браузера владельца
// нет ни заголовка X-Agent-Session, ни session_id в теле. Значит в колонку
// уходил null, и связь с живой сессией агента терялась ровно в тот момент,
// когда она нужнее всего: возвращать работу стало некуда, и служба подняла
// бы новую сессию с чистого листа.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("Возврат владельцем сохраняет сессию агента", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let agentId: string;
  let taskId: string;

  const СЕССИЯ = "session-of-the-working-agent";

  beforeAll(async () => {
    app = await buildApp();

    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Owner",
        email: "owner@return-session.test",
        password: "password123",
      },
    });
    ownerToken = ownerReg.json().token;

    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Agent",
        email: "agent@return-session.test",
        password: "password123",
      },
    });
    agentToken = agentReg.json().token;
    agentId = agentReg.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);

    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Задача с живой сессией", assignee_id: agentId },
    });
    taskId = task.json().task.id;
    markReadyForPickup(taskId);

    // Агент берёт задачу, представляясь своей сессией — как это делает
    // MCP-клиент (CLAUDE_CODE_SESSION_ID уходит заголовком).
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-session": СЕССИЯ,
      },
      payload: {},
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("после claim сессия записана", () => {
    const row = db
      .prepare("SELECT agent_session_id FROM tasks WHERE id = ?")
      .get(taskId) as { agent_session_id: string | null };
    expect(row.agent_session_id).toBe(СЕССИЯ);
  });

  it("владелец вернул из review — сессия НЕ стёрлась", async () => {
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-session": СЕССИЯ,
      },
      payload: { state: "review", comment: "сделал, посмотри" },
    });

    // Владелец возвращает на доработку из браузера: никакой метки сессии
    // в запросе нет — именно этот случай и стирал колонку.
    const back = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { state: "in_progress", comment: "поправь вот это" },
    });
    expect(back.statusCode).toBe(200);

    const row = db
      .prepare("SELECT agent_state, agent_session_id FROM tasks WHERE id = ?")
      .get(taskId) as { agent_state: string; agent_session_id: string | null };
    expect(row.agent_state).toBe("in_progress");
    expect(row.agent_session_id).toBe(СЕССИЯ);
  });

  it("сам агент, возвращаясь, метку по-прежнему перезаписывает", async () => {
    const ДРУГАЯ = "session-after-restart";
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-session": ДРУГАЯ,
      },
      payload: { state: "blocked", comment: "упёрся, нужен владелец" },
    });
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-session": ДРУГАЯ,
      },
      payload: { state: "in_progress" },
    });

    const row = db
      .prepare("SELECT agent_session_id FROM tasks WHERE id = ?")
      .get(taskId) as { agent_session_id: string | null };
    expect(row.agent_session_id).toBe(ДРУГАЯ);
  });
});
