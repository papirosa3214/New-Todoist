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
  lastThinkingPhrase,
  liveTurnsOfChat,
  redactSecrets,
  startLiveTurn,
  stepDetail,
  stepDetailFallback,
  stripQuickRepliesLine,
  unwrapRoleEnvelope,
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

const think = (type: string, delta?: string) => ({
  type: "message_update",
  assistantMessageEvent: { type, delta },
});

describe("размышления роли (28.09.2026)", () => {
  it("пока думает — последняя законченная фраза, потом null", () => {
    vi.useFakeTimers();
    const turn = newTurn();
    turn.onEvent(think("thinking_start"));
    expect(sent).toHaveLength(1);
    expect(sent[0].event.turn.thinking).toBe("");

    turn.onEvent(think("thinking_delta", "Пользователь просит сводку. Сначала посмотрю до"));
    vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    expect(sent.at(-1)!.event.turn.thinking).toBe("Пользователь просит сводку.");

    turn.onEvent(think("thinking_delta", "ску.\n"));
    vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    expect(sent.at(-1)!.event.turn.thinking).toBe("Сначала посмотрю доску.");

    turn.onEvent(think("thinking_end"));
    expect(sent.at(-1)!.event.turn.thinking).toBeNull();
  });

  it("полный текст размышления — элементом хода (30.09.2026)", () => {
    vi.useFakeTimers();
    const turn = newTurn();
    turn.onEvent(think("thinking_start"));
    expect(sent.at(-1)!.event.turn.items).toEqual([
      expect.objectContaining({ kind: "thinking", tool: "thinking", text: "", status: "running" }),
    ]);
    turn.onEvent(think("thinking_delta", "Смотрю доску. token=abcdef123 "));
    turn.onEvent(think("thinking_delta", "и сравниваю"));
    vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    const live = sent.at(-1)!.event.turn.items[0];
    expect(live.text).toBe("Смотрю доску. token=••• и сравниваю");
    expect(live.status).toBe("running");
    turn.onEvent(think("thinking_end"));
    const done = sent.at(-1)!.event.turn.items[0];
    expect(done.status).toBe("done");
    expect(done.ended_at).toBeTruthy();
  });

  it("текст ответа или шаг закрывают размышление, в историю оно идёт", () => {
    vi.useFakeTimers();
    const turn = newTurn();
    turn.onEvent(think("thinking_start"));
    turn.onEvent(think("thinking_delta", "Надо проверить файл."));
    turn.onEvent(toolStart("t1", "read", { path: "/tmp/a" }));
    expect(sent.at(-1)!.event.turn.thinking).toBeNull();
    turn.onEvent(toolEnd("t1"));
    const saved = turn.finish()!.items;
    expect(saved.map((it) => it.kind)).toEqual(["thinking", "step"]);
    expect(saved[0]).toMatchObject({ text: "Надо проверить файл.", status: "done" });
  });

  it("ход только с размышлением и ответом тоже сохраняет размышление", () => {
    const turn = newTurn();
    turn.onEvent(think("thinking_start"));
    turn.onEvent(think("thinking_delta", "Коротко ответить."));
    turn.onEvent(text("Готово."));
    expect(turn.finish()!.items).toEqual([
      expect.objectContaining({ kind: "thinking", text: "Коротко ответить.", status: "done" }),
    ]);
  });

  it("пустое законченное размышление не показывается и не сохраняется", () => {
    const turn = newTurn();
    turn.onEvent(think("thinking_start"));
    turn.onEvent(think("thinking_end"));
    turn.onEvent(text("Ответ."));
    expect(liveTurnsOfChat("c1")[0].items).toEqual([{ kind: "text", text: "Ответ." }]);
    expect(turn.finish()).toBeNull();
  });

  it("фраза: без разметки, ключи затёрты, недописанное не берётся", () => {
    expect(lastThinkingPhrase("**План:** проверить")).toBe("План:");
    expect(lastThinkingPhrase("начало без точки")).toBe("");
    expect(lastThinkingPhrase("token=abcdef123 в конфиге.")).toBe("token=••• в конфиге.");
  });
});

describe("подпись шага", () => {
  it("путь, команда, поиск, прочие инструменты", () => {
    expect(stepDetail("read", { path: "/home/maksim/p/a.ts" })).toBe("~/p/a.ts");
    expect(stepDetail("bash", { command: "npm\n  test" })).toBe("npm test");
    expect(stepDetail("grep", { pattern: "foo", path: "/Users/max/x" })).toBe("foo — ~/x");
    expect(stepDetail("taskflow_create_task", { title: "Позвонить" })).toBe("новая задача — Позвонить");
    expect(stepDetail("taskflow_taskflow_agents", {})).toBe("кто на связи");
    expect(stepDetail("web_search", { query: "погода" })).toBe("погода");
    expect(stepDetailFallback("taskflow_taskflow_project_tasks", null)).toBe("задачи проекта");
    expect(stepDetailFallback("read", null)).toBeNull();
    expect(stepDetail("mcp", { tool: "taskflow_taskflow_status" })).toBe("сводка доски");
    expect(stepDetail("mcp", { tool: "taskflow_taskflow_kb_search", args: { query: "стриминг" } })).toBe(
      "поиск в базе знаний — стриминг",
    );
    expect(stepDetail("mcp", { tool: "other_server_do_thing" })).toBe("other server do thing");
    expect(stepDetail("mcp", {})).toBeNull();
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

describe("конверт ответа роли (01.10.2026)", () => {
  const envelope = [
    "Нашёл главное.",
    "",
    "```",
    "ok: true",
    "output: |",
    "  Решение зафиксировано.",
    "",
    "  - 8 шагов: миграция → тесты.",
    "artifacts:",
    "  - задача 2b2638a2",
    "error: null",
    "next_hint: |",
    "  Дай ответ на 4 пункта.",
    "needs_human: true",
    "```",
    "",
    "Жду твой DAG.",
  ].join("\n");

  it("оставляет только output, текст вокруг не трогает", () => {
    expect(unwrapRoleEnvelope(envelope)).toBe(
      "Нашёл главное.\n\nРешение зафиксировано.\n\n- 8 шагов: миграция → тесты.\n\nЖду твой DAG.",
    );
  });

  it("недописанный конверт живого хода — уже без обёртки", () => {
    expect(unwrapRoleEnvelope("```\nok: true\noutput: |\n  Решение зафикс")).toBe("Решение зафикс");
    expect(unwrapRoleEnvelope("```\nok: true\nout")).toBe("");
  });

  it("конверт без обрамления и с полями в кавычках", () => {
    expect(
      unwrapRoleEnvelope("ok: true\n\noutput: |\n **Принято.**\n\n Дальше.\nartifacts: null\nerror: null"),
    ).toBe("**Принято.**\n\nДальше.");
    expect(
      unwrapRoleEnvelope("`ok: true`\n`output:`\nДа, так.\n\nВторой абзац.\n`artifacts: null`\n`needs_human: false`"),
    ).toBe("Да, так.\n\nВторой абзац.");
  });

  it("обычный код и текст без конверта не меняются", () => {
    const code = "Вот:\n```ts\nconst ok = true;\n```";
    expect(unwrapRoleEnvelope(code)).toBe(code);
    expect(unwrapRoleEnvelope("```yaml\nok: maybe\n```")).toBe("```yaml\nok: maybe\n```");
    const json = "Пример:\n```json\n{\"ok\": true}\n```";
    expect(unwrapRoleEnvelope(json)).toBe(json);
    expect(unwrapRoleEnvelope("Сервер ответил ok: true — всё хорошо.")).toBe("Сервер ответил ok: true — всё хорошо.");
  });

  it("в живом снимке конверт тоже снят", () => {
    const turn = newTurn();
    turn.onEvent(text("```\nok: true\noutput: |\n  Готово.\n```"));
    expect(liveTurnsOfChat("c1")[0].items).toEqual([{ kind: "text", text: "Готово." }]);
  });
});
