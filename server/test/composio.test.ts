import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { ROLE_NAMES } from "../src/roleRouting.js";
import { composioCommand, composioSessionOptions, roleComposioPolicy, saveComposioPolicy } from "../src/runtime/composioPolicy.js";
import { prepareRoleRunAccess, releaseRoleRunAccess } from "../src/runtime/roleRunAccess.js";
import { inspectComposio } from "../src/runtime/composioRuntime.js";
import { ToolRouterCreateSessionConfigSchema } from "@composio/core";

vi.mock("../src/runtime/composioRuntime.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/runtime/composioRuntime.js")>(),
  inspectComposio: vi.fn(async () => ({ items: [{ slug: "github", name: "GitHub", connected: false, noAuth: false }] })),
}));

describe("Composio role policy and owner access", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken: string, memberToken: string, ownerId: string;
  const role = ROLE_NAMES[0];
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  beforeAll(async () => {
    app = await buildApp();
    for (const kind of ["owner", "member"]) {
      const result = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: kind, email: `${kind}-${Date.now()}@composio.test`, password: "password123" } });
      if (kind === "owner") {
        ownerToken = result.json().token;
        ownerId = result.json().user.id;
        db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
      } else { memberToken = result.json().token; }
    }
  });
  afterAll(async () => { vi.unstubAllEnvs(); await app.close(); });

  it("starts disabled; non-owners cannot configure or authorize", async () => {
    expect(roleComposioPolicy(role).enabled).toBe(false);
    for (const method of ["GET", "PATCH", "POST"] as const) {
      const res = await app.inject({ method, url: `/api/roles/${role}/composio${method === "POST" ? "/authorize" : ""}`, headers: auth(memberToken), ...(method !== "GET" ? { payload: { enabled: true, toolkits: null, toolkit: "github" } } : {}) });
      expect(res.statusCode).toBe(403);
    }
  });
  it("preserves catalog versus deny-all; deduplicates selection", async () => {
    for (const toolkits of [null, [], ["github", "github"]]) {
      const res = await app.inject({ method: "PATCH", url: `/api/roles/${role}/composio`, headers: auth(ownerToken), payload: { enabled: true, toolkits } });
      expect(res.statusCode).toBe(200);
      expect(roleComposioPolicy(role).toolkits).toEqual(toolkits === null ? null : [...new Set(toolkits)]);
    }
    const invalid = await app.inject({ method: "PATCH", url: `/api/roles/${role}/composio`, headers: auth(ownerToken), payload: { enabled: true, toolkits: ["../../secret"] } });
    expect(invalid.statusCode).toBe(422);
  });
  it("uses stable isolated session contexts and a vault worker without a key in config", () => {
    vi.stubEnv("COMPOSIO_API_KEY", "");
    const policy = { role, ownerId, enabled: true, toolkits: null };
    const a = composioCommand(policy, "work", "chat-a"), again = composioCommand(policy, "work", "chat-a");
    expect(a.env.TASKFLOW_COMPOSIO_CACHE_KEY).toBe(again.env.TASKFLOW_COMPOSIO_CACHE_KEY);
    expect(a.env.TASKFLOW_COMPOSIO_CACHE_KEY).not.toBe(composioCommand(policy, "plan", "chat-a").env.TASKFLOW_COMPOSIO_CACHE_KEY);
    expect(a.env.TASKFLOW_COMPOSIO_CACHE_KEY).not.toBe(composioCommand({ ...policy, role: "other" }, "work", "chat-a").env.TASKFLOW_COMPOSIO_CACHE_KEY);
    expect(a.args).toContain("API_COMPOSIO");
    expect(a.args[0]).toContain("composio_vault.py");
    saveComposioPolicy(policy);
    const file = prepareRoleRunAccess("composio-test", role, "plan", "chat-a")!;
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(config.mcpServers.composio.env.COMPOSIO_API_KEY).toBeUndefined();
    expect(config.mcpServers.composio.directTools).toBe(true);
    expect(config.mcpServers.taskflow.env.TASKFLOW_MCP_TOOLS).not.toContain("taskflow_create_task");
    releaseRoleRunAccess(file);
    saveComposioPolicy({ ...policy, enabled: false });
    const disabled = prepareRoleRunAccess("composio-disabled", role)!;
    expect(JSON.parse(fs.readFileSync(disabled, "utf8")).mcpServers.composio).toBeUndefined();
    releaseRoleRunAccess(disabled);
  });
  it("planning filters mutating operations, connections and sandbox", () => {
    const options = composioSessionOptions({ role, ownerId, enabled: true, toolkits: [] }, "plan");
    expect(options.toolkits).toEqual({ enable: [] });
    expect(options.tags).toEqual({ enable: ["readOnlyHint"], disable: ["destructiveHint"] });
    expect(ToolRouterCreateSessionConfigSchema.safeParse(options).success).toBe(true);
    expect(options.sandbox.enable).toBe(false);
    expect(options.manageConnections.enable).toBe(false);
  });
  it("catalog failures are returned explicitly rather than appearing connected", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-fixture-key");
    vi.mocked(inspectComposio).mockRejectedValueOnce(new Error("Composio недоступен"));
    const res = await app.inject({ method: "GET", url: `/api/roles/${role}/composio`, headers: auth(ownerToken) });
    expect(res.json()).toMatchObject({ available: false, catalog: [], error: "Composio недоступен" });
    expect(res.body).not.toContain("test-fixture-key");
  });
});

describe("Composio MCP bridge", () => {
  it("streams JSON before worker exit and redacts the injected credential", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composio-vault-"));
    const vault = path.join(dir, "vault.py");
    fs.writeFileSync(vault, 'def resolve(key): return "fixture-secret-value"\ndef variants(value): return [value]\ndef scrub(text, secrets):\n for value in secrets: text = text.replace(value, "***SECRET***")\n return text\n');
    const child = spawn("python3", [path.join(process.cwd(), "scripts/composio_vault.py"), vault, "test", process.execPath, "-e", 'process.stdin.on("data",()=>console.log(JSON.stringify({text:process.env.COMPOSIO_API_KEY})))']);
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      const response = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("stream stalled")), 3000);
        child.stdout.once("data", data => { clearTimeout(timer); resolve(data.toString()); });
        child.once("error", reject);
      });
      child.stdin.write("request\n");
      expect(JSON.parse(await response).text).toBe("***SECRET***");
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGTERM");
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("blocks workbench and account management even if marked read-only", async () => {
    const { planningToolAllowed } = await import("../scripts/composio_mcp.mjs");
    expect(planningToolAllowed({ name: "COMPOSIO_SEARCH_TOOLS" })).toBe(true);
    expect(planningToolAllowed({ name: "COMPOSIO_REMOTE_BASH_TOOL", annotations: { readOnlyHint: true } })).toBe(false);
    expect(planningToolAllowed({ name: "COMPOSIO_MANAGE_CONNECTIONS" })).toBe(false);
  });
  it("reuses a cached session; only missing/expired sessions are recreated", async () => {
    const { openComposioSession } = await import("../scripts/composio_mcp.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "composio-session-"));
    const file = path.join(dir, "cache.json");
    const api = { create: vi.fn(async () => ({ sessionId: "one" })), use: vi.fn(async () => ({ sessionId: "one" })) };
    try {
      await openComposioSession(api, {}, "owner", file);
      await openComposioSession(api, {}, "owner", file);
      expect(api.create).toHaveBeenCalledTimes(1);
      expect(api.use).toHaveBeenCalledWith("one", { mcp: true });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      api.use.mockRejectedValueOnce(Object.assign(new Error("network"), { status: 503 }));
      await expect(openComposioSession(api, {}, "owner", file)).rejects.toThrow("network");
      expect(api.create).toHaveBeenCalledTimes(1);
      api.use.mockRejectedValueOnce(Object.assign(new Error("expired"), { status: 404 }));
      await openComposioSession(api, {}, "owner", file);
      expect(api.create).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
