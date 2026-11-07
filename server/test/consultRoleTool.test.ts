// «Посоветоваться со старшей моделью» для ролей (владелец 01.10.2026):
// POST /api/consult сам находит попытку роли и модель консультанта.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

const callAiMock = vi.fn(async (_opts: any) => "Сначала миграция, потом код: так откат дешевле.");
vi.mock("../src/routes/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/ai.js")>();
  return { ...actual, callUnifiedAi: (...args: any[]) => callAiMock(...(args as [any])) };
});

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");

describe("совет старшей модели для роли", () => {
  let app: FastifyInstance;
  let owner: { authorization: string };
  const as = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ id })}` });

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "ConsultOwner", email: `consult-${Date.now()}@test`, password: "password123" },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    owner = { authorization: `Bearer ${reg.json().token}` };
  });
  beforeEach(() => callAiMock.mockClear());
  afterAll(async () => {
    if (app) await app.close();
  });

  it("в шаге задачи: попытка находится сама, в журнал, второй раз — нет", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: owner, payload: { title: "Consult " + Date.now() } });
    const taskId = created.json().task.id as string;
    const attemptId = crypto.randomUUID();
    db.prepare("INSERT INTO attempts (id, task_id, executor_id, started_at) VALUES (?, ?, 'role_architect', datetime('now'))").run(attemptId, taskId);
    const stepId = crypto.randomUUID();
    db.prepare("INSERT INTO subtasks (id, task_id, title, position, agent_id, agent_state, current_attempt_id) VALUES (?, ?, 'Решение', 1, 'role_architect', 'in_progress', ?)")
      .run(stepId, taskId, attemptId);
    // Задача не на архитекторе — у него только свой шаг плана.

    const res = await app.inject({
      method: "POST",
      url: "/api/consult",
      headers: as("role_architect"),
      payload: { question: "Миграция или код первым?", subtask_id: stepId, context: { options: ["A", "B"] } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toContain("миграция");
    const prompt = JSON.parse(callAiMock.mock.calls[0][0].userPrompt);
    expect(prompt.task.id).toBe(taskId);
    expect(prompt.agent_context).toEqual({ options: ["A", "B"] });
    const logged = db.prepare("SELECT triggered_by FROM consultation_log WHERE attempt_id = ?").get(attemptId) as { triggered_by: string };
    expect(logged.triggered_by).toBe("role_tool");

    const again = await app.inject({
      method: "POST",
      url: "/api/consult",
      headers: as("role_architect"),
      payload: { question: "А ещё?", subtask_id: stepId },
    });
    expect(again.statusCode).toBe(429);
  });

  it("в чате без задачи — до трёх советов в час", async () => {
    const ask = () => app.inject({ method: "POST", url: "/api/consult", headers: as("role_analyst"), payload: { question: "Как считать retention?" } });
    for (let i = 0; i < 3; i += 1) expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(429);
    expect(callAiMock).toHaveBeenCalledTimes(3);
  });
});
