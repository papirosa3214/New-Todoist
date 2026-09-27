// Живой ход роли в чате (владелец 27.09.2026): снимок хода из событий
// рантайма, рассылка chats:live, шаги для истории.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ ids: unknown; event: any }> = [];
vi.mock("../src/ws.js", () => ({
  broadcastToUsers: vi.fn((ids: unknown, event: any) => {
    sent.push({ ids, event: JSON.parse(JSON.stringify(event)) });
  }),
}));

import {
  LIVE_BROADCAST_MS,
  _resetLiveTurnsForTests,
  chatRunFailureText,
  liveTurnsOfChat,
  redactSecrets,
  startLiveTurn,
  stepDetail,
  stripQuickRepliesLine,
} from "../src/runtime/chatLiveTurn.js";

const text = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});
const toolStart = (id: string, toolName: string, args: unknown) => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName,
  args,
});
const toolEnd = (id: string, isError = false) => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "x",
  isError,
});

function newTurn() {
  return startLiveTurn({
    chatId: "c1",
    userId: "role_qa",
    name: "QA",
    audience: () => ["u1", "role_qa"],
  });
}

beforeEach(() => {
  sent.length = 0;
  _resetLiveTurnsForTests();
});
afterEach(() => vi.useRealTimers());

describe("живой ход", () => {
  it("склеивает текст по словам и рассылает пачкой, а шаг — сразу", async () => {
    vi.useFakeTimers();
    const turn = newTurn();
    turn.onEvent(text("Сейчас "));
    turn.onEvent(text("проверю."));
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].event.type).toBe("chats:live");
    expect(sent[0].event.turn.items).toEqual([{ kind: "text", text: "Сейчас проверю." }]);

    turn.onEvent(toolStart("t1", "bash", { command: "ls -la /home/maksim/x" }));
    expect(sent).toHaveLength(2);
    const step = sent[1].event.turn.items[1];
    expect(step).toMatchObject({ kind: "step", tool: "bash", status: "running", detail: "ls -la /home/maksim/x" });

    turn.onEvent(toolEnd("t1"));
    expect(sent[2].event.turn.items[1].status).toBe("done");
  });

  it("finish: убирает снимок у всех, последний текст уходит в пузырь, шаги — в историю", () => {
    const turn = newTurn();
    turn.onEvent(text("Смотрю файл"));
    turn.onEvent(toolStart("t1", "read", { path: "/home/maksim/a.txt" }));
    turn.onEvent(toolEnd("t1"));
    turn.onEvent(toolStart("t2", "bash", { command: "false" }));
    turn.onEvent(text("Готово"));
    expect(liveTurnsOfChat("c1")).toHaveLength(1);

    const saved = turn.finish();
    expect(liveTurnsOfChat("c1")).toHaveLength(0);
    expect(sent.at(-1)?.event).toMatchObject({ type: "chats:live", turn: null });
    expect(saved?.items.map((i) => i.kind)).toEqual(["text", "step", "step"]);
    expect(saved?.items[1]).toMatchObject({ tool: "read", detail: "~/a.txt", status: "done" });
    // Незакрытый шаг при обрыве хода — ошибка, а не вечный «идёт».
    expect(saved?.items[2]).toMatchObject({ tool: "bash", status: "error" });
    expect(saved?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("ход без шагов — в историю ничего", () => {
    const turn = newTurn();
    turn.onEvent(text("Просто ответ"));
    expect(turn.finish()).toBeNull();
  });

  it("второй ход той же роли в чате не трогает ленту первого", () => {
    const first = newTurn();
    first.onEvent(toolStart("t1", "read", { path: "/a" }));
    const second = newTurn();
    second.onEvent(toolStart("t9", "bash", { command: "x" }));
    expect(second.finish()).toBeNull();
    expect(liveTurnsOfChat("c1")).toHaveLength(1);
    expect(liveTurnsOfChat("c1")[0].items).toHaveLength(1);
    expect(sent.some((s) => s.event.turn === null)).toBe(false);
  });

  it("строка «БЫСТРО:» Секретаря в живом тексте не видна, даже недописанная", () => {
    expect(stripQuickRepliesLine("Ответ\nБЫСТРО: да | нет")).toBe("Ответ");
    expect(stripQuickRepliesLine("Ответ\nБЫС")).toBe("Ответ");
    expect(stripQuickRepliesLine("Ответ\nБыстрый текст")).toBe("Ответ\nБыстрый текст");
  });
});

describe("подпись шага", () => {
  it("путь, команда, поиск, прочие инструменты", () => {
    expect(stepDetail("read", { path: "/home/maksim/p/a.ts" })).toBe("~/p/a.ts");
    expect(stepDetail("bash", { command: "npm\n  test" })).toBe("npm test");
    expect(stepDetail("grep", { pattern: "foo", path: "/Users/max/x" })).toBe("foo — ~/x");
    expect(stepDetail("taskflow_create_task", { title: "Позвонить" })).toBe("Позвонить");
    expect(stepDetail("bash", null)).toBeNull();
    expect(stepDetail("bash", { command: "x".repeat(500) })!.length).toBeLessThanOrEqual(140);
  });

  it("ключи затираются", () => {
    expect(redactSecrets("curl -H 'Authorization: Bearer abc.def'")).not.toContain("abc.def");
    expect(redactSecrets("TOKEN=supersecret123 run")).toBe("TOKEN=••• run");
    expect(redactSecrets("key sk-ant-abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(redactSecrets("a".repeat(64))).toBe("•••");
  });
});

describe("текст о сорванном ходе", () => {
  it("тишина, потолок, занятость, прочее", () => {
    expect(chatRunFailureText({ code: "CHAT_RUN_IDLE", limitMs: 180_000 })).toContain("3 мин не было никаких действий");
    expect(chatRunFailureText({ code: "CHAT_RUN_CEILING", limitMs: 1_800_000 })).toContain("дольше 30 мин");
    expect(chatRunFailureText({ code: "CHAT_RUN_BUSY" })).toBe("");
    expect(chatRunFailureText(new Error("model_not_available: x\nStderr: boom"))).toBe(
      "Не смог ответить: model_not_available: x",
    );
  });
});
