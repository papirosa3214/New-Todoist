#!/usr/bin/env node
// Поддельный ACP-агент для тестов acpAgentSession: официальный SDK, stdio.
// Поведение задаётся текстом подсказки:
//   «инструмент» — вызывает инструмент через запрос разрешения;
//   «жди» — висит до session/cancel;
//   иначе — мысль, затем ответ «эхо: <текст>».
// Каждый полученный prompt записывается в файл FAKE_ACP_LOG (по строке JSON).
import fs from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const log = (entry) => {
  if (process.env.FAKE_ACP_LOG) fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(entry) + "\n");
};
const cancels = new Map();
let counter = 0;

const app = agent({ name: "fake-acp" })
  .onRequest(methods.agent.initialize, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "fake-acp", version: "1.0.0" },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, async ({ params }) => {
    counter += 1;
    log({ kind: "new", cwd: params.cwd, mcpServers: params.mcpServers });
    return {
      sessionId: `fake-${counter}`,
      configOptions: [
        { id: "mode", name: "Режим", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Сборка" }] },
        { id: "model", name: "Модель", category: "model", type: "select", currentValue: "fake/a", options: [{ value: "fake/a", name: "Модель А" }, { value: "fake/b", name: "Модель Б" }] },
      ],
    };
  })
  .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    log({ kind: "set_config", configId: params.configId, value: params.value });
    return { configOptions: [] };
  })
  .onNotification(methods.agent.session.cancel, async ({ params }) => {
    cancels.get(params.sessionId)?.();
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    log({ kind: "prompt", sessionId: params.sessionId, text });
    const update = (u) => client.notify(methods.client.session.update, { sessionId: params.sessionId, update: u });
    if (text.includes("жди")) {
      await new Promise((resolve) => cancels.set(params.sessionId, resolve));
      return { stopReason: "cancelled" };
    }
    if (text.includes("инструмент")) {
      await update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Прочитать файл", kind: "read", status: "pending", rawInput: { path: "/tmp/x" } });
      const answer = await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "t1", title: "Прочитать файл", kind: "read" },
        options: [
          { optionId: "deny", name: "Запретить", kind: "reject_once" },
          { optionId: "yes", name: "Разрешить", kind: "allow_once" },
        ],
      });
      log({ kind: "permission", outcome: answer.outcome });
      await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
      await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "прочитал" } });
      return { stopReason: "end_turn" };
    }
    await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "думаю" } });
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "эхо: " } });
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: text.split("\n").pop() } });
    await update({ sessionUpdate: "usage_update", size: 1000, used: 120 });
    return { stopReason: "end_turn" };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
