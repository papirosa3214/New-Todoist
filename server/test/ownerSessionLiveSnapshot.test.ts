import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OwnerSessionEventBuffer } from "../src/runtime/ownerSessionEvents.js";
import { OwnerSessionRuntime } from "../src/runtime/ownerSessionRuntime.js";

/**
 * Живой хвост снимка сессии владельца (`session.live`).
 *
 * Pi пишет сообщение в транскрипт только на `message_end`
 * (`pi-agent-core/dist/agent-loop.js`), поэтому снимок из одной ветки
 * незавершённый ответ не видит вовсе. Готовое состояние агента
 * (`AgentSession.state` → `agent.state.streamingMessage`, `processEvents`)
 * держит тот же текст целиком: `message_start`/`message_update` кладут
 * сообщение, `message_end` очищает и дописывает в `messages`. Сервер читает
 * это состояние в том же синхронном блоке, что и записи, и отдаёт рядом.
 *
 * Обратная совместимость: поля только добавляются, верхнеуровневый
 * `eventCursor` прежний (с откатом к началу окна стрима), без состояния —
 * снимок как раньше.
 *
 * Граница покрытия: `live` — только текущий ответ ассистента, поэтому он не
 * двигает точку событий (`coverage: "current_response_only"`). Окно ответа
 * клиент по-прежнему доигрывает от `eventCursor`: иначе, пропустив события,
 * он потерял бы шаги хода (аргументы и результаты инструментов, завершённые
 * сообщения), которых в `live` нет.
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

describe("снимок сессии: живой хвост из состояния Pi", () => {
  let dir: string;
  let state: any;
  let manager!: SessionManager;
  let runtime: OwnerSessionRuntime;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-session-live-"));
    state = { streamingMessage: undefined, pendingToolCalls: new Set<string>() };
    runtime = new OwnerSessionRuntime({
      cwd: dir,
      sessionDir: dir,
      createSession: async sessionManager => {
        manager = sessionManager;
        return ({
          sessionManager,
          isStreaming: Boolean(state.streamingMessage),
          isIdle: !state.streamingMessage,
          model: { provider: "test", id: "test" },
          get state() {
            return state;
          },
          prompt: async () => {},
          steer: async () => undefined,
          followUp: async () => undefined,
          abort: async () => {},
          waitForIdle: async () => {},
          navigateTree: async () => ({ cancelled: false }),
          subscribe: () => () => {},
          dispose: () => {},
        }) as any;
      },
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("незавершённый ответ виден снимком: текст, размышление, вызовы и занятые инструменты", async () => {
    const buffer = new OwnerSessionEventBuffer({ epoch: "e1", clock: () => new Date(0) });
    const { id } = await runtime.createRoot();

    const userEnd = buffer.push(id, { type: "message_end", message: { role: "user" } } as any);
    buffer.push(id, { type: "message_start", message: assistant("") } as any);
    buffer.push(id, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "го", contentIndex: 1 },
    } as any);
    buffer.push(id, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "това", contentIndex: 1 },
    } as any);

    // Готовое состояние Pi: часть ответа, размышление и вызов инструмента.
    // Пробелы в тексте — как их отдаёт Pi: снимок не срезает ни начало, ни
    // хвост строки (в коде это отступы, их потеря искажает ответ).
    state.streamingMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "думаю" },
        { type: "text", text: "  готова к работе\nстрока с отступом  " },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { cmd: "ls" } },
      ],
    };
    state.pendingToolCalls = new Set(["call-1"]);

    const snapshot = await runtime.snapshotWithBoundary(id, () => buffer.boundary(id));

    // Записи незавершённого ответа не содержат — весь он в живом хвосте.
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.live).toMatchObject({
      streaming: true,
      coverage: "current_response_only",
      displayText: "  готова к работе\nстрока с отступом  ",
      toolCalls: [{ id: "call-1", name: "bash" }],
      pendingToolCalls: ["call-1"],
    });
    expect(snapshot.live?.textBlocks?.length).toBeGreaterThan(0);
    expect(snapshot.live?.thinkingBlocks).toEqual([{ text: "думаю", blocks: expect.any(Array) }]);
    // Аргументов инструмента в снимке нет — они уходят событиями tool_start.
    expect(JSON.stringify(snapshot.live)).not.toContain("cmd");

    // Ложного контракта полного покрытия нет: хвост НЕ несёт своей точки —
    // точка снимка прежняя, с откатом к началу окна ответа.
    expect(snapshot.eventCursor).toBe(userEnd.cursor);
    expect(snapshot.live).not.toHaveProperty("eventCursor");
    expect(snapshot.live).not.toHaveProperty("eventCursorSeq");
  });

  it("служебный конверт v1 не показывается сырым и не утекает в снимок", async () => {
    const buffer = new OwnerSessionEventBuffer({ epoch: "e1", clock: () => new Date(0) });
    const { id } = await runtime.createRoot();
    buffer.push(id, { type: "message_start", message: assistant("") } as any);

    state.streamingMessage = {
      role: "assistant",
      content: [{ type: "text", text: '```json\n{"schema_version":1,"output":[{"type":"text","text":"готово' }],
    };

    const snapshot = await runtime.snapshotWithBoundary(id, () => buffer.boundary(id));

    expect(snapshot.live).toMatchObject({
      streaming: true,
      coverage: "current_response_only",
      envelopeHeld: true,
      pendingToolCalls: [],
    });
    expect(snapshot.live?.displayText).toBeUndefined();
    expect(snapshot.live?.textBlocks).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("schema_version");
  });

  it("остановка и message_end: хвоста нет, ответ уже запись; без состояния Pi снимок как раньше", async () => {
    const buffer = new OwnerSessionEventBuffer({ epoch: "e1", clock: () => new Date(0) });
    const { id } = await runtime.createRoot();
    expect(manager.getSessionId()).toBe(id);

    // «Стоп» посреди ответа: pi-agent-core отдаёт message_end с частичным
    // текстом и stopReason "aborted", очищает streamingMessage и дописывает
    // сообщение в транскрипт. Хвост обязан исчезнуть вместе с событием, а
    // текст — остаться в ветке ровно один раз.
    state.streamingMessage = { role: "assistant", content: [{ type: "text", text: "начал отвечать" }] };
    manager.appendMessage(assistant("начал отвечать") as any);
    const done = buffer.push(id, { type: "message_end", message: assistant("начал отвечать") } as any);
    state.streamingMessage = undefined;
    state.pendingToolCalls = new Set();

    const finished = await runtime.snapshotWithBoundary(id, () => buffer.boundary(id));
    expect(finished.live).toBeUndefined();
    expect(finished.entries).toHaveLength(1);
    expect((finished.entries[0] as any).message.content[0].text).toBe("начал отвечать");
    // Окно закрылось: точка снова на конце ленты, доигрывать нечего.
    expect(finished.eventCursor).toBe(done.cursor);

    // Сессия без состояния Pi (старая сборка, тестовый двойник): живого
    // хвоста нет, всё остальное — прежний контракт.
    const bare = new OwnerSessionRuntime({
      cwd: dir,
      sessionDir: dir,
      createSession: async sessionManager =>
        ({
          sessionManager,
          isStreaming: false,
          isIdle: true,
          model: null,
          prompt: async () => {},
          steer: async () => undefined,
          followUp: async () => undefined,
          abort: async () => {},
          waitForIdle: async () => {},
          navigateTree: async () => ({ cancelled: false }),
          subscribe: () => () => {},
          dispose: () => {},
        }) as any,
    });
    const plain = await bare.snapshotWithBoundary(id, () => buffer.boundary(id));
    expect(plain.live).toBeUndefined();
    expect(plain.eventCursor).toBe(buffer.boundary().cursor);
  });
});
