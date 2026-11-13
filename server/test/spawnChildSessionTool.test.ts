import { describe, expect, it, vi } from "vitest";
import {
  CHILD_SESSION_TOOLS,
  createSpawnChildSessionTool,
  type ChildSessionAgent,
  type ChildSessionSpawnRequest,
} from "../src/runtime/spawnChildSessionTool.js";

class FakeChild implements ChildSessionAgent {
  listeners = new Set<(event: any) => void>();
  promptCalls: string[] = [];
  abortCalls = 0;
  waitCalls = 0;
  disposeCalls = 0;
  failWith?: Error;
  duplicateSettled = false;

  subscribe(listener: (event: any) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string) {
    this.promptCalls.push(text);
    this.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "wor" }] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wor", partial: {} },
    });
    if (this.failWith) throw this.failWith;
    this.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "work complete" }] },
    });
    this.emit({ type: "agent_settled", aborted: false });
    if (this.duplicateSettled) this.emit({ type: "agent_settled", aborted: false });
  }

  async abort() { this.abortCalls += 1; }
  async waitForIdle() { this.waitCalls += 1; }
  dispose() { this.disposeCalls += 1; }
  emit(event: any) { for (const listener of this.listeners) listener(event); }
}

function harness(options: { failWith?: Error; duplicateSettled?: boolean } = {}) {
  const child = new FakeChild();
  child.failWith = options.failWith;
  child.duplicateSettled = options.duplicateSettled ?? false;
  const requests: ChildSessionSpawnRequest[] = [];
  const spawn = vi.fn(async (request: ChildSessionSpawnRequest) => {
    requests.push(request);
    return {
      id: "child-session",
      parentSession: "/sessions/parent.jsonl",
      session: child,
    };
  });
  const tool = createSpawnChildSessionTool({
    parentSessionId: "parent-session",
    parentSessionFile: "/sessions/parent.jsonl",
    spawn,
  });
  return { child, requests, spawn, tool };
}

function execute(
  tool: ReturnType<typeof createSpawnChildSessionTool>,
  params: { task: string; cwd?: string; expectedOutput?: string },
  signal?: AbortSignal,
  onUpdate?: (update: any) => void,
) {
  return tool.execute("tool-call-1", params, signal, onUpdate, {} as any);
}

describe("taskflow_spawn_session", () => {
  it("creates an independent persistent child linked to the parent", async () => {
    const h = harness();

    const result = await execute(h.tool, { task: "inspect the repository", cwd: "/project" });

    expect(h.requests).toEqual([{
      parentSessionId: "parent-session",
      parentSessionFile: "/sessions/parent.jsonl",
      task: "inspect the repository",
      cwd: "/project",
      expectedOutput: undefined,
      tools: CHILD_SESSION_TOOLS,
    }]);
    expect(result.details).toMatchObject({
      status: "completed",
      sessionId: "child-session",
      parentSession: "/sessions/parent.jsonl",
      output: "work complete",
    });
    expect(result.details.sessionId).not.toBe("parent-session");
  });

  it("uses a restricted child loadout", async () => {
    const h = harness();

    await execute(h.tool, { task: "read only" });

    expect(h.requests[0].tools).toEqual(["read", "grep", "find", "ls"]);
    expect(h.requests[0].tools).not.toContain("bash");
    expect(h.requests[0].tools).not.toContain("write");
    expect(h.requests[0].tools).not.toContain("edit");
  });

  it("streams child progress through tool updates", async () => {
    const h = harness();
    const updates: any[] = [];

    await execute(h.tool, { task: "stream" }, undefined, update => updates.push(update));

    expect(updates).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ sessionId: "child-session", eventType: "message_update" }) }),
      expect.objectContaining({ details: expect.objectContaining({ sessionId: "child-session", eventType: "message_end" }) }),
      expect.objectContaining({ details: expect.objectContaining({ sessionId: "child-session", eventType: "agent_settled" }) }),
    ]);
  });

  it("returns settled completion exactly once", async () => {
    const h = harness({ duplicateSettled: true });
    const updates: any[] = [];

    const result = await execute(h.tool, { task: "settle once" }, undefined, update => updates.push(update));

    expect(result.details.status).toBe("completed");
    expect(updates.filter(update => update.details.eventType === "agent_settled")).toHaveLength(1);
    expect(h.child.waitCalls).toBe(1);
  });

  it("returns child failure visibly instead of corrupting the parent turn", async () => {
    const h = harness({ failWith: new Error("provider offline") });

    const result = await execute(h.tool, { task: "fail" });

    expect(result.content).toEqual([{ type: "text", text: "Child session failed: provider offline" }]);
    expect(result.details).toMatchObject({
      status: "failed",
      sessionId: "child-session",
      error: "provider offline",
    });
    expect(h.child.waitCalls).toBe(1);
  });

  it("aborts the child when the parent tool call is cancelled", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();

    const result = await execute(h.tool, { task: "cancel" }, controller.signal);

    expect(h.child.abortCalls).toBe(1);
    expect(h.child.waitCalls).toBe(1);
    expect(result.details).toMatchObject({ status: "aborted", sessionId: "child-session" });
  });

  it("leaves the parent session usable after the child completes", async () => {
    const h = harness();
    const parent = { prompt: vi.fn(async () => undefined), dispose: vi.fn() };

    await execute(h.tool, { task: "child work", expectedOutput: "short report" });
    await parent.prompt("next owner message");

    expect(parent.prompt).toHaveBeenCalledWith("next owner message");
    expect(parent.dispose).not.toHaveBeenCalled();
    expect(h.child.promptCalls[0]).toContain("short report");
  });
});

describe("субагент сессии — роль (владелец 13.11.2026)", () => {
  function roleTool() {
    const child = new FakeChild();
    const requests: ChildSessionSpawnRequest[] = [];
    const tool = createSpawnChildSessionTool({
      parentSessionId: "parent-session",
      parentSessionFile: "/sessions/parent.jsonl",
      roles: { researcher: "Исследователь", designer: "Дизайнер" },
      spawn: async (request) => {
        requests.push(request);
        return { id: "child-session", parentSession: "/sessions/parent.jsonl", session: child };
      },
    });
    return { tool, requests };
  }

  it("передаёт роль в запуск дочерней сессии и возвращает её ответ", async () => {
    const { tool, requests } = roleTool();
    const result: any = await tool.execute("call", { role: "researcher", task: "найди библиотеки" } as any, undefined, undefined, undefined as any);
    expect(requests[0].role).toBe("researcher");
    expect(result.content[0].text).toBe("work complete");
    expect(result.details.role).toBe("researcher");
  });

  it("неизвестную роль отклоняет до запуска", async () => {
    const { tool, requests } = roleTool();
    await expect(tool.execute("call", { role: "nobody", task: "x" } as any, undefined, undefined, undefined as any))
      .rejects.toThrow(/НЕИЗВЕСТНАЯ РОЛЬ/);
    expect(requests).toHaveLength(0);
  });

  it("в описании перечислены роли", () => {
    const { tool } = roleTool();
    expect(tool.description).toContain("researcher — Исследователь");
  });
});
