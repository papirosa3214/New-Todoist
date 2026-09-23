// Тест на дедупликацию комментариев ревьюера: одна выдача вердикта —
// одна строка в ленте, независимо от того, сколько раз вызвался
// POST /api/reviews и прислал ли агент ещё отдельный комментарий
// через POST /api/tasks/:id/comments с тем же findings.
//
// Прецедент 22.09.2026: critic_verifier вызывал taskflow_review 3-4 раза
// подряд и параллельно слал taskflow_comment с теми же findings — в ленте
// появлялось 2-4 одинаковых строки. Фикс — на сервере, чтобы LLM не мог
// обойти защиту, перестав звать инструмент «правильно».
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Reviewer comment deduplication", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let agentId: string;
  let reviewerToken: string;

  async function register(name: string, email: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email, password: "password123" },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function createSubmittedTask() {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        title: "Дедуп-комментариев ревьюера",
        assignee_id: agentId,
      },
    });
    expect(created.statusCode).toBe(200);
    const task = created.json().task;
    db.prepare("UPDATE tasks SET ready_for_pickup = 1 WHERE id = ?").run(task.id);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/tasks/${task.id}/claim`,
          headers: { authorization: `Bearer ${agentToken}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/tasks/${task.id}/state`,
          headers: { authorization: `Bearer ${agentToken}` },
          payload: { state: "review", comment: "Результат готов" },
        })
      ).statusCode,
    ).toBe(200);
    const versions = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}/versions`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    return { task, version: versions.json().versions[0] };
  }

  async function reviewerComments(taskId: string): Promise<string[]> {
    const detail = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    return (detail.json().comments || []).map((c: any) => c.text);
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await register("Dedup Owner", "dedup-owner@test.local");
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.user.id);
    ownerToken = owner.token;
    const agent = await register("Dedup Agent", "dedup-agent@test.local");
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agent.user.id);
    agentId = agent.user.id;
    agentToken = agent.token;
    const reviewer = await register("Dedup Reviewer", "dedup-reviewer@test.local");
    db.prepare("UPDATE users SET reviewer = 1 WHERE id = ?").run(reviewer.user.id);
    reviewerToken = reviewer.token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("три POST /api/reviews подряд от одного ревьюера → одна строка в ленте", async () => {
    const { task, version } = await createSubmittedTask();
    const findings = "Один и тот же комментарий ревьюера, посланный трижды";
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
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
          findings,
        },
      });
      expect(r.statusCode).toBe(201);
    }
    const texts = await reviewerComments(task.id);
    const matching = texts.filter((t) => t.includes(findings));
    expect(matching.length).toBe(1);
  });

  it("changes_requested подряд от одного ревьюера → одна строка в ленте", async () => {
    const { task, version } = await createSubmittedTask();
    const findings = "Возврат на доработку — один и тот же текст трижды";
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/reviews",
        headers: { authorization: `Bearer ${reviewerToken}` },
        payload: {
          task_id: task.id,
          version_id: version.id,
          artifact_hash: version.artifact_hash,
          criteria_version: "1",
          task_revision: version.task_revision,
          verdict: "changes_requested",
          findings,
        },
      });
      expect(r.statusCode).toBe(201);
    }
    const texts = await reviewerComments(task.id);
    const matching = texts.filter((t) => t.includes(findings));
    expect(matching.length).toBe(1);
  });
});
