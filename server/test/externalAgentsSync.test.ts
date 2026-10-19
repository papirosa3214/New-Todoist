import { beforeAll, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { syncExternalAgents } from "../src/lib/externalAgents.js";
import { externalRuntime, ROLE_NAMES } from "../src/roleRouting.js";

describe("«Обновить»: внешние агенты заводятся участниками", () => {
  beforeAll(() => { migrate(); runMigrations(); });
  it("установленный Claude Code становится участником со своей учёткой и иконкой, повтор не дублирует", async () => {
    const fakeFetch = (async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { status: 200 })) as unknown as typeof fetch;
    const first = await syncExternalAgents(fakeFetch);
    const claude = first.find((a) => a.runtime === "claude-code")!;
    if (!claude.installed) return; // на машине без claude проверять нечего
    expect(claude.enabled).toBe(true);
    expect(externalRuntime("claude_code")).toBe("claude-code");
    expect(ROLE_NAMES).toContain("claude_code");
    const user = db.prepare("SELECT name, type, avatar_url FROM users WHERE id = 'role_claude_code'").get() as any;
    expect(user).toMatchObject({ name: "Claude Code", type: "ai" });
    expect(user.avatar_url).toMatch(/^\/api\/avatars\/agent-claude-code-[0-9a-f]{12}\.svg$/);
    await syncExternalAgents(fakeFetch);
    expect((db.prepare("SELECT COUNT(*) AS n FROM roles WHERE key = 'claude_code'").get() as any).n).toBe(1);
    // агенты без адаптера находятся, но участниками не заводятся
    expect(db.prepare("SELECT 1 FROM roles WHERE key = 'codex'").get()).toBeUndefined();
    // внутренние роли остаются на Pi
    expect(externalRuntime("builder")).toBeNull();
  });
});
