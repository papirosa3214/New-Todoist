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
});
