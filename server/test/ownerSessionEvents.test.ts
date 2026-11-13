import { describe, expect, it } from "vitest";
import {
  OwnerSessionEventBuffer,
  normalizePiEvent,
} from "../src/runtime/ownerSessionEvents.js";

const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "test",
  provider: "test",
  model: "test",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 1,
});

describe("normalizePiEvent", () => {
  it("keeps text deltas transient and message_end authoritative", () => {
    const partial = assistant("Hel");
    const delta = normalizePiEvent("session-1", {
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial },
    } as any, { cursor: "1", timestamp: "2026-11-06T00:00:00.000Z" });
    const completed = normalizePiEvent("session-1", {
      type: "message_end",
      message: assistant("Hello"),
    } as any, { cursor: "2", timestamp: "2026-11-06T00:00:01.000Z" });

    expect(delta).toMatchObject({
      cursor: "1", sessionId: "session-1", type: "assistant_text_delta",
      payload: { delta: "Hel", contentIndex: 0 },
    });
    expect(completed).toMatchObject({
      cursor: "2", type: "message_end",
      payload: { message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
    });
  });

  it("normalizes the complete tool lifecycle", () => {
    const start = normalizePiEvent("s", {
      type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a" },
    } as any, { cursor: "1", timestamp: "t" });
    const update = normalizePiEvent("s", {
      type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: { path: "a" }, partialResult: { bytes: 2 },
    } as any, { cursor: "2", timestamp: "t" });
    const end = normalizePiEvent("s", {
      type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { ok: true }, isError: false, durationMs: 4,
    } as any, { cursor: "3", timestamp: "t" });

    expect(start).toMatchObject({ type: "tool_start", payload: { toolCallId: "call-1", toolName: "read", args: { path: "a" } } });
    expect(update).toMatchObject({ type: "tool_update", payload: { toolCallId: "call-1", partialResult: { bytes: 2 } } });
    expect(end).toMatchObject({ type: "tool_end", payload: { toolCallId: "call-1", result: { ok: true }, isError: false, durationMs: 4 } });
  });

  it.each([
    [
      { type: "queue_update", steering: ["now"], followUp: ["later"] },
      "queue_update",
      { steering: ["now"], followUp: ["later"] },
    ],
    [
      { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 50, errorMessage: "network" },
      "retry_start",
      { attempt: 2, maxAttempts: 3, delayMs: 50, errorMessage: "network" },
    ],
    [
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "offline" },
      "retry_end",
      { success: false, attempt: 3, finalError: "offline" },
    ],
    [
      { type: "compaction_start", reason: "threshold" },
      "compaction_start",
      { reason: "threshold" },
    ],
    [
      { type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false },
      "compaction_end",
      { reason: "threshold", aborted: false, willRetry: false },
    ],
    [
      { type: "agent_settled", aborted: true },
      "agent_settled",
      { aborted: true },
    ],
  ])("normalizes %s", (event, type, payload) => {
    expect(normalizePiEvent("s", event as any, { cursor: "7", timestamp: "t" }))
      .toMatchObject({ type, payload });
  });

  it("exposes appended entry IDs without using them as transport cursors", () => {
    const event = normalizePiEvent("s", {
      type: "entry_appended",
      entry: { type: "message", id: "entry-1", parentId: null, timestamp: "t", message: { role: "user", content: "hi", timestamp: 1 } },
    } as any, { cursor: "42", timestamp: "t" });

    expect(event).toMatchObject({ cursor: "42", entryId: "entry-1", type: "entry_appended" });
  });

  it("preserves unknown future Pi events as JSON-safe diagnostics", () => {
    const event = normalizePiEvent("s", {
      type: "future_event", value: 3, secret: undefined, callback: () => "hidden",
    } as any, { cursor: "9", timestamp: "t" });

    expect(event).toEqual({
      cursor: "9",
      sessionId: "s",
      type: "pi_unknown",
      timestamp: "t",
      payload: { piType: "future_event", event: { type: "future_event", value: 3 } },
    });
  });
});

describe("OwnerSessionEventBuffer", () => {
  it("assigns distinct cursors even when Pi repeats its own ID", () => {
    const buffer = new OwnerSessionEventBuffer({ capacity: 5, clock: () => new Date(0) });
    const event = {
      type: "tool_execution_update", toolCallId: "same", toolName: "read", args: {}, partialResult: {},
    } as any;

    const first = buffer.push("s", event);
    const second = buffer.push("s", event);

    expect(first.cursor).not.toBe(second.cursor);
    expect(first.payload.toolCallId).toBe("same");
    expect(second.payload.toolCallId).toBe("same");
  });

  it("returns only newer events for a known cursor", () => {
    const buffer = new OwnerSessionEventBuffer({ capacity: 5, clock: () => new Date(0) });
    const first = buffer.push("s", { type: "agent_start" } as any);
    const second = buffer.push("s", { type: "agent_settled", aborted: false } as any);

    expect(buffer.eventsAfter(first.cursor, "s")).toEqual({ resetRequired: false, events: [second] });
  });

  it("requests a snapshot reset when the cursor fell outside bounded retention", () => {
    const buffer = new OwnerSessionEventBuffer({ capacity: 2, clock: () => new Date(0) });
    const expired = buffer.push("s", { type: "agent_start" } as any);
    const retainedOne = buffer.push("s", { type: "turn_start" } as any);
    const retainedTwo = buffer.push("s", { type: "agent_settled", aborted: false } as any);

    expect(buffer.eventsAfter(expired.cursor, "s")).toEqual({
      resetRequired: true,
      events: [retainedOne, retainedTwo],
    });
  });

  it("does not leak another session's retained events", () => {
    const buffer = new OwnerSessionEventBuffer({ capacity: 5, clock: () => new Date(0) });
    const cursor = buffer.push("one", { type: "agent_start" } as any).cursor;
    const two = buffer.push("two", { type: "agent_settled", aborted: false } as any);

    expect(buffer.eventsAfter(cursor, "one")).toEqual({ resetRequired: false, events: [] });
    expect(buffer.eventsAfter(undefined, "two")).toEqual({ resetRequired: false, events: [two] });
  });
});

describe("тонкий клиент: блоки в событиях текста (владелец 13.11.2026)", () => {
  it("к куску текста кладёт весь текст части и готовые блоки", async () => {
    const { normalizePiEvent } = await import("../src/runtime/ownerSessionEvents.js");
    const out: any = normalizePiEvent("s1", {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "## Итог\n\n- пункт" }] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "пункт" },
    } as any, { cursor: "c1", sequence: 1, epoch: "e" } as any);
    expect(out.payload.text).toBe("## Итог\n\n- пункт");
    expect(Array.isArray(out.payload.blocks)).toBe(true);
    expect(out.payload.blocks.length).toBeGreaterThan(0);
  });
});

describe("разметка живого хода — по абзацам и не чаще 300 мс (владелец 13.11.2026)", () => {
  const update = (text: string, delta: string) => ({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text }] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
  }) as any;
  const meta = { cursor: "c", sequence: 1, epoch: "e" } as any;

  it("второй кусок без конца абзаца — без блоков, конец абзаца — с блоками, хвост — в message_end", async () => {
    const { normalizePiEvent } = await import("../src/runtime/ownerSessionEvents.js");
    const first: any = normalizePiEvent("thr", update("Раз", "Раз"), meta);
    const second: any = normalizePiEvent("thr", update("Раз два", " два"), meta);
    const paragraph: any = normalizePiEvent("thr", update("Раз два\n\nТри", "\n\nТри"), meta);
    const end: any = normalizePiEvent("thr", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Раз два\n\nТри" }] } } as any, meta);
    expect(first.payload.blocks).toBeDefined();
    expect(second.payload.blocks).toBeUndefined();
    expect(paragraph.payload.blocks).toBeDefined();
    expect(end.payload.text).toBe("Раз два\n\nТри");
    expect(end.payload.blocks.length).toBeGreaterThan(0);
  });
});

describe("ответ конвертом JSON v1 — без сырого JSON (владелец 13.11.2026)", () => {
  it("целый ```json-конверт раскладывается в текст", async () => {
    const { sessionDisplayText } = await import("../src/runtime/ownerSessionEvents.js");
    const envelope = { schema_version: 1, ok: true, output: [{ type: "heading", text: "Итог" }, { type: "text", text: "Всё готово" }], artifacts: [], plan_artifact: null, error: null, next_hint: null };
    const shown = sessionDisplayText("```json\n" + JSON.stringify(envelope, null, 2) + "\n```");
    expect(shown).toContain("Всё готово");
    expect(shown).not.toContain("schema_version");
  });
  it("обычный текст не трогает", async () => {
    const { sessionDisplayText } = await import("../src/runtime/ownerSessionEvents.js");
    expect(sessionDisplayText("Просто ответ")).toBe("Просто ответ");
  });
});

describe("файл в обратных кавычках — ссылкой (владелец 13.11.2026)", () => {
  it("превращает `путь:строка` в ссылку, код в ``` не трогает", async () => {
    const { linkifyFileRefs } = await import("../src/runtime/ownerSessionEvents.js");
    expect(linkifyFileRefs("смотри `server/src/a.ts:42` и `deploy.sh`")).toBe("смотри [server/src/a.ts:42](server/src/a.ts:42) и [deploy.sh](deploy.sh)");
    expect(linkifyFileRefs("```\n`a.ts`\n```")).toBe("```\n`a.ts`\n```");
    expect(linkifyFileRefs("команда `git log -1`")).toBe("команда `git log -1`");
  });
});

describe("размышления — с разметкой и в конце, и в истории (владелец 13.11.2026)", () => {
  it("message_end несёт хвост размышления с блоками", async () => {
    const { normalizePiEvent } = await import("../src/runtime/ownerSessionEvents.js");
    const end: any = normalizePiEvent("think", { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Думаю **так**" }, { type: "text", text: "Ответ" }] } } as any, { cursor: "c", sequence: 1, epoch: "e" } as any);
    expect(end.payload.thinking.text).toBe("Думаю **так**");
    expect(end.payload.thinking.blocks.length).toBeGreaterThan(0);
  });
  it("снимок кладёт thinking_blocks к записи ответа", async () => {
    const { withAnswerBlocks } = await import("../src/routes/owner-sessions.js");
    const out: any = withAnswerBlocks({ entries: [{ type: "message", id: "a", message: { role: "assistant", content: [{ type: "thinking", thinking: "Мысль" }, { type: "text", text: "Ответ" }] } }] } as any);
    expect(out.entries[0].thinking_blocks[0].text).toBe("Мысль");
    expect(out.entries[0].thinking_blocks[0].blocks.length).toBeGreaterThan(0);
  });
});
