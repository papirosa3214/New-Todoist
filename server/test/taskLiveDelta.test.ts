// Живой ход шага карточки дельтами (владелец 27.10.2026): tasks:live:start →
// patch → end рядом со старым tasks:live; поля как у чата, turn_id = прогон.
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/ws.js", () => ({ broadcastToUsers: vi.fn() }));
import { LIVE_BROADCAST_MS } from "../src/runtime/chatLiveTurn.js";
import { beginTaskLiveTurn, taskLiveTurns } from "../src/runtime/taskLiveTurn.js";

const text = (delta: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });

describe("ход шага дельтами", () => {
  it("start, patch только с изменениями, end; старый снимок идёт как раньше", () => {
    vi.useFakeTimers();
    const deltas: any[] = [], olds: any[] = [];
    const run = beginTaskLiveTurn({ taskId: "t1", subtaskId: "s1", runId: "r1", userId: "role_builder", name: "Разработчик",
      publish: (s) => olds.push(JSON.parse(JSON.stringify(s))), publishDelta: (e) => deltas.push(JSON.parse(JSON.stringify(e))) });
    expect(deltas[0]).toMatchObject({ type: "tasks:live:start", chat_id: "t1", task_id: "t1", subtask_id: "s1", run_id: "r1", turn_id: "r1", user_id: "role_builder", name: "Разработчик", seq: 0 });
    run.onEvent(text("При")); vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    run.onEvent(text("вет")); vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    const patches = deltas.filter((d) => d.type === "tasks:live:patch");
    expect(patches.map((p) => p.seq)).toEqual([1, 2]);
    expect(patches[0].ops[0]).toMatchObject({ op: "item_add", item: { kind: "text", text: "При" } });
    expect(patches[1].ops).toEqual([{ op: "text_append", item_id: patches[0].ops[0].item.id, text: "вет" }]);
    expect(patches[1]).toMatchObject({ chat_id: "t1", task_id: "t1", subtask_id: "s1", turn_id: "r1" });
    run.onEvent({ type: "tool_execution_start", toolCallId: "x", toolName: "read", args: { path: "a" } });
    run.finish();
    const end = deltas.at(-1);
    expect(end).toMatchObject({ type: "tasks:live:end", turn_id: "r1", message_id: null });
    expect(end.seq).toBe(deltas.at(-2).seq + 1);
    const last = deltas.at(-2).ops.find((o: any) => o.op === "item_update");
    expect(last).toMatchObject({ item_id: "x", fields: { status: "error" } });
    expect(olds.at(-1).complete).toBe(true);
    expect(taskLiveTurns("t1")[0].turn).toMatchObject({ turn_id: "r1", seq: end.seq });
    vi.useRealTimers();
  });
  it("без publishDelta — как раньше, дельт нет", () => {
    const olds: any[] = [];
    const run = beginTaskLiveTurn({ taskId: "t2", runId: "r2", userId: "role_qa", name: "QA", publish: (s) => olds.push(s) });
    run.onEvent(text("А")); run.finish();
    expect(olds.at(-1).complete).toBe(true);
  });
});
