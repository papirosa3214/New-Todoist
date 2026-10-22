import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ active: true, checked: [] as string[], archived: [] as string[] }));
vi.mock("../src/db.js", () => ({ default: {
  transaction: (fn: () => unknown) => fn,
  prepare: (_sql: string) => ({
    all: () => [{ id: "chat-1", task_id: "task-1" }],
    get: (id: string) => { state.checked.push(id); return state.active && id === "task-1" ? { value: 1 } : undefined; },
    run: (id: string) => { state.archived.push(id); },
  }),
} }));
import { runCleanup } from "../src/lib/chatArchive.js";
beforeEach(() => { state.active = true; state.checked = []; state.archived = []; });
it("rechecks the task that became active after candidate selection", () => {
  expect(runCleanup()).toEqual([]);
  expect(state.checked).toEqual(["task-1"]);
  expect(state.archived).toEqual([]);
});
it("archives an idle topic by chat id after checking its task id", () => {
  state.active = false;
  expect(runCleanup()).toEqual(["chat-1"]);
  expect(state.checked).toEqual(["task-1", "task-1"]);
  expect(state.archived).toEqual(["chat-1"]);
});
