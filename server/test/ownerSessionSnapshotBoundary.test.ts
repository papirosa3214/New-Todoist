import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OwnerSessionEventBuffer } from "../src/runtime/ownerSessionEvents.js";
import { OwnerSessionRuntime } from "../src/runtime/ownerSessionRuntime.js";

/**
 * Граница согласованности снимка сессии и ленты событий.
 *
 * Pi сначала отдаёт событие слушателям и только потом, синхронно, в том же
 * продолжении, пишет запись в транскрипт (dist/core/agent-session.js,
 * `_handleAgentEvent`: `_emit(...)` → `sessionManager.appendMessage(...)`).
 * Поэтому курсор снимка читается первым в одном синхронном блоке с записями:
 * всё, что в ленте не новее точки, уже есть в снимке; всё, что новее, придёт
 * событиями. Событие, которое успело уйти вперёд записи, попадает в «новее»
 * и будет прислано повторно — потерять текст нельзя.
 */

const assistant = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text", text }],
  api: "test",
  provider: "test",
  model: "test",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const,
  timestamp: 1,
});

describe("граница снимка сессии и ленты событий", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-session-boundary-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("лента: начало эпохи — не сброс, вытесненный и чужая эпоха — сброс", () => {
    const buffer = new OwnerSessionEventBuffer({ capacity: 2, epoch: "e1", clock: () => new Date(0) });

    expect(buffer.boundary()).toEqual({ cursor: "e1:0", epoch: "e1", seq: 0 });
    expect(buffer.eventsAfter(buffer.boundary().cursor)).toMatchObject({ resetRequired: false, events: [] });

    buffer.push("s", { type: "agent_start" } as any);
    buffer.push("s", { type: "agent_settled", aborted: false } as any);
    buffer.push("s", { type: "agent_start" } as any);

    // first retained event is e1:2 (capacity 2) — e1:1 evicted.
    expect(buffer.boundary()).toEqual({ cursor: "e1:3", epoch: "e1", seq: 3 });
    expect(buffer.eventsAfter("e1:1")).toMatchObject({ resetRequired: true });
    expect(buffer.eventsAfter("e1:2").events.map(event => event.cursor)).toEqual(["e1:3"]);
    expect(buffer.eventsAfter("other:9")).toMatchObject({ resetRequired: true });
    // Та же точка, разложенная для клиента: сравнивать живое событие со
    // снимком можно числами, без разбора строки.
    expect(buffer.push("s", { type: "agent_start" } as any)).toMatchObject({ epoch: "e1", seq: 4 });
  });

  it("снимок: точка читается до записей, событие впереди записи не теряется", async () => {
    const order: string[] = [];
    const buffer = new OwnerSessionEventBuffer({ epoch: "e1", clock: () => new Date(0) });
    let manager!: SessionManager;
    const runtime = new OwnerSessionRuntime({
      cwd: dir,
      sessionDir: dir,
      createSession: async sessionManager => {
        manager = sessionManager;
        return {
          sessionManager,
          isStreaming: false,
          isIdle: true,
          model: { provider: "test", id: "test" },
          prompt: async () => {},
          steer: async () => undefined,
          followUp: async () => undefined,
          abort: async () => {},
          waitForIdle: async () => {},
          navigateTree: async () => ({ cancelled: false }),
          subscribe: () => () => {},
          dispose: () => {},
        } as any;
      },
    });

    const created = await runtime.createRoot();
    const branch = manager.getBranch.bind(manager);
    manager.getBranch = () => {
      order.push("entries");
      return branch();
    };

    const readBoundary = () => {
      order.push("boundary");
      return buffer.boundary();
    };

    // Запись есть — она обязана быть в снимке.
    manager.appendMessage(assistant("готовый ответ") as any);
    const event = buffer.push(created.id, { type: "message_end", message: assistant("готовый ответ") } as any);
    const snapshot = await runtime.snapshotWithBoundary(created.id, readBoundary);

    expect(snapshot.entries).toHaveLength(1);
    // Точка и записи — из одного мгновения: событие, которое уже в записях,
    // не приедет второй раз (текст не задвоится).
    expect(snapshot.eventCursor).toBe(event.cursor);
    expect(snapshot.eventCursorSeq).toBe(event.seq);
    expect(buffer.eventsAfter(snapshot.eventCursor!, created.id).events).toEqual([]);
    // А клиент со старой точкой это событие не теряет.
    expect(buffer.eventsAfter("e1:0", created.id).events).toEqual([
      expect.objectContaining({ cursor: event.cursor, type: "message_end" }),
    ]);
    // Точку берём ДО записей: если в блок когда-то попадёт await, худшее —
    // повтор события, а не пропавший текст.
    expect(order).toEqual(["boundary", "entries"]);
  });

  // Ревью 703765cb: снимок посреди ответа не имеет права брать конец ленты.
  // Pi пишет сообщение только на message_end, поэтому куски между
  // message_start и message_end в entries отсутствуют; точка на конце ленты
  // молча теряла голову незавершённого хода.
  it("снимок посреди стрима: незавершённый ход восстанавливается, записи не двоятся", () => {
    const buffer = new OwnerSessionEventBuffer({ epoch: "e1", clock: () => new Date(0) });

    buffer.push("s", { type: "message_start", message: { role: "user" } } as any);
    const userEnd = buffer.push("s", { type: "message_end", message: { role: "user" } } as any);
    buffer.push("s", { type: "message_start", message: { role: "assistant" } } as any);
    buffer.push("s", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "гол", contentIndex: 0 } } as any);
    buffer.push("s", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ова", contentIndex: 0 } } as any);

    // Точка снимка — последняя записанная, а не конец ленты.
    const boundary = buffer.boundary("s");
    expect(boundary).toMatchObject({ cursor: userEnd.cursor, seq: userEnd.seq });
    expect(boundary.cursor).not.toBe(buffer.boundary().cursor);

    // Клиент после reset доигрывает ровно окно ответа: сообщение
    // пользователя уже в снимке и повторно не едет.
    const gap = buffer.eventsAfter(boundary.cursor, "s");
    expect(gap.resetRequired).toBe(false);
    expect(gap.events.map(event => event.cursor)).toEqual(["e1:3", "e1:4", "e1:5"]);
    expect(gap.events[0]?.type).toBe("message_start");
    expect(gap.events.some(event => event.cursor === userEnd.cursor)).toBe(false);

    // Ответ дописан: окно закрылось, точка снова на конце ленты.
    const done = buffer.push("s", { type: "message_end", message: { role: "assistant", content: [] } } as any);
    expect(buffer.boundary("s").cursor).toBe(done.cursor);
    expect(buffer.eventsAfter(done.cursor, "s").events).toEqual([]);

    // Чужая сессия стримится — окна этой она не открывает.
    buffer.push("other", { type: "message_start", message: { role: "assistant" } } as any);
    expect(buffer.boundary("s").seq).toBe(buffer.boundary().seq);

    // Окно не застывает, если message_end не пришёл вовсе.
    buffer.push("other", { type: "message_start", message: { role: "assistant" } } as any);
    expect(buffer.boundary("other").seq).toBeLessThan(buffer.boundary().seq);
    buffer.push("other", { type: "agent_settled", aborted: true } as any);
    expect(buffer.boundary("other").seq).toBe(buffer.boundary().seq);
  });

  it("начало эпохи — сброс только пока из начала ничего не вытеснено", () => {
    const buffer = new OwnerSessionEventBuffer({ capacity: 2, epoch: "e1", clock: () => new Date(0) });

    buffer.push("s", { type: "agent_start" } as any);
    buffer.push("s", { type: "agent_start" } as any);
    // Всё с начала ленты удержано — доиграть можно, сброс не нужен.
    expect(buffer.eventsAfter("e1:0")).toMatchObject({ resetRequired: false });

    buffer.push("s", { type: "agent_start" } as any);
    // Начало вытеснено: «доиграй всё удержанное» скрыло бы потерю головы.
    const lost = buffer.eventsAfter("e1:0");
    expect(lost.resetRequired).toBe(true);
    expect(lost.events.map(event => event.cursor)).toEqual(["e1:2", "e1:3"]);
    expect(buffer.eventsAfter("other:0")).toMatchObject({ resetRequired: true });
  });
});
