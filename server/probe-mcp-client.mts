import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const env = {
  ...process.env,
  TASKFLOW_COMPOSIO_USER_ID: "taskflow:probe",
  TASKFLOW_COMPOSIO_OPTIONS: JSON.stringify({ mcp: true, manageConnections: { enable: false }, sandbox: { enable: true } }),
  TASKFLOW_COMPOSIO_MODE: "work",
  TASKFLOW_COMPOSIO_CACHE_KEY: "probe",
  NODE_USE_ENV_PROXY: "0",
} as Record<string, string>;
const t0 = Date.now();
const client = new Client({ name: "probe", version: "1.0.0" });
const transport = new StdioClientTransport({ command: "python3", args: ["scripts/composio_vault.py", "/home/maksim/.claude/vault-run.py", "API_COMPOSIO", process.execPath, "scripts/composio_mcp.mjs"], env, stderr: "inherit" });
try {
  await Promise.race([client.connect(transport), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 90000))]);
  const listed = await client.listTools();
  console.log(JSON.stringify({ n: listed.tools.length, names: listed.tools.slice(0, 10).map(t => t.name), ms: Date.now() - t0 }));
} catch (e: any) { console.log("ERR", e.message, "NODE_OPTIONS=" + process.env.NODE_OPTIONS, Date.now() - t0); }
process.exit(0);
