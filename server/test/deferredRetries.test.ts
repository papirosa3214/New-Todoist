// Отложенные технические повторы (хэндофф 20.09.2026, «добивание»).
//
// /api/tasks/:id/stop с reason_code='technical_failure' пишет строку в
// attempt_retries с scheduled_at = now() + задержка, но до этой правки её
// никто не читал — повтор не поднимался. Тесты проверяют новое чтение:
// POST /api/scheduler/deferred-retries/claim отдаёт назревшие повторы
// ровно один раз (идемпотентность через fired_at), не трогает будущие и
// повторы по уже закрытой/неактуальной попытке.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

interface StartedTask {
  id: string;
  attemptId: string;
}

describe("POST /api/scheduler/deferred-retries/claim", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OwnerDeferred",
        email: "owner-deferred@test",
        password: "password123",
      },
    });
    ownerToken = owner.json().token;

    const agent = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "AgentDeferred",
        email: "agent-deferred@test",
        password: "password123",
      },
    });
    agentId = agent.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);
    agentToken = (
      await app.inject({
        method: "POST",
        url: "/api/auth/api-token",
        headers: { authorization: `Bearer ${agent.json().token}` },
      })
    ).json().api_token;
  });

  afterAll(async () => {
    await app.close();
  });

  // Владелец создал → подтвердил → агент взял задачу. Возвращает id задачи и
  // живую попытку. Дальше /stop с техническим сбоем пишет attempt_retries.
  async function startTask(title: string): Promise<StartedTask> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title },
    });
    const id = created.json().task.id as string;
    markReadyForPickup(id);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(agentId, id);
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/claim`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": `seed-${id}`,
      },
      payload: {},
    });
    expect(claim.statusCode).toBe(200);
    return { id, attemptId: claim.json().task.current_attempt_id as string };
  }

  async function technicalFailure(task: StartedTask) {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/stop`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": task.attemptId,
      },
      payload: { reason_code: "technical_failure", comment: "сбой" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().retry_count).toBe(1);
  }

  async function claimDeferred(): Promise<any[]> {
    const res = await app.inject({
      method: "POST",
      url: "/api/scheduler/deferred-retries/claim",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    return res.json().retries as any[];
  }

  it("отдаёт назревший повтор и ровно один раз", async () => {
    const task = await startTask("назревший повтор");
    await technicalFailure(task);

    // Повтор записан с задержкой 60с — сдвигаем срок в прошлое, как это
    // сделает само время.
    db.prepare(
      "UPDATE attempt_retries SET scheduled_at = datetime('now', '-1 minute') WHERE attempt_id = ?",
    ).run(task.attemptId);

    const first = await claimDeferred();
    const mine = first.filter((r) => r.task_id === task.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].attempt_id).toBe(task.attemptId);
    expect(mine[0].reason_code).toBe("technical_failure");

    // Отметка fired_at выставлена, повторный обход уже пуст.
    const fired = db
      .prepare("SELECT fired_at FROM attempt_retries WHERE attempt_id = ?")
      .get(task.attemptId) as { fired_at: string | null };
    expect(fired.fired_at).not.toBeNull();

    const second = await claimDeferred();
    expect(second.filter((r) => r.task_id === task.id)).toHaveLength(0);
  });

  it("не трогает повтор, срок которого ещё не наступил", async () => {
    const task = await startTask("будущий повтор");
    await technicalFailure(task);

    const retries = await claimDeferred();
    expect(retries.filter((r) => r.task_id === task.id)).toHaveLength(0);

    const row = db
      .prepare("SELECT fired_at FROM attempt_retries WHERE attempt_id = ?")
      .get(task.attemptId) as { fired_at: string | null };
    expect(row.fired_at).toBeNull();
  });

  it("не поднимает повтор по попытке, которая уже не текущая", async () => {
    const task = await startTask("устаревшая попытка");
    await technicalFailure(task);
    db.prepare(
      "UPDATE attempt_retries SET scheduled_at = datetime('now', '-1 minute') WHERE attempt_id = ?",
    ).run(task.attemptId);
    // Попытка перестала быть текущей (задачу вернули/закрыли) — повтор
    // поднимать некуда.
    db.prepare(
      "UPDATE tasks SET current_attempt_id = NULL WHERE id = ?",
    ).run(task.id);

    const retries = await claimDeferred();
    expect(retries.filter((r) => r.task_id === task.id)).toHaveLength(0);
  });
});
