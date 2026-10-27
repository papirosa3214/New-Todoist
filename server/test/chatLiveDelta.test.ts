// Живой ход дельтами (владелец 27.10.2026, карточка 7b73b9c9 / Linear MAK-137):
// chats:live:start → patch (только изменения, seq подряд) → end, рядом со
// старым chats:live.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ ids: unknown; event: any }> = [];
vi.mock("../src/ws.js", () => ({
  broadcastToUsers: vi.fn((ids: unknown, event: any) => {
    sent.push({ ids, event: JSON.parse(JSON.stringify(event)) });
  }),
}));

import { LIVE_BROADCAST_MS, _resetLiveTurnsForTests, liveTurnsOfChat, startLiveTurn } from "../src/runtime/chatLiveTurn.js";
import { liveDeltaOps } from "../src/runtime/chatLiveDelta.js";

const text = (delta: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
const of = (type: string) => sent.filter((s) => s.event.type === type).map((s) => s.event);
const turn = () => startLiveTurn({ chatId: "c1", userId: "role_qa", name: "QA", messageId: "m-planned", audience: () => ["u1"] });

beforeEach(() => { sent.length = 0; _resetLiveTurnsForTests(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("расчёт операций", () => {
  const t = (id: string, value: string) => ({ id, kind: "text", text: value });
  it("продолжение текста — text_append, правка не с конца — text_replace", () => {
    expect(liveDeltaOps({ items: [t("x0", "При")], thinking: null }, { items: [t("x0", "Привет")], thinking: null }))
      .toEqual([{ op: "text_append", item_id: "x0", text: "вет" }]);
    expect(liveDeltaOps({ items: [t("x0", "{\"text\":\"При")], thinking: null }, { items: [t("x0", "Привет")], thinking: null }))
      .toEqual([{ op: "text_replace", item_id: "x0", text: "Привет" }]);
  });
  it("новый элемент — item_add целиком, без изменений — пусто", () => {
    expect(liveDeltaOps(null, { items: [t("x0", "А")], thinking: null })).toEqual([{ op: "item_add", item: t("x0", "А") }]);
    expect(liveDeltaOps({ items: [t("x0", "А")], thinking: null }, { items: [t("x0", "А")], thinking: null })).toEqual([]);
  });
  it("шаг — item_update только изменённых полей", () => {
    const step = { id: "s1", kind: "step", tool: "bash", detail: "ls", status: "running", started_at: "a" };
    expect(liveDeltaOps({ items: [step], thinking: null }, { items: [{ ...step, status: "done", ended_at: "b", output: "ok" }], thinking: null }))
      .toEqual([{ op: "item_update", item_id: "s1", fields: { status: "done", ended_at: "b", output: "ok" } }]);
  });
  it("blocks — только при смене состава, рост прозы в хвосте не пересылает", () => {
    const doc = (s: string) => ({ type: "doc", doc: { text: s }, chars: s.length, source: s });
    const a = { id: "x0", kind: "text", text: "Ab", blocks: [doc("Ab")] };
    const b = { id: "x0", kind: "text", text: "Abc", blocks: [doc("Abc")] };
    expect(liveDeltaOps({ items: [a], thinking: null }, { items: [b], thinking: null })).toEqual([{ op: "text_append", item_id: "x0", text: "c" }]);
    const table = { type: "table", header: [], align: [], rows: [], chars: 0, source: "|a|" };
    const c = { ...b, text: "Abc\n|a|", blocks: [doc("Abc"), table] };
    expect(liveDeltaOps({ items: [b], thinking: null }, { items: [c], thinking: null }))
      .toEqual([{ op: "text_append", item_id: "x0", text: "\n|a|" }, { op: "blocks", item_id: "x0", blocks: c.blocks }]);
  });
  it("фраза размышлений — thinking", () => {
    expect(liveDeltaOps({ items: [], thinking: null }, { items: [], thinking: "Смотрю" })).toEqual([{ op: "thinking", phrase: "Смотрю" }]);
  });
});

describe("рассылка хода", () => {
  it("start с заранее выданным номером, patch подряд, end после сохранения", () => {
    const live = turn();
    const [start] = of("chats:live:start");
    expect(start).toMatchObject({ chat_id: "c1", user_id: "role_qa", message_id: "m-planned", seq: 0, name: "QA" });
    expect(typeof start.turn_id).toBe("string");
    live.onEvent(text("При")); vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    live.onEvent(text("вет")); vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    const patches = of("chats:live:patch");
    expect(patches.map((p) => p.seq)).toEqual([1, 2]);
    expect(patches[0].ops[0]).toMatchObject({ op: "item_add", item: { kind: "text", text: "При" } });
    expect(patches[1].ops).toEqual([{ op: "text_append", item_id: patches[0].ops[0].item.id, text: "вет" }]);
    expect(of("chats:live")).toHaveLength(2);
    live.finish({ deferAnnounce: true });
    expect(of("chats:live:end")).toHaveLength(0);
    live.announceEnd("m-planned");
    expect(of("chats:live:end")).toEqual([{ type: "chats:live:end", chat_id: "c1", user_id: "role_qa", turn_id: start.turn_id, seq: 3, message_id: "m-planned" }]);
  });
  it("снимок для восстановления несёт turn_id, message_id и seq", () => {
    const live = turn();
    live.onEvent(text("А")); vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    const [snap] = liveTurnsOfChat("c1");
    expect(snap).toMatchObject({ turn_id: of("chats:live:start")[0].turn_id, message_id: "m-planned", seq: 1 });
  });
  it("снимок сначала рассылает накопленное — seq снимка совпадает с последней дельтой", () => {
    const live = turn();
    live.onEvent(text("А")); vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    live.onEvent(text("Б"));
    const [snap] = liveTurnsOfChat("c1");
    const patches = of("chats:live:patch");
    expect(snap.seq).toBe(2);
    expect(patches.map((p) => p.seq)).toEqual([1, 2]);
    expect((snap.items[0] as any).text).toBe("АБ");
    vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    expect(of("chats:live:patch")).toHaveLength(2);
  });
  it("два куска текста вокруг шага — разные id, второй не затирает первый", () => {
    const live = turn();
    live.onEvent(text("До шага")); vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    live.onEvent({ type: "tool_execution_start", toolCallId: "s1", toolName: "read", args: { path: "a" } });
    live.onEvent(text("После шага")); vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    const added = of("chats:live:patch").flatMap((p) => p.ops).filter((o) => o.op === "item_add" && o.item.kind === "text");
    expect(added.map((o) => o.item.text)).toEqual(["До шага", "После шага"]);
    expect(added[0].item.id).toBeTruthy();
    expect(added[1].item.id).not.toBe(added[0].item.id);
  });
  it("ход-двойник ничего не рассылает", () => {
    turn(); sent.length = 0;
    const twin = turn();
    twin.onEvent(text("А")); vi.advanceTimersByTime(LIVE_BROADCAST_MS);
    expect(sent).toHaveLength(0);
  });
});
