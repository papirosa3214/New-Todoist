import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db, { hashApiToken } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";

describe("миграция ролей спека 1.1", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("сохраняет системные authority и ставит DB guard поверх старой схемы", () => {
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
      .get() as { sql: string };
    expect(ddl.sql).not.toMatch(/CHECK\s*\(\s*role\s+IN/i);

    const oldRoles = ["agent", "orchestrator", "owner", "viewer"];
    for (const [index, role] of oldRoles.entries()) {
      db.prepare(
        "INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
      ).run(`legacy-${index}`, `Legacy ${role}`, `${role}-${index}@test`, "hash", role);
    }
    expect(
      db
        .prepare(
          "SELECT role FROM users WHERE id LIKE 'legacy-%' ORDER BY id",
        )
        .all()
        .map(({ role }: { role: string }) => role),
    ).toEqual(["agent", "orchestrator", "owner", "viewer"]);
  });

  it("не позволяет business key в authority и сохраняет role_skills", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
        )
        .run("new-role", "Researcher", "new-role@test", "hash", "researcher"),
    ).toThrow(/invalid users\.role authority/);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='role_skills'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_role_skills_skill'",
        )
        .get(),
    ).toBeTruthy();
    const columns = db
      .prepare("PRAGMA table_info(role_skills)")
      .all()
      .map(({ name }: { name: string }) => name);
    expect(columns).toEqual(["role", "skill_name", "description", "created_at"]);
  });

  it("остаётся идемпотентной при повторном запуске миграций", () => {
    expect(() => runMigrations()).not.toThrow();
  });

  it("роль-агент может claim свою задачу, но не чужую", async () => {
    const owner = db.prepare(
      "INSERT INTO users (id, name, email, password_hash, role, type) VALUES (?, ?, ?, ?, 'owner', 'human')",
    );
    owner.run("claim-owner", "Claim owner", "claim-owner@test", "hash");
    const insertAgent = db.prepare(
      "INSERT INTO users (id, name, email, password_hash, role, type, api_token) VALUES (?, ?, ?, ?, 'agent', 'ai', ?)",
    );
    insertAgent.run(
      "claim-researcher",
      "Claim Researcher",
      "claim-researcher@test",
      "hash",
      hashApiToken("tf_claim_researcher"),
    );
    insertAgent.run(
      "claim-analyst",
      "Claim Analyst",
      "claim-analyst@test",
      "hash",
      hashApiToken("tf_claim_analyst"),
    );
    db.prepare(
      "INSERT INTO tasks (id, title, creator_id, assignee_id, ready_for_pickup) VALUES (?, ?, ?, ?, 1)",
    ).run(
      "claim-role-task",
      "Claim role task",
      "claim-owner",
      "claim-researcher",
    );

    const own = await app.inject({
      method: "POST",
      url: "/api/tasks/claim-role-task/claim",
      headers: { authorization: "Bearer tf_claim_researcher" },
    });
    expect(own.statusCode).toBe(200);

    db.prepare(
      "UPDATE tasks SET agent_state = NULL, assignee_id = 'claim-researcher', agent_heartbeat_at = NULL WHERE id = ?",
    ).run("claim-role-task");
    const foreign = await app.inject({
      method: "POST",
      url: "/api/tasks/claim-role-task/claim",
      headers: { authorization: "Bearer tf_claim_analyst" },
    });
    expect(foreign.statusCode).toBe(403);
  });
});
