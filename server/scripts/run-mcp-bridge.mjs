#!/usr/bin/env node
// MCP-мост запуска внешнего агента (stdio, JSON-RPC построчно).
// Агент (Claude Code, Gemini CLI, Hermes, OpenCode) видит его как MCP-сервер
// `taskflow_run`: инструменты — ровно операции TaskFlow, разрешённые этому
// запуску; вызовы уходят на сервер /api/runs/:runId/tools от имени участника.
// Окружение: TASKFLOW_API, TASKFLOW_RUN_ID, TASKFLOW_TOKEN.
import readline from "node:readline";

const API = (process.env.TASKFLOW_API || "http://127.0.0.1:3001").replace(/\/$/, "");
const RUN = process.env.TASKFLOW_RUN_ID || "";
const TOKEN = process.env.TASKFLOW_TOKEN || "";
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const log = (text) => process.stderr.write(`[taskflow_run] ${text}\n`);

async function api(method, path, body) {
  const res = await fetch(`${API}/api/runs/${encodeURIComponent(RUN)}/tools${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `сервер ответил ${res.status}`);
  return data;
}

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "taskflow_run", version: "1.0.0" },
        instructions: "Действия на доске TaskFlow (шаги, темы, чат, план) — инструментами этого сервера, от имени участника.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: (await api("GET", "")).tools };
    case "tools/call":
      return api("POST", `/${encodeURIComponent(msg.params?.name ?? "")}`, { arguments: msg.params?.arguments ?? {} });
    default:
      throw Object.assign(new Error(`метод ${msg.method} не поддерживается`), { code: -32601 });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "не JSON" } });
  }
  // Уведомления (без id) ответа не требуют.
  if (msg.id === undefined || msg.id === null) return;
  try {
    send({ id: msg.id, result: await handle(msg) });
  } catch (error) {
    log(error?.message ?? String(error));
    send({ id: msg.id, error: { code: error?.code ?? -32000, message: error?.message ?? String(error) } });
  }
});
rl.on("close", () => process.exit(0));
