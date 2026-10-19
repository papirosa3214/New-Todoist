import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { StreamJsonTranslator, piToolName } from "../src/runtime/cliAgentSession.js";
import { startToolBridge } from "../src/runtime/cliToolBridge.js";

describe("StreamJsonTranslator", () => {
  it("переводит поток Claude Code в события Pi", () => {
    const events: any[] = [];
    const t = new StreamJsonTranslator((e) => events.push(e));
    t.line(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }));
    t.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "При" } } }));
    t.line(JSON.stringify({ type: "assistant", message: { content: [
      { type: "text", text: "При" },
      { type: "tool_use", id: "tu1", name: "mcp__taskflow__taskflow_task", input: { id: "x" } },
      { type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/a" } },
    ] } }));
    t.line(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true }] } }));
    t.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "готово" }));
    expect(t.sessionId).toBe("s-1");
    expect(t.result).toEqual({ isError: false, text: "готово" });
    // текст пришёл частично — целиком второй раз не дублируется
    expect(events.filter((e) => e.assistantMessageEvent?.type === "text_delta")).toHaveLength(1);
    expect(events.find((e) => e.toolCallId === "tu1" && e.type === "tool_execution_start").toolName).toBe("taskflow_task");
    expect(events.find((e) => e.toolCallId === "tu2").toolName).toBe("read");
    expect(events.find((e) => e.type === "tool_execution_end")).toMatchObject({ toolCallId: "tu1", isError: true });
    expect(events.some((e) => e.type === "message_end")).toBe(true);
  });

  it("ошибку результата помечает как ошибку", () => {
    const t = new StreamJsonTranslator(() => {});
    t.line(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "429 rate limit" }));
    expect(t.result).toEqual({ isError: true, text: "429 rate limit" });
  });

  it("имена инструментов", () => {
    expect(piToolName("Glob")).toBe("find");
    expect(piToolName("mcp__taskflow__taskflow_chat_send")).toBe("taskflow_chat_send");
    expect(piToolName("WebSearch")).toBe("WebSearch");
  });
});

describe("cliToolBridge", () => {
  it("stdio-MCP отдаёт список и вызывает инструмент в процессе сервера", async () => {
    const calls: any[] = [];
    const bridge = await startToolBridge([{
      name: "echo", description: "эхо",
      parameters: { type: "object", properties: { s: { type: "string" } } },
      execute: async (_id, args) => { calls.push(args); return { content: [{ type: "text", text: `эхо ${args.s}` }] }; },
    }]);
    try {
      const cfg = JSON.parse(fs.readFileSync(bridge.configPath, "utf8")).mcpServers.taskflow;
      const proc = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "inherit"] });
      const replies = new Map<number, any>();
      let buf = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (c: string) => {
        buf += c;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); if (m.id) replies.set(m.id, m); }
      });
      const send = (m: any) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
      const wait = async (id: number) => { for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 50)); return replies.get(id); };
      send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      await wait(1);
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/list" });
      expect((await wait(2)).result.tools.map((t: any) => t.name)).toEqual(["echo"]);
      send({ id: 3, method: "tools/call", params: { name: "echo", arguments: { s: "да" } } });
      expect((await wait(3)).result.content[0].text).toBe("эхо да");
      expect(calls).toEqual([{ s: "да" }]);
      proc.kill();
    } finally {
      await bridge.close();
    }
  });
});
