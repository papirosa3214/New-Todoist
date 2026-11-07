import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";
import {
  STOP_REASON_CODES,
  STOP_REASON_POLICIES,
} from "../src/stopReasons.js";

describe("structured stop reasons and contour metrics", () => {
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
        name: "OwnerStopReasons",
        email: "owner-stop-reasons@test",
        password: "password123",
      },
    });
    ownerToken = owner.json().token;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(
      owner.json().user.id,
    );

    const agent = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "AgentStopReasons",
        email: "agent-stop-reasons@test",
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

  async function claimTask(title: string): Promise<{
    id: string;
    attemptId: string;
  }> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title },
    });
    const id = created.json().task.id as string;
    markReadyForPickup(id);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(
      agentId,
      id,
    );
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { session_id: `test-${id}` },
    });
    expect(claim.statusCode).toBe(200);
    const row = db
      .prepare("SELECT current_attempt_id FROM tasks WHERE id = ?")
      .get(id) as { current_attempt_id: string };
    return { id, attemptId: row.current_attempt_id };
  }

  it("uses the closed list and maps every reason to one action", () => {
    expect(STOP_REASON_CODES).toHaveLength(8);
    expect(
      STOP_REASON_CODES.map((code) => STOP_REASON_POLICIES[code].action),
    ).toEqual([
      "escalate_capability",
      "reroute_competence",
      "return_for_rework",
      "retry_technical",
      "wait_provider",
      "wait_owner",
      "close_attempt",
      "stop_budget",
    ]);
  });

  it("records technical retries separately without creating attempts", async () => {
    const task = await claimTask("technical retry does not become an attempt");
    for (let i = 1; i <= 3; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/stop`,
        headers: {
          authorization: `Bearer ${agentToken}`,
          "x-agent-attempt-id": task.attemptId,
        },
        payload: {
          reason_code: "technical_failure",
          comment: `сбой ${i}`,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().retry_count).toBe(i);
    }
    const exhausted = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/stop`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": task.attemptId,
      },
      payload: { reason_code: "technical_failure" },
    });
    expect(exhausted.statusCode).toBe(409);

    const attemptCount = db
      .prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?")
      .get(task.id) as { n: number };
    const retryCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM attempt_retries r
           JOIN attempts a ON a.id = r.attempt_id WHERE a.task_id = ?`,
      )
      .get(task.id) as { n: number };
    expect(attemptCount.n).toBe(1);
    expect(retryCount.n).toBe(3);

    const metrics = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}/activity/metrics`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json().metrics).toMatchObject({
      substantive_attempts: 1,
      repeated_substantive_attempts: 0,
      technical_retries: 3,
    });
  });

  it("closes a substantive attempt for a non-technical reason", async () => {
    const task = await claimTask("structured reason closes attempt");
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/stop`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": task.attemptId,
      },
      payload: {
        reason_code: "permission_or_owner",
        comment: "нужен ответ владельца",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe("wait_owner");
    const row = db
      .prepare(
        "SELECT agent_state, current_attempt_id FROM tasks WHERE id = ?",
      )
      .get(task.id) as {
      agent_state: string;
      current_attempt_id: string | null;
    };
    expect(row.agent_state).toBe("blocked");
    expect(row.current_attempt_id).toBeNull();
    const attempt = db
      .prepare("SELECT outcome, reason_code FROM attempts WHERE id = ?")
      .get(task.attemptId) as { outcome: string; reason_code: string };
    expect(attempt).toEqual({
      outcome: "wait_owner",
      reason_code: "permission_or_owner",
    });
  });
});
