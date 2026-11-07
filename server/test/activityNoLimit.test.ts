// Список действий в карточке не режется до 20, счётчик «всего действий» честный (владелец
// 06.10.2026: по числу действий он видит, жив ли процесс).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("Лента действий без лимита в 20", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "OwnerAL", email: "owner@act-limit.test", password: "password123" } });
    ownerToken = owner.json().token;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.json().user.id);
    const agent = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "AgentAL", email: "agent@act-limit.test", password: "password123" } });
    agentToken = agent.json().token;
    agentId = agent.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);
  });

  afterAll(async () => { await app.close(); });

  it("60 действий — все 60 в ответе, total растёт", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: `Bearer ${ownerToken}` }, payload: { title: "Много действий", assignee_id: agentId } });
    const id = created.json().task.id;
    markReadyForPickup(id);
    await app.inject({ method: "POST", url: `/api/tasks/${id}/claim`, headers: { authorization: `Bearer ${agentToken}` }, payload: {} });
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({ method: "POST", url: `/api/tasks/${id}/activity`, headers: { authorization: `Bearer ${agentToken}` }, payload: { kind: "read", target: `src/file-${i}.ts` } });
      expect(res.statusCode).toBe(200);
    }
    const got = await app.inject({ method: "GET", url: `/api/tasks/${id}/activity`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(got.statusCode).toBe(200);
    const body = got.json();
    expect(body.actions.length).toBe(60);
    expect(body.total).toBe(60);
  });
});
