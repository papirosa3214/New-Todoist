import { beforeAll, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { discoverExternalAgents, syncExternalAgents } from "../src/lib/externalAgents.js";
import { externalRuntime, ROLE_NAMES } from "../src/roleRouting.js";

const fakeFetch = (async () =>
  new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { status: 200 })) as unknown as typeof fetch;

describe("«Обновить»: внешние агенты заводятся участниками", () => {
  beforeAll(() => {
    migrate();
    runMigrations();
  });

  it("Claude Code убран из каталога: не находится и участником не заводится", async () => {
    // Владелец 04.11.2026: внешний агент Claude Code не нужен — из чатов и
    // боковой панели уходил краб-аватаркой.
    expect(discoverExternalAgents().find((a) => a.runtime === "claude-code")).toBeUndefined();
    const after = await syncExternalAgents(fakeFetch);
    expect(after.find((a) => a.runtime === "claude-code")).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM roles WHERE key = 'claude_code'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM users WHERE id = 'role_claude_code'").get()).toBeUndefined();
    expect(externalRuntime("claude_code")).toBeNull();
    expect(ROLE_NAMES).not.toContain("claude_code");
  });

  it("уже заведённый Claude Code выключается, а учётка участника архивируется", () => {
    db.prepare(
      "INSERT INTO roles (key, title, summary, enabled, position, prompt, runtime) VALUES ('claude_code', 'Claude Code', 'x', 1, 99, NULL, 'claude-code')",
    ).run();
    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, role_key, type, is_system_bot, profile, initials, avatar_color)
       VALUES ('role_claude_code', 'Claude Code', 'claude-code@taskflow.local', '!no-login', 'agent', 'claude_code', 'ai', 1, 'claude_code', 'CC', '#D97757')`,
    ).run();
    // Миграция уже применена в beforeAll — перекатываем её, чтобы увидеть уборку.
    db.prepare("DELETE FROM schema_migrations WHERE id = '197_external_agent_claude_code_removed'").run();
    runMigrations();
    expect(db.prepare("SELECT enabled FROM roles WHERE key = 'claude_code'").get()).toMatchObject({ enabled: 0 });
    expect(db.prepare("SELECT archived FROM users WHERE id = 'role_claude_code'").get()).toMatchObject({ archived: 1 });
    expect(ROLE_NAMES).not.toContain("claude_code");
  });

  it("агенты без адаптера находятся, но участниками не заводятся; внутренние роли остаются на Pi", async () => {
    const found = await syncExternalAgents(fakeFetch);
    expect(found.length).toBeGreaterThan(0);
    expect(db.prepare("SELECT 1 FROM roles WHERE key = 'codex'").get()).toBeUndefined();
    expect(externalRuntime("builder")).toBeNull();
  });
});
