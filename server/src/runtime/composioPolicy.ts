import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import db from "../db.js";

export type ComposioPolicy = {
  role: string; ownerId: string; enabled: boolean; toolkits: string[] | null;
};

export function roleComposioPolicy(role: string, ownerId?: string): ComposioPolicy {
  const row = db.prepare("SELECT owner_id, enabled, toolkits FROM role_composio WHERE role = ?").get(role) as
    { owner_id: string; enabled: number; toolkits: string | null } | undefined;
  const owner = ownerId ?? row?.owner_id ?? (db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY rowid LIMIT 1").get() as { id: string } | undefined)?.id ?? "";
  return { role, ownerId: owner, enabled: !!row?.enabled, toolkits: row?.toolkits == null ? null : JSON.parse(row.toolkits) };
}

export function saveComposioPolicy(policy: ComposioPolicy): void {
  db.prepare(`INSERT INTO role_composio(role, owner_id, enabled, toolkits) VALUES (?, ?, ?, ?)
    ON CONFLICT(role) DO UPDATE SET owner_id=excluded.owner_id, enabled=excluded.enabled, toolkits=excluded.toolkits`).run(
    policy.role, policy.ownerId, policy.enabled ? 1 : 0, policy.toolkits === null ? null : JSON.stringify(policy.toolkits),
  );
}

/** One policy feeds both MCP transports. Null = catalog; [] = no toolkits. */
export function composioSessionOptions(policy: ComposioPolicy, mode: string) {
  return {
    mcp: true,
    ...(policy.toolkits === null ? {} : { toolkits: { enable: policy.toolkits } }),
    ...(mode === "plan" ? { tags: { enable: ["readOnlyHint"], disable: ["destructiveHint"] } } : {}),
    manageConnections: { enable: false }, // Account authorization belongs to the owner UI.
    sandbox: { enable: mode !== "plan" },
  };
}

export function composioCommand(policy: ComposioPolicy, mode: string, context: string) {
  const script = path.join(process.cwd(), "scripts", "composio_mcp.mjs");
  const vault = process.env.TASKFLOW_COMPOSIO_VAULT_RUN ?? path.join(os.homedir(), ".claude", "vault-run.py");
  const env = {
    TASKFLOW_COMPOSIO_USER_ID: "taskflow:" + policy.ownerId,
    TASKFLOW_COMPOSIO_OPTIONS: JSON.stringify(composioSessionOptions(policy, mode)),
    TASKFLOW_COMPOSIO_MODE: mode,
    TASKFLOW_COMPOSIO_CACHE_KEY: crypto.createHash("sha256").update(JSON.stringify({ policy, mode, context })).digest("hex"),
    NODE_USE_ENV_PROXY: "1",
  };
  if (process.env.COMPOSIO_API_KEY) return { command: process.execPath, args: [script], env };
  return {
    command: "python3",
    args: [path.join(process.cwd(), "scripts", "composio_vault.py"), vault, process.env.TASKFLOW_COMPOSIO_VAULT_KEY ?? "API_COMPOSIO", process.execPath, script],
    env,
  };
}

export function composioCredentialConfigured(): boolean {
  return !!process.env.COMPOSIO_API_KEY || fs.existsSync(process.env.TASKFLOW_COMPOSIO_VAULT_RUN ?? path.join(os.homedir(), ".claude", "vault-run.py"));
}
