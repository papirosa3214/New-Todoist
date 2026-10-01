import { Composio } from "@composio/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
let phase = "configuration";

// This process alone receives the vault credential. MCP replies never include it.
export function planningToolAllowed(tool) {
  return ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_GET_TOOL_SCHEMAS"].includes(tool.name);
}

export async function openComposioSession(composio, options, userId, cacheFile) {
  let session;
  if (cacheFile) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      session = await composio.use(cached.sessionId, { mcp: true });
    } catch (error) {
      if (error.code !== "ENOENT" && error.status !== 404 && error.statusCode !== 404) throw error;
    }
  }
  if (!session) {
    session = await composio.create(userId, options);
    if (cacheFile) {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
      const temporary = cacheFile + "." + process.pid;
      await fs.writeFile(temporary, JSON.stringify({ sessionId: session.sessionId }), { mode: 0o600 });
      await fs.rename(temporary, cacheFile);
    }
  }
  return session;
}

export async function readLinearComposio(composio, userId, input) {
    if (!/^\s*query\s/.test(input.query) || /\b(mutation|subscription)\b/.test(input.query)) throw new Error("read_only_query_required");
    const accounts = await composio.connectedAccounts.list({ userIds: [userId], toolkitSlugs: ["linear"], statuses: ["ACTIVE"], limit: 2 });
    if (accounts.items.length !== 1) {
      return { error: accounts.items.length ? "multiple_accounts" : "not_connected" };
    }
    const result = await composio.tools.execute("LINEAR_RUN_QUERY_OR_MUTATION", {
      userId, connectedAccountId: accounts.items[0].id, version: "20260924_00",
      arguments: { query_or_mutation: input.query, variables: input.variables ?? {} },
    });
    // Never forward SDK error details, credentials, headers or account metadata.
    if (!result.successful || result.error || result.data?.errors?.length || !result.data?.data) {
      return { error: "query_failed" };
    } else { return { data: result.data.data }; }
}

export async function main() {
  const options = JSON.parse(process.env.TASKFLOW_COMPOSIO_OPTIONS ?? "{}");
  const userId = process.env.TASKFLOW_COMPOSIO_USER_ID;
  if (!userId || !process.env.COMPOSIO_API_KEY) throw new Error("credential_missing");
  const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY, logLevel: "silent", allowTracking: false });
  phase = "session";
  if (process.argv.includes("--catalog")) {
    const session = await composio.create(userId, { ...options, toolkits: undefined });
    try {
      const result = await session.toolkits({ limit: 50, search: process.env.TASKFLOW_COMPOSIO_SEARCH || undefined });
      process.stdout.write(JSON.stringify({ items: result.items.map(t => ({ slug: t.slug, name: t.name, connected: !!t.connection?.isActive, noAuth: t.isNoAuth })), cursor: result.cursor ?? null }));
    } finally { await session.delete(); }
    return;
  }
  if (process.argv.includes("--authorize")) {
    // Keep the session alive while the owner completes the redirect flow.
    const session = await composio.create(userId, { ...options, toolkits: undefined });
    const connection = await session.authorize(process.env.TASKFLOW_COMPOSIO_TOOLKIT);
    process.stdout.write(JSON.stringify({ url: connection.redirectUrl }));
    return;
  }
  if (process.argv.includes("--linear-read")) {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 100_000) throw new Error("input_too_large");
    }
    const input = JSON.parse(raw);
    process.stdout.write(JSON.stringify(await readLinearComposio(composio, userId, input)));
    return;
  }
  const hash = process.env.TASKFLOW_COMPOSIO_CACHE_KEY;
  if (!/^[a-f0-9]{64}$/.test(hash ?? "")) throw new Error("invalid_context");
  const cacheFile = path.join(process.env.TASKFLOW_COMPOSIO_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "taskflow", "composio"), hash + ".json");
  const session = await openComposioSession(composio, options, userId, cacheFile);
  phase = "mcp_connection";
  const endpoint = new URL(session.mcp.url);
  const guardedFetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== endpoint.origin) throw new Error("MCP destination changed");
    return fetch(input, { ...init, redirect: "error" });
  };
  const remote = new Client({ name: "taskflow-composio", version: "1.0.0" });
  await remote.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: session.mcp.headers }, fetch: guardedFetch }));
  phase = "tool_catalog";
  const listed = await remote.listTools();
  const tools = process.env.TASKFLOW_COMPOSIO_MODE === "plan" ? listed.tools.filter(planningToolAllowed) : listed.tools;
  const server = new Server({ name: "taskflow-composio", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!tools.some(t => t.name === request.params.name)) throw new Error("Tool not allowed in this mode");
    return remote.callTool(request.params, undefined, { signal: extra.signal, timeout: 120_000 });
  });
  server.onclose = () => { void remote.close(); };
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never echo SDK request config, headers, or raw exception text.
    const status = error.status ?? error.statusCode ?? error.cause?.status;
    process.stderr.write(`Composio unavailable (${phase})` + (Number.isInteger(status) ? ` (HTTP ${status})` : "") + "\n");
    process.exitCode = 1;
  });
}
