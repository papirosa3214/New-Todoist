import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { runRoleAccountSecurityMigration } from "../src/migrations.js";

type MigratedUser = {
  id: string;
  role: string;
  role_key: string | null;
  api_token: string | null;
};

describe("058_role_account_authority upgrade", () => {
  it("безопасно backfill-ит legacy role_owner и обычную роль, сохраняет identity/token/FK и идемпотентна", () => {
    const legacy = new Database(":memory:");
    legacy.pragma("foreign_keys = ON");
    try {
      legacy.exec(`
        CREATE TABLE roles (key TEXT PRIMARY KEY);
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL,
          type TEXT NOT NULL,
          is_system_bot INTEGER DEFAULT 0,
          api_token TEXT
        );
        CREATE TABLE owned_rows (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id)
        );

        INSERT INTO roles (key) VALUES ('owner'), ('builder');
        INSERT INTO users
          (id, name, email, password_hash, role, type, is_system_bot, api_token)
        VALUES
          ('role_owner', 'Legacy forged owner', 'role-owner@legacy.test', '!', 'owner', 'ai', 1, 'owner-token-hash'),
          ('role_builder', 'Legacy builder', 'role-builder@legacy.test', '!', 'builder', 'ai', 1, 'builder-token-hash'),
          ('legacy-builder', 'Non-canonical builder', 'legacy-builder@legacy.test', '!', 'builder', 'ai', 1, 'legacy-token-hash');
        INSERT INTO owned_rows (id, user_id) VALUES ('kept-reference', 'role_owner');
      `);

      expect(() => runRoleAccountSecurityMigration(legacy)).not.toThrow();
      expect(() => runRoleAccountSecurityMigration(legacy)).not.toThrow();

      const migrated = legacy
        .prepare(
          `SELECT id, role, role_key, api_token
             FROM users
            WHERE id IN ('role_owner', 'role_builder', 'legacy-builder')
            ORDER BY id`,
        )
        .all() as MigratedUser[];
      expect(migrated).toEqual([
        {
          id: "legacy-builder",
          role: "agent",
          role_key: null,
          api_token: "legacy-token-hash",
        },
        {
          id: "role_builder",
          role: "agent",
          role_key: "builder",
          api_token: "builder-token-hash",
        },
        {
          id: "role_owner",
          role: "agent",
          role_key: "owner",
          api_token: "owner-token-hash",
        },
      ]);
      expect(
        legacy.prepare("SELECT user_id FROM owned_rows WHERE id = 'kept-reference'").get(),
      ).toEqual({ user_id: "role_owner" });
      expect(legacy.prepare("SELECT key FROM roles WHERE key = 'owner'").get()).toEqual({
        key: "owner",
      });

      const uniqueIndex = legacy
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_role_key_unique'",
        )
        .get() as { sql: string } | undefined;
      expect(uniqueIndex?.sql).toMatch(/UNIQUE INDEX[\s\S]+WHERE role_key IS NOT NULL/i);

      expect(() =>
        legacy.prepare("INSERT INTO roles (key) VALUES ('viewer')").run(),
      ).toThrow(/reserved role key/);
      expect(() =>
        legacy
          .prepare(
            `INSERT INTO users
               (id, name, email, password_hash, role, type, is_system_bot)
             VALUES ('bad-authority', 'Bad authority', 'bad-authority@test', '!', 'builder', 'ai', 1)`,
          )
          .run(),
      ).toThrow(/invalid users\.role authority/);
      expect(() =>
        legacy
          .prepare(
            `INSERT INTO users
               (id, name, email, password_hash, role, role_key, type, is_system_bot)
             VALUES ('role_intruder', 'Intruder', 'intruder@test', '!', 'agent', 'builder', 'human', 1)`,
          )
          .run(),
      ).toThrow(/invalid users\.role_key binding/);
      expect(() =>
        legacy.prepare("UPDATE users SET role = 'owner' WHERE id = 'role_builder'").run(),
      ).toThrow(/invalid users\.role_key binding/);
      expect(() =>
        legacy.prepare("DELETE FROM roles WHERE key = 'builder'").run(),
      ).toThrow(/role key is bound to an account/);
    } finally {
      legacy.close();
    }
  });
});

describe("normal role account authority", () => {
  const roleKey = "authority_probe";
  const accountId = `role_${roleKey}`;
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    db.prepare(
      `INSERT INTO roles (key, title, summary, enabled, position)
       VALUES (?, 'Authority Probe', '', 1, 999)`,
    ).run(roleKey);
    db.prepare(
      `INSERT INTO users
         (id, name, email, password_hash, role, role_key, type, is_system_bot)
       VALUES (?, 'Authority Probe', 'authority-probe@test', '!', 'agent', ?, 'ai', 1)`,
    ).run(accountId, roleKey);
  });

  afterAll(async () => {
    db.prepare("DELETE FROM users WHERE id = ?").run(accountId);
    db.prepare("DELETE FROM roles WHERE key = ?").run(roleKey);
    await app.close();
  });

  it("получает 403 на owner-only PATCH", async () => {
    const roleJwt = app.jwt.sign({ id: accountId }, { expiresIn: "5m" });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/roles/${roleKey}`,
      headers: { authorization: `Bearer ${roleJwt}` },
      payload: { summary: "privilege escalation must fail" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "owner_or_service_required" });
  });
});
