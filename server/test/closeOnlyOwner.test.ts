// Закрывать и возвращать в работу задачу может только владелец
// (08.09.2026, задача b6b57092). Ни исполнитель, ни оркестратор: карточка
// уходит с доски вместе со всей историей, и закрыть её «не глядя» не должен
// никто, кроме человека. Ревьюер выносит вердикт, закрывает владелец.
//
// Прежний режим (29.08.2026, задача be329d8e) отдавал приёмку оркестратору —
// решение отменено вместе со строкой «закрывать задачу — оркестратор»
// в матрице прав: автономного оркестратора в системе нет.
//
// Проверка: PATCH /api/tasks/:id со status=completed|active.
//  - role='owner' → 200;
//  - любой другой (оркестратор и назначенный исполнитель в том числе) → 403.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Закрытие и возврат в работу — только владелец", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let orchToken: string;
  let orchId: string;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    app = await buildApp();

    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OwnerClose",
        email: "owner@close-only.test",
        password: "password123",
      },
    });
    ownerToken = ownerReg.json().token;
    ownerId = ownerReg.json().user.id;
    // Регистрация по умолчанию даёт role='agent', а не owner — поднимем
    // через SQL, как в других тестах делается (см. ownerRelease.test.ts).
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    const orchReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OrchestratorClose",
        email: "orch@close-only.test",
        password: "password123",
      },
    });
    orchToken = orchReg.json().token;
    orchId = orchReg.json().user.id;
    db.prepare("UPDATE users SET role = 'orchestrator' WHERE id = ?").run(
      orchId,
    );

    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "AgentClose",
        email: "agent@close-only.test",
        password: "password123",
      },
    });
    agentToken = agentReg.json().token;
    agentId = agentReg.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Задача, назначенная на агента, в работе. */
  async function makeAssignedTask(title: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title, assignee_id: agentId },
    });
    const taskId = created.json().task.id;
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {},
    });
    return taskId;
  }

  it("владелец закрывает задачу → 200, status=completed", async () => {
    const taskId = await makeAssignedTask("Owner закрывает");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "completed" },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.task.status).toBe("completed");
  });

  it("оркестратор закрывает задачу → 403, status не меняется", async () => {
    const taskId = await makeAssignedTask("Орк закрывает");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${orchToken}` },
      payload: { status: "completed" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/только владелец/);

    const after = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(after.json().status).toBe("active");
  });

  it("исполнитель закрывает свою задачу → 403, status не меняется", async () => {
    const taskId = await makeAssignedTask("Агент пытается закрыть");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { status: "completed" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/только владелец/);

    // И проверяем, что статус действительно остался active — запрет не
    // должен был пройти мимо побочным эффектом (он срабатывает ДО записи).
    const after = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    // GET /api/tasks/:id возвращает плоский объект, не {task: ...}.
    expect(after.json().status).toBe("active");
  });

  it("оркестратор возвращает completed → active → 403", async () => {
    const taskId = await makeAssignedTask("Орк возвращает");
    // Сначала закрываем — владельцем, единственным, кому это можно.
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "completed" },
    });
    // Возврат закрытой задачи — та же ручка и тот же запрет.
    const back = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${orchToken}` },
      payload: { status: "active" },
    });
    expect(back.statusCode).toBe(403);

    const after = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(after.json().status).toBe("completed");
  });

  it("владелец возвращает completed → active → 200", async () => {
    const taskId = await makeAssignedTask("Владелец возвращает");
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "completed" },
    });
    const back = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "active" },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().task.status).toBe("active");
  });

  it("исполнитель возвращает completed → active → 403", async () => {
    const taskId = await makeAssignedTask("Агент возвращает");
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "completed" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { status: "active" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("правка НЕ status (например, title) исполнителю разрешена", async () => {
    // Запрет узкий: только status. Остальные правки — как раньше.
    const taskId = await makeAssignedTask("Агент правит title");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { title: "Агент правит title (новое название)" },
    });
    expect(res.statusCode).toBe(200);
  });
});
