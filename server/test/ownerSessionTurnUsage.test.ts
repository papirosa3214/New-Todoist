import { describe, expect, it } from "vitest";
import {
  ownerSessionAnswerCall,
  ownerSessionTurns,
  ownerSessionTurnUsageByEntry,
} from "../src/runtime/ownerSessionTurnUsage.js";
import { OwnerSessionEventBuffer } from "../src/runtime/ownerSessionEvents.js";
import { withAnswerBlocks } from "../src/routes/owner-sessions.js";

const T1 = 1794531192196; // реплика владельца
const A1 = 1794531199000;
const A2 = 1794531207505;
const T2 = 1794531300000;
const A3 = 1794531305000;

const userEntry = (id: string, timestamp: number) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: new Date(timestamp).toISOString(),
  message: { role: "user", content: [{ type: "text", text: `${id}` }], timestamp },
});

const assistantEntry = (
  id: string,
  timestamp: number,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number | null; durationMs?: number },
  model = "deepseek-v4.1-flash",
) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: new Date(timestamp).toISOString(),
  message: {
    role: "assistant",
    content: [{ type: "text", text: `ответ ${id}` }],
    api: "openai-completions",
    provider: "opencode-go",
    model,
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      cost: usage.cost === null ? {} : { total: usage.cost ?? 0 },
    },
    stopReason: "stop",
    timestamp,
    durationMs: usage.durationMs ?? 1000,
  },
});

const firstTurn = () => [
  userEntry("u1", T1),
  assistantEntry("a1", A1, { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0, cost: 0.001, durationMs: 2000 }),
  assistantEntry("a2", A2, { input: 292, output: 260, cacheRead: 42880, cacheWrite: 0, cost: 0.00032844, durationMs: 3669 }, "deepseek-v4.1-pro"),
];

describe("ownerSessionAnswerCall", () => {
  it("читает расход одного ответа: context — вход плюс кэш, calls 1", () => {
    const call = ownerSessionAnswerCall(assistantEntry("a", A1, { input: 10, output: 5, cacheRead: 90, cacheWrite: 1, cost: 0.5, durationMs: 400 }).message);
    expect(call).toMatchObject({
      usage: {
        input: 10, output: 5, cache_read: 90, cache_write: 1, cost_usd: 0.5,
        generation_ms: 400, model: "deepseek-v4.1-flash", context: 101, calls: 1,
      },
      provider: "opencode-go",
      timestamp: A1,
      durationMs: 400,
    });
  });

  it("запись без usage или не ассистент — не ответ с расходом", () => {
    expect(ownerSessionAnswerCall(userEntry("u", T1).message)).toBeNull();
    expect(ownerSessionAnswerCall({ role: "assistant", content: [] })).toBeNull();
  });
});

describe("ownerSessionTurns", () => {
  it("суммирует ход: суммы по ответам, context и model — последнего обращения", () => {
    const [turn] = ownerSessionTurns(firstTurn());
    expect(turn.entry_key).toBe("a2");
    expect(turn.usage).toMatchObject({
      input: 392,
      output: 310,
      cache_read: 43880,
      cache_write: 0,
      generation_ms: 5669,
      context: 43172,
      calls: 2,
      model: "deepseek-v4.1-pro",
    });
    expect(turn.usage?.cost_usd).toBeCloseTo(0.00132844, 10);
  });

  it("duration_ms — от реплики владельца до конца последнего ответа, started_at — реплика", () => {
    const [turn] = ownerSessionTurns(firstTurn());
    expect(turn.usage?.duration_ms).toBe(A2 + 3669 - T1);
    expect(turn.usage?.started_at).toBe(new Date(T1).toISOString());
  });

  it("несколько ходов — отдельные итоги, каждый привязан к своему последнему ответу", () => {
    const entries = [
      ...firstTurn(),
      userEntry("u2", T2),
      assistantEntry("a3", A3, { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, cost: null, durationMs: 1000 }),
    ];
    const turns = ownerSessionTurns(entries);
    expect(turns.map(turn => turn.entry_key)).toEqual(["a2", "a3"]);
    expect(turns[1].usage).toMatchObject({ input: 10, output: 5, context: 110, calls: 1, cost_usd: null, duration_ms: A3 + 1000 - T2 });
    expect(turns[1].usage?.started_at).toBe(new Date(T2).toISOString());
  });

  it("обрывки без расхода ходом не считаются", () => {
    const entries = [userEntry("u1", T1), { type: "custom_message", customType: "taskflow.voice", details: { role: "assistant", text: "привет" } }];
    expect(ownerSessionTurns(entries)).toEqual([]);
    expect(ownerSessionTurnUsageByEntry(entries).size).toBe(0);
  });
});

describe("withAnswerBlocks", () => {
  it("кладёт turn_usage только на последний ответ хода, text_blocks остаются у всех", () => {
    const snapshot = withAnswerBlocks({ entries: firstTurn() }) as any;
    const [user, first, last] = snapshot.entries;
    expect(user.turn_usage).toBeUndefined();
    expect(first.turn_usage).toBeUndefined();
    expect(first.text_blocks).toBeDefined();
    expect(last.text_blocks).toBeDefined();
    expect(last.turn_usage).toMatchObject({ calls: 2, input: 392, context: 43172, started_at: new Date(T1).toISOString() });
    expect(last.turn_usage.duration_ms).toBe(A2 + 3669 - T1);
  });
});

describe("OwnerSessionEventBuffer: живой ход", () => {
  it("собирает итог по sessionId и отдаёт turn_usage в agent_settled", () => {
    const base = Date.parse("2026-11-13T00:53:00.000Z");
    const buffer = new OwnerSessionEventBuffer({ clock: () => new Date(base) });
    buffer.push("s1", { type: "agent_start" } as any);
    buffer.push("s1", { type: "message_end", message: assistantEntry("a1", A1, { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0, cost: 0.001, durationMs: 2000 }).message } as any);
    buffer.push("s1", { type: "message_end", message: assistantEntry("a2", A2, { input: 292, output: 260, cacheRead: 42880, cacheWrite: 0, cost: 0.00032844, durationMs: 3669 }).message } as any);
    const settled = buffer.push("s1", { type: "agent_settled", aborted: false } as any);

    expect(settled.type).toBe("agent_settled");
    expect(settled.payload.turn_usage).toMatchObject({
      input: 392, output: 310, cache_read: 43880, cache_write: 0,
      context: 43172, calls: 2, generation_ms: 5669,
      duration_ms: A2 + 3669 - base,
      started_at: new Date(base).toISOString(),
    });
  });

  it("новый agent_start начинает новый ход, а пустой ход turn_usage не получает", () => {
    const base = Date.parse("2026-11-13T00:53:00.000Z");
    const buffer = new OwnerSessionEventBuffer({ clock: () => new Date(base) });
    buffer.push("s1", { type: "message_end", message: assistantEntry("a1", A1, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }).message } as any);
    const firstSettled = buffer.push("s1", { type: "agent_settled", aborted: false } as any);
    expect(firstSettled.payload.turn_usage).toMatchObject({ calls: 1, input: 1 });

    buffer.push("s1", { type: "agent_start" } as any);
    const emptySettled = buffer.push("s1", { type: "agent_settled", aborted: true } as any);
    expect(emptySettled.payload).toEqual({ aborted: true });
  });
});
