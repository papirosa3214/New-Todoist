import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

/** Серверный контракт: одобрение всегда относится к конкретной версии результата. */
describe("Версии результата и review", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentToken: string;
  let agentId: string;

  async function makeUser(name: string, email: string, patch?: Record<string, string>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const [key, value] of Object.entries(patch ?? {})) {
      db.prepare(`UPDATE users SET ${key} = ? WHERE id = ?`).run(value, body.user.id);
    }
    return body;
  }

  async function apiToken(jwt: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${jwt}` },
    });
    return res.json().api_token as string;
  }

  async function makeTask(title: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title, assignee_id: agentId },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().task.id as string;
    const ready = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { ready_for_pickup: true },
    });
    expect(ready.statusCode).toBe(200);
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(claim.statusCode).toBe(200);
    return id;
  }

  async function submit(taskId: string, comment: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "review", comment },
    });
    expect(res.statusCode).toBe(200);
  }

  async function approve(taskId: string, version: any) {
    return app.inject({
      method: "POST",
      url: "/api/reviews",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        task_id: taskId,
        version_id: version.id,
        artifact_hash: version.artifact_hash,
        criteria_version: "taskflow/review-v1",
        task_revision: version.task_revision,
        verdict: "approved",
      },
    });
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await makeUser("Version Owner", "version-owner@test.local", { role: "owner" });
    ownerId = owner.user.id;
    ownerToken = owner.token;
    const agent = await makeUser("Version Agent", "version-agent@test.local", { type: "ai" });
    agentId = agent.user.id;
    agentToken = await apiToken(agent.token);
  });

  afterAll(async () => {
    await app.close();
  });

  it("создаёт версию при сдаче и автоодобряет её при закрытии владельцем", async () => {
    const taskId = await makeTask("versioned result approval");
    await submit(taskId, "V1 готова: добавлен проверяемый результат");

    const versions = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/versions`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(versions.statusCode).toBe(200);
    const version = versions.json().versions[0];
    expect(version.version_no).toBe(1);
    expect(version.result).toContain("V1");
    expect(version.is_current).toBe(true);

    const completed = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "completed" },
    });
    expect(completed.statusCode).toBe(200);

    const review = db.prepare(
      `SELECT reviewer_id, verdict FROM reviews
       WHERE version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(version.id) as { reviewer_id: string; verdict: string } | undefined;
    expect(review).toEqual({ reviewer_id: ownerId, verdict: "approved" });
  });

  it("делает старое одобрение непригодным после V2", async () => {
    const taskId = await makeTask("version two invalidates version one");
    await submit(taskId, "V1 result");
    const first = (await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/versions`,
      headers: { authorization: `Bearer ${ownerToken}` },
    })).json().versions[0];
    expect((await approve(taskId, first)).statusCode).toBe(201);

    const returned = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { state: "in_progress", comment: "нужно уточнить результат" },
    });
    expect(returned.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/versions`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { result: "V2 result", evidence: ["tests/result-v2.log"] },
    });
    expect(second.statusCode).toBe(201);
    const secondVersion = second.json().version;

    const stale = await approve(taskId, first);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain("актуальной версии");

    const current = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/versions`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const rows = current.json().versions;
    expect(rows.map((row: any) => row.version_no)).toEqual([1, 2]);
    expect(rows[0].is_current).toBe(false);
    expect(rows[1].is_current).toBe(true);
    expect((await approve(taskId, secondVersion)).statusCode).toBe(201);
  });
});
