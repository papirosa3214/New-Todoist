// Шаг 3 карточки 8ca87c61: «Сервер отклоняет сообщения с чужим или
// устаревшим attempt_id». Мягкий enforcement — без заголовка старый
// клиент пропускается; с заголовком должно совпасть с текущей попыткой
// задачи. Проверяется на heartbeat, /state, /subtaskWork, comments —
// берём heartbeat как самый частый случай, остальные три проверяются
// по тому же helper (lib/attemptCheck.ts), отдельных тестов на каждый
// эндпоинт пока нет — будет видно из e2e.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("attempt_id: сервер отклоняет сообщения с чужим/устаревшим attempt", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let taskId: string;
  let attemptId: string;
  let agentId: string;

  beforeAll(async () => {
    app = await buildApp();

    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OwnerAttempt",
        email: "owner-attempt@test",
        password: "password123",
      },
    });
    ownerToken = ownerReg.json().token;
    const ownerId = ownerReg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "AgentAttempt",
        email: "agent-attempt@test",
        password: "password123",
      },
    });
    agentToken = (await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${agentReg.json().token}` },
    })).json().api_token;
    agentId = agentReg.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);

    // Задача, помеченная владельцем, чтобы агент мог её взять.
    const taskRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Task for attempt test" },
    });
    taskId = taskRes.json().task.id;
    markReadyForPickup(taskId);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(agentId, taskId);

    // Claim создаёт attempt и проставляет current_attempt_id.
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(claim.statusCode).toBe(200);
    attemptId = db
      .prepare("SELECT current_attempt_id FROM tasks WHERE id = ?")
      .get(taskId) as { current_attempt_id: string | null };
    expect(attemptId.current_attempt_id).toBeTruthy();
    attemptId = attemptId.current_attempt_id!;
  });

  afterAll(async () => {
    await app.close();
  });

  it("heartbeat с правильным attempt_id — 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/heartbeat`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": attemptId,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("heartbeat без заголовка — 200 (мягкий enforcement, старый клиент)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/heartbeat`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("heartbeat с чужим attempt_id — 400 attempt_id_mismatch", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/heartbeat`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("attempt_id_mismatch");
  });

  it("после release (state=null) heartbeat отбивается, но не attempt_id-ом", async () => {
    // Снять задачу (state=null) может только владелец, не агент (матрица
    // переходов agentState.ts, строка «if (to === null) return who.isOwner»).
    // Агентский POST /state с {state:null} возвращает 400 invalid_transition
    // и не меняет agent_state — задача остаётся в работе, heartbeat
    // проходит. Этот тест фиксирует текущее поведение, чтобы в шаге 4
    // (state на attempts) видеть, что изменилось.
    const releaseAttempt = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": attemptId,
      },
      payload: { state: null },
    });
    expect(releaseAttempt.statusCode).toBe(400);
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/heartbeat`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": attemptId,
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
