import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("role catalog API", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    app = await buildApp();
    db.prepare(
      `INSERT OR IGNORE INTO users
         (id, name, email, password_hash, role, type, is_system_bot)
       VALUES ('u2', 'Claude_Bot', 'claude-bot-api-test@taskflow.local',
               'hash', 'agent', 'ai', 1)`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO users
         (id, name, email, password_hash, role, role_key, type, is_system_bot)
       VALUES ('role_architect', 'Architect API test',
               'architect-api-test@taskflow.local', 'hash', 'agent', 'architect', 'ai', 1)`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO role_skills (role, skill_name, description)
       VALUES ('architect', 'architecture', 'Проектирование систем')`,
    ).run();

    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: `RoleApiOwner${Date.now()}`,
        email: `role-api-owner-${Date.now()}@test`,
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
        name: `RoleApiAgent${Date.now()}`,
        email: `role-api-agent-${Date.now()}@test`,
        password: "password123",
      },
    });
    agentId = agent.json().user.id;
    db.prepare("UPDATE users SET type = 'ai', role = 'agent' WHERE id = ?").run(
      agentId,
    );
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

  it("lists eight roles and returns Architect details", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/roles",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().roles).toHaveLength(8);
    expect(list.json().roles.map((role: { role: string }) => role.role)).toEqual([
      "researcher",
      "analyst",
      "critic_verifier",
      "architect",
      "builder",
      "qa",
      "designer",
      "secretary",
    ]);
    // У Секретаря нет учётки role_secretary — название всё равно по-русски,
    // из таблицы ролей (владелец 27.09.2026 видел в исполнителях «secretary»).
    const secretary = list.json().roles.find((r: { role: string }) => r.role === "secretary");
    expect(secretary.title).toBe("Секретарь");

    const details = await app.inject({
      method: "GET",
      url: "/api/roles/architect",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(details.statusCode).toBe(200);
    expect(details.json()).toMatchObject({
      role: "architect",
      model: "MiniMax-M3",
      // 18.09.2026 (карточка f3108dcc): новое runtime_id — фасадное поле,
      // всегда 'runtime:pi'. default_shell сохранён как legacy-alias для UI.
      runtime_id: "runtime:pi",
      default_shell: "pi_runtime",
      fallbacks: [],
    });
    expect(details.json().skills).toEqual([
      { skill_name: "architecture", description: "Проектирование систем" },
    ]);
    expect(details.json().tools).toContain("taskflow_doc_write");
  });

  it("returns a role for a role account and null for a shell account", async () => {
    const role = await app.inject({
      method: "GET",
      url: "/api/agents/role_architect/role",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(role.statusCode).toBe(200);
    expect(role.json()).toMatchObject({
      agent_id: "role_architect",
      role: "architect",
    });

    const shell = await app.inject({
      method: "GET",
      url: "/api/agents/u2/role",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(shell.statusCode).toBe(200);
    expect(shell.json()).toMatchObject({ agent_id: "u2", role: null });
  });

  it("rejects unknown roles and missing accounts", async () => {
    const unknown = await app.inject({
      method: "GET",
      url: "/api/roles/no-such-role",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(unknown.statusCode).toBe(404);

    const missing = await app.inject({
      method: "GET",
      url: "/api/agents/no-such-agent/role",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("lets an architect agent claim its task but rejects a foreign task", async () => {
    const own = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Architect own claim" },
    });
    const ownId = own.json().task.id as string;
    markReadyForPickup(ownId);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(agentId, ownId);
    const ownClaim = await app.inject({
      method: "POST",
      url: `/api/tasks/${ownId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { session_id: "architect-own-claim" },
    });
    expect(ownClaim.statusCode).toBe(200);

    const foreign = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Architect foreign claim" },
    });
    const foreignId = foreign.json().task.id as string;
    markReadyForPickup(foreignId);
    db.prepare("UPDATE tasks SET assignee_id = 'u2' WHERE id = ?").run(foreignId);
    const foreignClaim = await app.inject({
      method: "POST",
      url: `/api/tasks/${foreignId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { session_id: "architect-foreign-claim" },
    });
    expect(foreignClaim.statusCode).toBe(403);
  });
});
