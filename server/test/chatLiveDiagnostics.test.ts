// Замер сорванного хода (владелец 27.10.2026, «Request timed out»): сколько
// шёл ход, сколько молчала модель, размер последнего запроса, обращений.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ws.js", () => ({ broadcastToUsers: vi.fn() }));
import { _resetLiveTurnsForTests, startLiveTurn } from "../src/runtime/chatLiveTurn.js";

beforeEach(() => { _resetLiveTurnsForTests(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-27T10:00:00Z")); });
afterEach(() => vi.useRealTimers());

describe("замер хода", () => {
  it("длительность, тишина модели, размер последнего запроса и число обращений", () => {
    const live = startLiveTurn({ chatId: "c1", userId: "role_qa", name: "QA", audience: () => [] });
    vi.advanceTimersByTime(5_000);
    live.onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1000, output: 10, cacheRead: 120000, cacheWrite: 0 } } });
    vi.advanceTimersByTime(600_000);
    expect(live.diagnostics()).toEqual({ elapsed_ms: 605_000, silent_ms: 600_000, last_context: 121_000, calls: 1 });
  });
  it("до первого события молчание считается от начала хода", () => {
    const live = startLiveTurn({ chatId: "c2", userId: "role_qa", name: "QA", audience: () => [] });
    vi.advanceTimersByTime(42_000);
    expect(live.diagnostics()).toEqual({ elapsed_ms: 42_000, silent_ms: 42_000, last_context: null, calls: 0 });
  });
});
