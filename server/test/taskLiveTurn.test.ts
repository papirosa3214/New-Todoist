import { describe, it, expect, vi } from "vitest";
vi.mock("../src/ws.js", () => ({ broadcastToUsers: vi.fn() }));
import { beginTaskLiveTurn, taskLiveTurns } from "../src/runtime/taskLiveTurn.js";
import { broadcastToUsers } from "../src/ws.js";
const text = (delta: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
const begin = (taskId: string, subtaskId: string, runId: string) => beginTaskLiveTurn({
  taskId, subtaskId, runId, userId: "role_builder", name: "Разработчик", publish: () => {},
});
describe("task live stream", () => {
  it("streams text and tool start/end using the chat parser", async () => {
    const publish = vi.fn();
    const run = beginTaskLiveTurn({ taskId: "stream", subtaskId: "s", runId: "r", userId: "role_builder", name: "Разработчик", publish });
    run.onEvent(text("Проверяю "));
    run.onEvent(text("архив."));
    run.onEvent({ type: "tool_execution_start", toolCallId: "read1", toolName: "read", args: { path: "/tmp/archive.ts" } });
    await new Promise(resolve => setTimeout(resolve, 170));
    expect(publish.mock.calls.at(-1)?.[0].turn.items).toEqual(expect.arrayContaining([
      { kind: "text", text: "Проверяю архив." },
      expect.objectContaining({ kind: "step", tool: "read", status: "running" }),
    ]));
    run.onEvent({ type: "tool_execution_end", toolCallId: "read1", toolName: "read", isError: false });
    run.finish();
    expect(taskLiveTurns("stream")[0]).toMatchObject({ complete: true, turn: { items: expect.arrayContaining([expect.objectContaining({ status: "done" })]) } });
    expect(broadcastToUsers).not.toHaveBeenCalled();
  });
  it("isolates parallel same-role slots and parent tasks", () => {
    const a = begin("parallel", "s1", "a"); const b = begin("parallel", "s2", "b"); const c = begin("other", "s1", "c");
    a.onEvent(text("Первый")); b.onEvent(text("Второй")); c.onEvent(text("Чужой"));
    a.finish(); b.finish(); c.finish();
    expect(taskLiveTurns("parallel").map(t => t.turn.items[0])).toEqual([{kind:"text",text:"Первый"},{kind:"text",text:"Второй"}]);
  });
  it("ignores late events and completion of a replaced run", () => {
    const old = begin("replacement", "slot", "old");
    const fresh = begin("replacement", "slot", "fresh");
    fresh.onEvent(text("Новый"));
    old.onEvent(text("Старый")); old.finish();
    expect(taskLiveTurns("replacement")[0].run_id).toBe("fresh");
    expect(taskLiveTurns("replacement")[0].complete).toBe(false);
    fresh.finish();
    expect(taskLiveTurns("replacement")[0].turn.items).toEqual([{kind:"text",text:"Новый"}]);
  });
});
