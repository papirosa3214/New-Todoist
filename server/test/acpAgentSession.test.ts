import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpAgentSession } from "../src/runtime/acpAgentSession.js";

const FAKE = path.resolve(__dirname, "fixtures/fake-acp-agent.mjs");
const sessions: Array<{ dispose(): void }> = [];

function start(extra: Record<string, unknown> = {}) {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acp-test-")), "log.jsonl");
  const events: any[] = [];
  return createAcpAgentSession({
    cwd: os.tmpdir(),
    command: process.execPath,
    args: [FAKE],
    systemPrompt: "ИНСТРУКЦИЯ",
    env: { FAKE_ACP_LOG: logFile },
    ...extra,
  }).then((session) => {
    sessions.push(session);
    session.subscribe((e) => events.push(e));
    const log = () =>
      fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [];
    return { session, events, log };
  });
}

afterEach(() => {
  while (sessions.length) sessions.pop()!.dispose();
});

describe("acpAgentSession: внешний агент по ACP с поверхностью сессии Pi", () => {
  it("ход: мысль и текст идут событиями Pi, ответ ложится в историю, инструкция — только в первом ходе", async () => {
    const { session, events, log } = await start();
    await session.prompt("привет");
    expect(events.some((e) => e.assistantMessageEvent?.type === "thinking_delta")).toBe(true);
    const text = events
      .filter((e) => e.assistantMessageEvent?.type === "text_delta")
      .map((e) => e.assistantMessageEvent.delta)
      .join("");
    expect(text).toBe("эхо: привет");
    const last = session.state.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "эхо: привет" }] });
    expect(session.sessionId).toBe("fake-1");

    await session.prompt("ещё");
    const prompts = log().filter((e) => e.kind === "prompt");
    expect(prompts[0].text).toContain("ИНСТРУКЦИЯ");
    expect(prompts[1].text).not.toContain("ИНСТРУКЦИЯ");
    // Один процесс и одна сессия на весь разговор.
    expect(log().filter((e) => e.kind === "new")).toHaveLength(1);
  });

  it("инструмент: разрешение выдаётся сразу (как bypassPermissions у Claude Code), события начала и конца", async () => {
    const { session, events, log } = await start();
    await session.prompt("вызови инструмент");
    expect(log().find((e) => e.kind === "permission")?.outcome).toEqual({ outcome: "selected", optionId: "yes" });
    expect(events.find((e) => e.type === "tool_execution_start")).toMatchObject({ toolCallId: "t1", args: { path: "/tmp/x" } });
    expect(events.find((e) => e.type === "tool_execution_end")).toMatchObject({ toolCallId: "t1", isError: false });
  });

  it("abort останавливает ход: в истории — прерванный ответ", async () => {
    const { session } = await start();
    const running = session.prompt("жди");
    await new Promise((r) => setTimeout(r, 300));
    await session.abort();
    await running;
    expect(session.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });

  it("steer во время хода: уточнение уходит следующим ходом той же сессии", async () => {
    const { session, log } = await start();
    const running = session.prompt("жди");
    await new Promise((r) => setTimeout(r, 300));
    await session.steer("уточнение");
    await session.abort();
    await running;
    await session.prompt("дальше");
    const texts = log().filter((e) => e.kind === "prompt").map((e) => e.text);
    expect(texts.some((t) => t.includes("уточнение"))).toBe(true);
  });

  it("передаёт агенту MCP-серверы при создании сессии", async () => {
    const mcpServers = [{ name: "taskflow", command: "node", args: ["x.js"], env: [] }];
    const { session, log } = await start({ mcpServers });
    await session.prompt("привет");
    expect(log().find((e) => e.kind === "new")?.mcpServers).toEqual(mcpServers);
  });
});
