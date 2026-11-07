import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("GET /api/tasks/:id attempt_ladder", () => {
  let app: FastifyInstance;
  let token: string;
  let ownerId: string;
  let taskId: string;

  beforeAll(async () => {
    app = await buildApp();
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "LadderOwner",
        email: `ladder-${crypto.randomUUID()}@test.local`,
        password: "password123",
      },
    });
    token = registration.json().token;
    ownerId = registration.json().user.id;
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Лесенка в карточке" },
    });
    taskId = created.json().task.id;
    const insert = db.prepare(
      `INSERT INTO attempts
       (id, task_id, executor_id, runner, model, started_at, ended_at, outcome, reason_code)
       VALUES (?, ?, ?, 'Claude', ?, ?, ?, ?, ?)`,
    );
    insert.run(crypto.randomUUID(), taskId, ownerId, "haiku", "2026-09-13 10:00:00", "2026-09-13 10:01:00", "needs_escalation", "insufficient_capability");
    insert.run(crypto.randomUUID(), taskId, ownerId, "sonnet", "2026-09-13 10:02:00", null, null, null);
  });

  afterAll(async () => app.close());

  it("returns ordered progress and attempt history", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().attempt_ladder).toMatchObject({
      current_step: 2,
      total_steps: 3,
      current_model: "sonnet",
    });
    expect(response.json().attempt_ladder.history.map((item: any) => item.model)).toEqual(["haiku", "sonnet"]);
  });
});
