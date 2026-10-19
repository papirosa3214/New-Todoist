import { describe, expect, it } from "vitest";
import { StreamJsonTranslator, piToolName } from "../src/runtime/cliAgentSession.js";
import { actionTurnHandler, parseActions, stripActions } from "../src/runtime/externalAgentActions.js";
import { findBinary } from "../src/lib/externalAgents.js";

describe("StreamJsonTranslator", () => {
  it("переводит поток Claude Code в события Pi", () => {
    const events: any[] = [];
    const t = new StreamJsonTranslator((e) => events.push(e));
    t.line(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", model: "claude-sonnet-5" }));
    t.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "При" } } }));
    t.line(JSON.stringify({ type: "assistant", message: { content: [
      { type: "text", text: "При" },
      { type: "tool_use", id: "tu1", name: "mcp__kb__search_knowledge_base", input: { q: "x" } },
      { type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/a" } },
    ] } }));
    t.line(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true }] } }));
    t.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "готово" }));
    expect(t.sessionId).toBe("s-1");
    expect(t.model).toBe("claude-sonnet-5");
    expect(t.result).toEqual({ isError: false, text: "готово" });
    // текст пришёл частично — целиком второй раз не дублируется
    expect(events.filter((e) => e.assistantMessageEvent?.type === "text_delta")).toHaveLength(1);
    expect(events.find((e) => e.toolCallId === "tu1" && e.type === "tool_execution_start").toolName).toBe("mcp__kb__search_knowledge_base");
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
    // свои MCP агента остаются под своими именами
    expect(piToolName("mcp__kb__search_knowledge_base")).toBe("mcp__kb__search_knowledge_base");
    expect(piToolName("WebSearch")).toBe("WebSearch");
  });
});


describe("действия внешнего агента", () => {
  it("разбирает блок taskflow-actions и выполняет операции, итоги возвращает агенту", async () => {
    const calls: any[] = [];
    const tools = [{ name: "taskflow_subtask_done", execute: async (_id: string, a: any) => { calls.push(a); return { content: [{ type: "text", text: "сдано" }] }; } }];
    const handler = actionTurnHandler(tools, "run1");
    const answer = "Готово.\n```taskflow-actions\n[{\"operation\":\"taskflow_subtask_done\",\"arguments\":{\"subtask_id\":\"s1\",\"done\":true,\"result\":\"ок\"}},{\"operation\":\"taskflow_nope\"}]\n```";
    const feedback = await handler(answer);
    expect(calls).toEqual([{ subtask_id: "s1", done: true, result: "ок" }]);
    expect(feedback).toContain("taskflow_subtask_done: ок — сдано");
    expect(feedback).toContain("taskflow_nope: операции нет");
    expect(stripActions(answer)).toBe("Готово.");
    expect(await handler("просто ответ")).toBeNull();
  });

  it("битый блок — ошибка для агента, а не тишина", () => {
    expect(parseActions("```taskflow-actions\n{oops\n```").errors[0]).toContain("не JSON");
  });
});

describe("каталог внешних агентов", () => {
  it("находит бинарник в доп. папках при коротком PATH сервиса", () => {
    expect(findBinary("sh", { PATH: "" })).toMatch(/\/sh$/);
    expect(findBinary("no-such-agent-xyz", { PATH: "" })).toBeNull();
  });
});
