import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("provider_limit fallback routing", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let roleAgentToken: string;
  let roleAgentId: string;

  beforeAll(async () => {
    app = await buildApp();
    const shells = [
      ["u2", "Claude_Bot"],
      ["u3", "Hermes"],
      ["6848a89b-04fe-4015-bb1c-61b03782c378", "Оркестратор Claude"],
      ["b85212d6-abab-4afb-a4c6-0d379b6537a4", "DeepSeek-Agent"],
      ["5b9d47c1-25c7-4a7c-a276-70e21f7d7816", "Antigravity"],
    ] as const;
    const insertShell = db.prepare(
      `INSERT OR IGNORE INTO users
         (id, name, email, password_hash, role, type)
       VALUES (?, ?, ?, 'test-hash', 'agent', 'ai')`,
    );
    for (const [id, name] of shells) {
      insertShell.run(id, name, `${id}@provider-fallback.test`);
    }
    const suffix = Date.now();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: `OwnerProviderFallback${suffix}`,
        email: `owner-provider-fallback-${suffix}@test`,
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
        name: `ArchitectProviderFallback${suffix}`,
        email: `architect-provider-fallback-${suffix}@test`,
        password: "password123",
      },
    });
    roleAgentId = agent.json().user.id;
    db.prepare("UPDATE users SET type = 'ai', role = 'agent' WHERE id = ?").run(
      roleAgentId,
    );
    roleAgentToken = (
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

  async function claimTask(title: string): Promise<{ id: string; attemptId: string }> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title },
    });
    const id = created.json().task.id as string;
    markReadyForPickup(id);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(
      roleAgentId,
      id,
    );
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/claim`,
      headers: { authorization: `Bearer ${roleAgentToken}` },
      payload: { session_id: `provider-fallback-${id}` },
    });
    expect(claim.statusCode).toBe(200);
    const row = db
      .prepare("SELECT current_attempt_id FROM tasks WHERE id = ?")
      .get(id) as { current_attempt_id: string };
    return { id, attemptId: row.current_attempt_id };
  }

  it("blocks instead of switching to a legacy shell", async () => {
    const task = await claimTask("provider limit default to fallback");
    db.prepare("UPDATE attempts SET executor_id = ? WHERE id = ?").run(
      "6848a89b-04fe-4015-bb1c-61b03782c378",
      task.attemptId,
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/stop`,
      headers: {
        authorization: `Bearer ${roleAgentToken}`,
        "x-agent-attempt-id": task.attemptId,
      },
      payload: { reason_code: "provider_limit", comment: "лимит API" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().fallback).toBeNull();
    const taskRow = db
      .prepare(
        "SELECT assignee_id, agent_state, current_attempt_id FROM tasks WHERE id = ?",
      )
      .get(task.id) as {
      assignee_id: string;
      agent_state: string;
      current_attempt_id: string;
    };
    expect(taskRow).toMatchObject({
      assignee_id: roleAgentId,
      agent_state: "blocked",
    });
    expect(
      db
        .prepare("SELECT outcome, reason_code FROM attempts WHERE id = ?")
        .get(task.attemptId),
    ).toEqual({ outcome: "wait_provider", reason_code: "provider_limit" });
  });

  it("blocks when provider_limit happens on the last fallback", async () => {
    const task = await claimTask("provider limit last fallback blocks");
    db.prepare("UPDATE attempts SET executor_id = ? WHERE id = ?").run(
      "b85212d6-abab-4afb-a4c6-0d379b6537a4",
      task.attemptId,
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/stop`,
      headers: {
        authorization: `Bearer ${roleAgentToken}`,
        "x-agent-attempt-id": task.attemptId,
      },
      payload: { reason_code: "provider_limit", comment: "закончились провайдеры" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().fallback).toBeNull();
    expect(
      db
        .prepare("SELECT agent_state, current_attempt_id FROM tasks WHERE id = ?")
        .get(task.id),
    ).toEqual({ agent_state: "blocked", current_attempt_id: null });
    expect(
      db
        .prepare("SELECT outcome, reason_code FROM attempts WHERE id = ?")
        .get(task.attemptId),
    ).toEqual({ outcome: "wait_provider", reason_code: "provider_limit" });
  });
});
