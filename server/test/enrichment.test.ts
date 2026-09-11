import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "/home/maksim/Проекты/New-Todoist/server/src/index.js";
import db from "/home/maksim/Проекты/New-Todoist/server/src/db.js";

describe("enricher: профильный пул, эскалации и зависимости", () => {
  let app: FastifyInstance;
  let ownerAuth = "";
  let agentAuth = "";
  let agentTwoAuth = "";
  let agentId = "";

  async function register(name: string, email: string) {
    const response = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name, email, password: "password123" } });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await register("Enrich owner", "enrich-owner@test");
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.user.id);
    ownerAuth = `Bearer ${owner.token}`;
    const agent = await register("Enrich agent", "enrich-agent@test");
    db.prepare("UPDATE users SET type = 'ai', profile = 'claude_bot' WHERE id = ?").run(agent.user.id);
    agentId = agent.user.id;
    agentAuth = `Bearer ${agent.token}`;
    const secondAgent = await register("Second enrich agent", "enrich-agent-2@test");
    db.prepare("UPDATE users SET type = 'ai', profile = 'claude_bot' WHERE id = ?").run(secondAgent.user.id);
    agentTwoAuth = `Bearer ${secondAgent.token}`;
  });

  it("публикует уверенную задачу в пул по профильной метке", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: "server api migration", description: "sql database" } });
    const taskId = created.json().task.id;
    await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, headers: { authorization: ownerAuth }, payload: { ready_for_pickup: true } });
    const enriched = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/enrich`, headers: { authorization: agentAuth } });
    expect(enriched.statusCode).toBe(200);
    const pool = await app.inject({ method: "GET", url: "/api/tasks/pool", headers: { authorization: agentAuth } });
    expect(pool.json().tasks.map((task: any) => task.id)).toContain(taskId);
  });

  it("эскалирует неоднозначную задачу идемпотентно", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: "сделать что-нибудь" } });
    const taskId = created.json().task.id;
    const first = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/enrich`, headers: { authorization: agentAuth } });
    const second = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/enrich`, headers: { authorization: agentAuth } });
    expect(first.json().enrichment.escalation.status).toBe("pending");
    expect(second.json().enrichment.escalation.status).toBe("pending");
    expect(second.json().enrichment.escalation.run_count).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS count FROM enrichment_escalations WHERE task_id = ?").get(taskId) as any).count).toBe(1);
  });

  it("не даёт агенту забрать свободную задачу без профильной публикации", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: ownerAuth },
      payload: { title: "задача без тега профиля" },
    });
    const taskId = created.json().task.id;
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: ownerAuth },
      payload: { ready_for_pickup: true },
    });
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: agentAuth },
      payload: {},
    });
    expect(claim.statusCode).toBe(403);
    expect(claim.json().error).toContain("не опубликована в пуле");
  });

  it("оставляет ручное назначение рабочим без профильного тега", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: ownerAuth },
      payload: { title: "ручное назначение" },
    });
    const taskId = created.json().task.id;
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: ownerAuth },
      payload: { assignee_id: agentId, ready_for_pickup: true },
    });
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: agentAuth },
      payload: {},
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().task.assignee_id).toBe(agentId);
  });

  it("в гонке двух self-claim только один агент получает задачу", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: ownerAuth },
      payload: { title: "server api migration race" },
    });
    const taskId = created.json().task.id;
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: ownerAuth },
      payload: { ready_for_pickup: true },
    });
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/enrich`,
      headers: { authorization: agentAuth },
    });
    const claims = await Promise.all([
      app.inject({ method: "POST", url: `/api/tasks/${taskId}/claim`, headers: { authorization: agentAuth }, payload: {} }),
      app.inject({ method: "POST", url: `/api/tasks/${taskId}/claim`, headers: { authorization: agentTwoAuth }, payload: {} }),
    ]);
    expect(claims.filter((response) => response.statusCode === 200)).toHaveLength(1);
    const refusal = claims.find((response) => response.statusCode !== 200);
    expect(refusal).toBeDefined();
    expect(refusal!.json().error).toMatch(/гонка|исполнитель|transition/);
  });

  it("не показывает в пуле задачу с незавершённой зависимостью", async () => {
    const blocker = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: "blocker" } });
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: "server api task" } });
    const blockerId = blocker.json().task.id;
    const taskId = task.json().task.id;
    await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, headers: { authorization: ownerAuth }, payload: { ready_for_pickup: true } });
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/enrich`, headers: { authorization: agentAuth } });
    await app.inject({ method: "PUT", url: `/api/tasks/${taskId}/dependencies`, headers: { authorization: ownerAuth }, payload: { depends_on_task_ids: [blockerId] } });
    const pool = await app.inject({ method: "GET", url: "/api/tasks/pool", headers: { authorization: agentAuth } });
    expect(pool.json().tasks.map((row: any) => row.id)).not.toContain(taskId);
    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(blockerId);
    const readyPool = await app.inject({ method: "GET", url: "/api/tasks/pool", headers: { authorization: agentAuth } });
    expect(readyPool.json().tasks.map((row: any) => row.id)).toContain(taskId);
  });
});
