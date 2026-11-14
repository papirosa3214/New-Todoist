/**
 * To Do List Pi в сессиях владельца (14.11.2026).
 *
 * Проверяется ровно то, что сервер обещает клиенту, а не внутренности
 * расширения:
 *  1. ветка без записи `todo` — пустой список и `available: false`, а не
 *     ошибка (новая сессия выглядит так же, как сессия без задач);
 *  2. состояние берётся из ПОСЛЕДНЕЙ записи `todo`, надгробия не отдаются,
 *     счётчики считаются по живым задачам, чужие результаты не мешают;
 *  3. маршрут `GET /api/sessions/:id/todos` читает файл сессии и отдаёт
 *     готовый список, а неизвестная сессия — 404 (не пустой список).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { sessionTodosFromEntries } from "../src/runtime/ownerSessionTodos.js";
import { registerOwnerSessionTodosRoutes } from "../src/routes/owner-session-todos.js";

function todoEntry(id: string, timestamp: string, details: unknown, toolName = "todo") {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId: "call-" + id,
      toolName,
      content: [{ type: "text", text: "ok" }],
      details,
      isError: false,
      timestamp: Date.parse(timestamp),
    },
  };
}

describe("To Do List Pi: разбор ветки сессии", () => {
  it("без записи todo список пуст, но сессия жива", () => {
    const todos = sessionTodosFromEntries("s1", [
      { type: "message", id: "e1", parentId: null, timestamp: "2026-11-14T10:00:00.000Z", message: { role: "user", content: "привет" } },
    ]);
    expect(todos.available).toBe(false);
    expect(todos.tasks).toEqual([]);
    expect(todos.entryId).toBeNull();
    expect(todos.counts).toEqual({ pending: 0, in_progress: 0, completed: 0 });
  });

  it("побеждает последняя запись todo; надгробия и чужие результаты не попадают в список", () => {
    const entries = [
      todoEntry("e1", "2026-11-14T10:00:00.000Z", {
        tasks: [{ id: 1, subject: "Старый шаг", status: "pending" }],
        nextId: 2,
      }),
      todoEntry("e2", "2026-11-14T10:01:00.000Z", {
        tasks: [{ id: 9, subject: "Чужой инструмент", status: "pending" }],
        nextId: 10,
      }, "read"),
      todoEntry("e3", "2026-11-14T10:02:00.000Z", {
        tasks: [
          { id: 1, subject: "Собрать факты", status: "completed" },
          { id: 2, subject: "Проверить маршрут", status: "in_progress", activeForm: "проверяю маршрут" },
          { id: 3, subject: "Снять надгробие", status: "deleted" },
          { id: 4, subject: "Сдать отчёт", status: "pending", blockedBy: [2] },
        ],
        nextId: 5,
      }),
    ];
    const todos = sessionTodosFromEntries("s1", entries);
    expect(todos.available).toBe(true);
    expect(todos.entryId).toBe("e3");
    expect(todos.updatedAt).toBe("2026-11-14T10:02:00.000Z");
    expect(todos.nextId).toBe(5);
    expect(todos.tasks.map((task) => [task.id, task.subject, task.status])).toEqual([
      [1, "Собрать факты", "completed"],
      [2, "Проверить маршрут", "in_progress"],
      [4, "Сдать отчёт", "pending"],
    ]);
    expect(todos.tasks[1].activeForm).toBe("проверяю маршрут");
    expect(todos.tasks[2].blockedBy).toEqual([2]);
    expect(todos.counts).toEqual({ pending: 1, in_progress: 1, completed: 1 });
  });
});

describe("GET /api/sessions/:id/todos", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-todos-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function app() {
    const instance = Fastify();
    registerOwnerSessionTodosRoutes(instance, {
      sessionDir: dir,
      authorize: async (request: any) => {
        request.userId = "u1";
      },
      isOwner: () => true,
    });
    return instance;
  }

  it("отдаёт готовый список сессии и 404 на неизвестную", async () => {
    const manager = SessionManager.create(dir, dir);
    const sessionId = manager.getSessionId();
    // Файл сессии появляется с первой репликой разговора: одна запись
    // инструмента без хода файла не создаёт (SessionManager._persist).
    manager.appendMessage({ role: "user", content: "поехали", timestamp: Date.now() } as any);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "todo",
      content: [{ type: "text", text: "ok" }],
      details: { tasks: [{ id: 1, subject: "Сдать отчёт", status: "in_progress" }], nextId: 2 },
      isError: false,
      timestamp: Date.now(),
    } as any);

    const found = await app().inject({ method: "GET", url: `/api/sessions/${sessionId}/todos` });
    expect(found.statusCode).toBe(200);
    const body = JSON.parse(found.body);
    expect(body.todos.sessionId).toBe(sessionId);
    expect(body.todos.available).toBe(true);
    expect(body.todos.tasks).toEqual([{ id: 1, subject: "Сдать отчёт", status: "in_progress" }]);
    expect(body.todos.counts.in_progress).toBe(1);

    const missing = await app().inject({ method: "GET", url: "/api/sessions/nope/todos" });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body).error).toBe("session_not_found");
  });
});
