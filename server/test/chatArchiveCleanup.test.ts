import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ active: true, checked: [] as string[], archived: [] as string[], cancelled: [] as string[] }));
vi.mock("../src/db.js", () => ({ default: {
  transaction: (fn: () => unknown) => fn,
  prepare: (sql: string) => ({
    all: () => [{ id: "chat-1", task_id: "task-1" }],
    get: (id: string) => { state.checked.push(id); return state.active && id === "task-1" ? { value: 1 } : undefined; },
    // Запросы чата и отмена его вопросов — разные утверждения: архив
    // помечаем только UPDATE по chats, а снятие вопросов считаем отдельно.
    run: (id: string) => {
      if (sql.includes("chat_questions")) state.cancelled.push(id);
      else state.archived.push(id);
    },
  }),
} }));
import { runCleanup } from "../src/lib/chatArchive.js";
beforeEach(() => { state.active = true; state.checked = []; state.archived = []; state.cancelled = []; });
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
  expect(state.cancelled).toEqual(["chat-1"]); // открытые вопросы убранного чата снимаются
});
