import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Reviewer-first review", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let agentId: string;
  let reviewerToken: string;

  async function register(name: string, email: string) {
    const response = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name, email, password: "password123" } });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function createSubmittedTask() {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: `Bearer ${ownerToken}` }, payload: { title: "Проверить reviewer-first", assignee_id: agentId } });
    expect(created.statusCode).toBe(200);
    const task = created.json().task;
    expect(task.requires_reviewer_review).toBe(true);
    db.prepare("UPDATE tasks SET ready_for_pickup = 1 WHERE id = ?").run(task.id);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim`, headers: { authorization: `Bearer ${agentToken}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/state`, headers: { authorization: `Bearer ${agentToken}` }, payload: { state: "review", comment: "Результат готов" } })).statusCode).toBe(200);
    const versions = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/versions`, headers: { authorization: `Bearer ${ownerToken}` } });
    return { task, version: versions.json().versions[0] };
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await register("Review Owner", "review-owner@test.local");
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.user.id);
    ownerToken = owner.token;
    const agent = await register("Review Agent", "review-agent@test.local");
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agent.user.id);
    agentId = agent.user.id;
    agentToken = agent.token;
    const reviewer = await register("Reviewer", "reviewer-first@test.local");
    db.prepare("UPDATE users SET reviewer = 1 WHERE id = ?").run(reviewer.user.id);
    reviewerToken = reviewer.token;
  });

  afterAll(async () => { await app.close(); });

  it("новая карточка по умолчанию требует Reviewer, но владелец сохраняет ручной override", async () => {
    const { task, version } = await createSubmittedTask();
    expect((await app.inject({ method: "POST", url: "/api/reviews", headers: { authorization: `Bearer ${reviewerToken}` }, payload: { task_id: task.id, version_id: version.id, artifact_hash: version.artifact_hash, criteria_version: "1", task_revision: version.task_revision, verdict: "approved" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/state`, headers: { authorization: `Bearer ${ownerToken}` }, payload: { state: "in_progress", comment: "Верну сам" } })).statusCode).toBe(200);
  });

  it("одобрение Reviewer с комментарием не закрывает карточку", async () => {
    const { task, version } = await createSubmittedTask();
    expect((await app.inject({ method: "POST", url: "/api/reviews", headers: { authorization: `Bearer ${reviewerToken}` }, payload: { task_id: task.id, version_id: version.id, artifact_hash: version.artifact_hash, criteria_version: "1", task_revision: version.task_revision, verdict: "approved", findings: "Проверено, можно закрывать" } })).statusCode).toBe(201);
    const afterApproval = await app.inject({ method: "GET", url: `/api/tasks/${task.id}`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(afterApproval.json().status).toBe("active");
    expect(afterApproval.json().agent_state).toBe("review");
    expect((await app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, headers: { authorization: `Bearer ${ownerToken}` }, payload: { status: "completed" } })).statusCode).toBe(200);
  });
  it("исполнитель не может вернуть reviewer-first задачу из review", async () => {
    const { task } = await createSubmittedTask();
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "in_progress", comment: "сам верну" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("Reviewer возвращает reviewer-first задачу с комментарием", async () => {
    const { task } = await createSubmittedTask();
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/state`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: { state: "in_progress", comment: "Доработайте обработку ошибок" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("владелец возвращает reviewer-first задачу без ограничений", async () => {
    const { task } = await createSubmittedTask();
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/state`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { state: "in_progress", comment: "Верну сам" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("сигнал hasReviewerApprovedCurrentVersion: false до одобрения, true после", async () => {
    const { task, version } = await createSubmittedTask();
    const { hasReviewerApprovedCurrentVersion } = await import("../src/resultVersions.js");
    expect(hasReviewerApprovedCurrentVersion(task.id)).toBe(false);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/reviews",
          headers: { authorization: `Bearer ${reviewerToken}` },
          payload: {
            task_id: task.id,
            version_id: version.id,
            artifact_hash: version.artifact_hash,
            criteria_version: "1",
            task_revision: version.task_revision,
            verdict: "approved",
            findings: "Проверено",
          },
        })
      ).statusCode,
    ).toBe(201);
    expect(hasReviewerApprovedCurrentVersion(task.id)).toBe(true);
  });

  it("вердикт ревьюера виден в ленте карточки без дубля в уведомлениях владельца", async () => {
    const { task, version } = await createSubmittedTask();
    const approve = await app.inject({
      method: "POST",
      url: "/api/reviews",
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        task_id: task.id,
        version_id: version.id,
        artifact_hash: version.artifact_hash,
        criteria_version: "1",
        task_revision: version.task_revision,
        verdict: "approved",
        findings: "Проверил сценарии и результат",
      },
    });
    expect(approve.statusCode).toBe(201);

    const detail = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const texts = (detail.json().comments || []).map((c: any) => c.text).join(" | ");
    expect(texts).toContain("Проверил сценарии и результат");

    const notifs = await app.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(JSON.stringify(notifs.json())).not.toContain("одобрил");
  });

});
