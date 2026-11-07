// stdio-MCP для внешнего агента: список и вызовы инструментов пересылает
// серверу TaskFlow через unix-сокет (src/runtime/cliToolBridge.ts).
// Сеть не слушает; живёт, пока жив запустивший его CLI.
import net from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const socketPath = process.env.TF_BRIDGE_SOCKET;
const token = process.env.TF_BRIDGE_TOKEN;
if (!socketPath || !token) {
  process.stderr.write("cli-tool-bridge: нет TF_BRIDGE_SOCKET/TF_BRIDGE_TOKEN\n");
  process.exit(2);
}

const socket = net.connect(socketPath);
socket.setEncoding("utf8");
const pending = new Map();
let seq = 0;
let buf = "";
socket.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const wait = pending.get(msg.id);
    if (wait) { pending.delete(msg.id); wait(msg); }
  }
});
socket.on("error", (error) => {
  process.stderr.write(`cli-tool-bridge: сокет: ${error.message}\n`);
  process.exit(1);
});
socket.on("close", () => process.exit(0));

function ask(body) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.write(JSON.stringify({ ...body, id, token }) + "\n");
  });
}

const server = new Server({ name: "taskflow", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const reply = await ask({ op: "list" });
  if (reply.error) throw new Error(reply.error);
  return { tools: reply.tools };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const reply = await ask({ op: "call", name: request.params.name, args: request.params.arguments ?? {} });
  if (reply.error) return { content: [{ type: "text", text: reply.error }], isError: true };
  return reply.result;
});
await server.connect(new StdioServerTransport());
