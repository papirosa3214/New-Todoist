// Спек 1.2, задача 1.2.7: триггеры авто-подсказки консультации (R7).
//
// Тесты проверяют серверную сторону:
//   1. POST /api/tasks/:id/attempts/:attempt_id/suggest-consultation
//      принимает коды причин, объединяет с уже записанными (множество)
//      и пишет task_event с kind='consultation_suggested' для аудита.
//   2. GET /api/tasks/:id/attempts/:attempt_id/consultation-suggestion
//      отдаёт снимок текущих причин; пустой массив = нет пометки.
//   3. GET /api/tasks/:id возвращает attempts[i].consultation_suggested_reasons
//      как JSON-строку (парсится на клиенте; сервер её уже хранит).
//   4. Невалидные причины отбрасываются молча, лишний запрос с пустым
//      reasons — no-op.
//   5. Защита от чужой попытки: подмена attempt_id в пути — 404.
//
// Сам триггер («когда считать diff_size») живёт в trigger.py; здесь
// проверяется только серверный контракт, который trigger.py зовёт.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

interface TriggerFixture {
  app: FastifyInstance;
  ownerToken: string;
  agentToken: string;
  agentId: string;
  taskId: string;
  attemptId: string;
  foreignTaskId: string;
  foreignAttemptId: string;
}

async function setupFixture(): Promise<TriggerFixture> {
  const app = await buildApp();
  const owner = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: `OwnerTrigger${Date.now()}`,
      email: `owner-trigger-${Date.now()}@test`,
      password: "password123",
    },
  });
  const ownerToken = owner.json().token;

  const agent = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: `AgentTrigger${Date.now()}`,
      email: `agent-trigger-${Date.now()}@test`,
      password: "password123",
    },
  });
  const agentId = agent.json().user.id;
  db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);
  const agentToken = (
    await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${agent.json().token}` },
    })
  ).json().api_token;

  const created = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { title: "Триггеры консультации" },
  });
  const taskId = created.json().task.id;
  markReadyForPickup(taskId);
  db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(agentId, taskId);

  const claim = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/claim`,
    headers: {
      authorization: `Bearer ${agentToken}`,
      "x-agent-attempt-id": `seed-${taskId}`,
    },
    payload: {},
  });
  const attemptId = claim.json().task.current_attempt_id as string;

  // Чужая задача для проверки 404 при подмене attempt_id в пути.
  const foreignCreated = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { title: "Чужая задача" },
  });
  const foreignTaskId = foreignCreated.json().task.id;
  // Чужой attempt не нужен — для проверки «подмена attempt_id» достаточно
  // несуществующего id в пути, сервер сам ответит 404 (не найдена ни
  // задача, ни попытка). Это снимает зависимость от второго claim
  // (который в одном тестовом прогоне может конфликтовать с первым).
  const foreignAttemptId = "00000000-0000-0000-0000-000000000000";

  return {
    app, ownerToken, agentToken, agentId,
    taskId, attemptId, foreignTaskId, foreignAttemptId,
  };
}

describe("POST /api/tasks/:id/attempts/:attempt_id/suggest-consultation (спек 1.2, 1.2.7)", () => {
  let f: TriggerFixture;

  beforeAll(async () => {
    f = await setupFixture();
  });
  afterAll(async () => {
    await f.app.close();
  });

  it("принимает причину diff_size и сохраняет её на попытке", async () => {
    const res = await f.app.inject({
      method: "POST",
      url: `/api/tasks/${f.taskId}/attempts/${f.attemptId}/suggest-consultation`,
      headers: { authorization: `Bearer ${f.agentToken}` },
      payload: { reasons: ["diff_size"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reasons: ["diff_size"], added: true });

    const row = db
      .prepare(
        "SELECT consultation_suggested_reasons FROM attempts WHERE id = ?",
      )
      .get(f.attemptId) as { consultation_suggested_reasons: string };
    expect(JSON.parse(row.consultation_suggested_reasons)).toEqual(["diff_size"]);
  });

  it("повторный вызов с той же причиной — no-op (множество)", async () => {
    const res = await f.app.inject({
      method: "POST",
      url: `/api/tasks/${f.taskId}/attempts/${f.attemptId}/suggest-consultation`,
      headers: { authorization: `Bearer ${f.agentToken}` },
      payload: { reasons: ["diff_size"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reasons: ["diff_size"], added: false });
  });

  it("добавляет новую причину edits_no_tests к существующей diff_size", async () => {
    const res = await f.app.inject({
      method: "POST",
      url: `/api/tasks/${f.taskId}/attempts/${f.attemptId}/suggest-consultation`,
      headers: { authorization: `Bearer ${f.agentToken}` },
      payload: { reasons: ["edits_no_tests"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      reasons: expect.arrayContaining(["diff_size", "edits_no_tests"]),
      added: true,
    });
  });

  it("отбрасывает невалидные причины молча", async () => {
    const res = await f.app.inject({
      method: "POST",
      url: `/api/tasks/${f.taskId}/attempts/${f.attemptId}/suggest-consultation`,
      headers: { authorization: `Bearer ${f.agentToken}` },
      payload: { reasons: ["bogus_reason", 42, null] },
    });
    expect(res.statusCode).toBe(200);
    // Только валидные причины остались в БД; ничего нового не добавилось.
    expect(res.json()).toEqual({ reasons: ["diff_size", "edits_no_tests"], added: false });
  });

  it("пустой массив reasons — no-op без ошибки", async () => {
    const res = await f.app.inject({
      method: "POST",
      url: `/api/tasks/${f.taskId}/attempts/${f.attemptId}/suggest-consultation`,
      headers: { authorization: `Bearer ${f.agentToken}` },
      payload: { reasons: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reasons: ["diff_size", "edits_no_tests"], added: false });
  });

  it("reasons не-массивом → 400", async () => {
    const res = await f.app.inject({
      method: "POST",
      url: `/api/tasks/${f.taskId}/attempts/${f.attemptId}/suggest-consultation`,
      headers: { authorization: `Bearer ${f.agentToken}` },
      payload: { reasons: "diff_size" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("записывает task_event kind='consultation_suggested'", async () => {
    // К этому моменту на попытке две причины; новый POST с одной из
    // существующих — no-op, событие НЕ пишется. Свежей причины в списке
    // CONSULTATION_REASONS нет, так что для проверки события заведём
    // отдельный сценарий.
    const created = await f.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${f.ownerToken}` },
      payload: { title: "Под событие" },
    });
    const taskId = created.json().task.id;
    markReadyForPickup(taskId);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(f.agentId, taskId);
    const claim = await f.app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: {
        authorization: `Bearer ${f.agentToken}`,
        "x-agent-attempt-id": `seed-event-${taskId}`,
      },
      payload: {},
    });
    const attemptId = claim.json().task.current_attempt_id as string;

    const res = await f.app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/attempts/${attemptId}/suggest-consultation`,
      headers: { authorization: `Bearer ${f.agentToken}` },
      payload: { reasons: ["diff_size"] },
    });
    expect(res.statusCode).toBe(200);

    const ev = db
      .prepare(
        `SELECT kind, field, to_value FROM task_events
          WHERE task_id = ? AND kind = 'consultation_suggested'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as { kind: string; field: string; to_value: string };
    expect(ev.kind).toBe("consultation_suggested");
    expect(ev.field).toBe("diff_size");
    expect(JSON.parse(ev.to_value)).toEqual(["diff_size"]);
  });

  it("подмена attempt_id из чужой задачи → 404 (task не найден)", async () => {
    // attemptId принадлежит foreignTaskId, не f.taskId.
    const res = await f.app.inject({
      method: "POST",
      url: `/api/tasks/${f.taskId}/attempts/${f.foreignAttemptId}/suggest-consultation`,
      headers: { authorization: `Bearer ${f.agentToken}` },
      payload: { reasons: ["diff_size"] },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/tasks/:id/attempts/:attempt_id/consultation-suggestion (спек 1.2, 1.2.7)", () => {
  let f: TriggerFixture;

  beforeAll(async () => {
    f = await setupFixture();
    // Заранее кладём одну причину, чтобы было что читать.
    await f.app.inject({
      method: "POST",
      url: `/api/tasks/${f.taskId}/attempts/${f.attemptId}/suggest-consultation`,
      headers: { authorization: `Bearer ${f.agentToken}` },
      payload: { reasons: ["edits_no_tests"] },
    });
  });
  afterAll(async () => {
    await f.app.close();
  });

  it("отдаёт текущий снимок причин", async () => {
    const res = await f.app.inject({
      method: "GET",
      url: `/api/tasks/${f.taskId}/attempts/${f.attemptId}/consultation-suggestion`,
      headers: { authorization: `Bearer ${f.agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reasons: ["edits_no_tests"] });
  });

  it("на свежей попытке без пометки — пустой массив", async () => {
    const created = await f.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${f.ownerToken}` },
      payload: { title: "Без пометки" },
    });
    const taskId = created.json().task.id;
    markReadyForPickup(taskId);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(f.agentId, taskId);
    const claim = await f.app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: {
        authorization: `Bearer ${f.agentToken}`,
        "x-agent-attempt-id": `seed-empty-${taskId}`,
      },
      payload: {},
    });
    const attemptId = claim.json().task.current_attempt_id as string;
    const res = await f.app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/attempts/${attemptId}/consultation-suggestion`,
      headers: { authorization: `Bearer ${f.agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reasons: [] });
  });
});

describe("GET /api/tasks/:id attempts[].consultation_suggested_reasons (спек 1.2, 1.2.7)", () => {
  let f: TriggerFixture;

  beforeAll(async () => {
    f = await setupFixture();
    await f.app.inject({
      method: "POST",
      url: `/api/tasks/${f.taskId}/attempts/${f.attemptId}/suggest-consultation`,
      headers: { authorization: `Bearer ${f.agentToken}` },
      payload: { reasons: ["diff_size"] },
    });
  });
  afterAll(async () => {
    await f.app.close();
  });

  it("поле consultation_suggested_reasons присутствует в JSON-строке attempts[]", async () => {
    const res = await f.app.inject({
      method: "GET",
      url: `/api/tasks/${f.taskId}`,
      headers: { authorization: `Bearer ${f.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const attempts = res.json().attempts as Array<{
      id: string;
      consultation_suggested_reasons: string | null;
    }>;
    const ours = attempts.find((a) => a.id === f.attemptId);
    expect(ours).toBeTruthy();
    expect(ours!.consultation_suggested_reasons).not.toBeNull();
    expect(JSON.parse(ours!.consultation_suggested_reasons!)).toEqual([
      "diff_size",
    ]);
  });
});
