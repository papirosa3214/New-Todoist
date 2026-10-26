#!/usr/bin/env node
// Проба внешнего агента по ACP: рукопожатие, новая сессия, один короткий ход.
// Запуск: node scripts/acp-probe.mjs <команда> [аргументы…]
//   node scripts/acp-probe.mjs gemini --acp
//   node scripts/acp-probe.mjs opencode acp
// Печатает версию протокола, имя агента, события хода и причину остановки.
// Код выхода 0 — агент ответил и закончил ход штатно.
import { spawn } from "node:child_process";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("укажи команду агента, например: gemini --acp");
  process.exit(2);
}
const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd: os.homedir() });
let stderr = "";
proc.stderr.on("data", (c) => (stderr = (stderr + c).slice(-1500)));

const kinds = {};
let text = "";
const app = client({ name: "taskflow-probe" })
  .onNotification(methods.client.session.update, async ({ params: n }) => {
    const kind = n.update.sessionUpdate;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (kind === "agent_message_chunk" && n.update.content?.type === "text") text += n.update.content.text;
  })
  .onRequest(methods.client.session.requestPermission, async () => ({ outcome: { outcome: "cancelled" } }));

const timer = setTimeout(() => {
  console.error("тайм-аут 120 с");
  console.error(stderr);
  proc.kill("SIGTERM");
  process.exit(1);
}, 120_000);

try {
  const conn = app.connect(ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout)));
  const init = await conn.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  console.log("протокол:", init.protocolVersion, "агент:", init.agentInfo?.name ?? "—", init.agentInfo?.version ?? "");
  console.log("умеет loadSession:", Boolean(init.agentCapabilities?.loadSession), "mcp http:", Boolean(init.agentCapabilities?.mcpCapabilities?.http));
  console.log("способы входа:", (init.authMethods ?? []).map((m) => m.id).join(", ") || "—");
  const session = await conn.agent.request(methods.agent.session.new, { cwd: os.homedir(), mcpServers: [] });
  console.log("сессия:", session.sessionId);
  const result = await conn.agent.request(methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Ответь одним словом: готов" }],
  });
  console.log("события:", JSON.stringify(kinds));
  console.log("ответ:", text.trim().slice(0, 200));
  console.log("остановка:", result.stopReason);
  clearTimeout(timer);
  conn.close();
  proc.kill("SIGTERM");
  process.exit(result.stopReason === "end_turn" && text.trim() ? 0 : 1);
} catch (error) {
  clearTimeout(timer);
  console.error("ошибка:", error?.message ?? error);
  if (stderr.trim()) console.error("stderr:", stderr.trim().split("\n").slice(-8).join("\n"));
  proc.kill("SIGTERM");
  process.exit(1);
}
