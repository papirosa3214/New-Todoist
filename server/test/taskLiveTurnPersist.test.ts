// Живой ход роли переживает конец прогона (владелец 02.11.2026):
// «информация сохранялась и была мне доступна в том виде, в котором она мне
// доступна, пока роль работает. До тех пор, пока задача не закрыта, чтобы я
// мог смотреть историю, кто что сделал, кто где, на чем проебался».
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { beginTaskLiveTurn, taskLiveTurns } from "../src/runtime/taskLiveTurn.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  // buildApp поднимает схему (миграции) в тестовой базе.
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

describe("живой ход по задаче", () => {
  it("после конца роли ход остаётся: в журнале и в ответе", () => {
    const taskId = "live-turn-task";
    const subtaskId = "live-turn-slot";
    const live = beginTaskLiveTurn({
      taskId,
      subtaskId,
      runId: "live-turn-run",
      userId: "u1",
      name: "Архитектор",
      publish: () => {},
    });
    live.onEvent({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "lt-1",
      args: { path: "src/index.ts" },
    });
    // Роль отработала — ход закрыт.
    live.finish();

    // Снимок лёг в журнал: он живёт вместе с задачей.
    const row = db.prepare(
      "SELECT COUNT(*) AS n FROM task_live_turn_snapshots WHERE task_id = ? AND subtask_id = ?",
    ).get(taskId, subtaskId) as { n: number };
    expect(row.n).toBe(1);

    // И отдаётся тем же списком, что и живой ход, — клиенту не нужно знать,
    // что роль закончилась.
    const snapshots = taskLiveTurns(taskId);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].subtask_id).toBe(subtaskId);
    expect(snapshots[0].complete).toBe(true);
    expect(snapshots[0].turn.items.length).toBeGreaterThan(0);
    expect(snapshots[0].turn.items[0].kind).toBe("step");
  });
  it("в сохраняемый снимок блоки не входят", () => {
    const taskId = "live-turn-no-blocks";
    const live = beginTaskLiveTurn({ taskId, subtaskId: null, runId: "r-nb", userId: "u1", name: "Разработчик", publish: () => {} });
    live.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Текст без блоков в журнале." } });
    live.finish();
    const row = db.prepare(
      "SELECT payload_json FROM task_live_turn_snapshots WHERE task_id = ?",
    ).get(taskId) as { payload_json: string };
    const textItem = (JSON.parse(row.payload_json) as { turn: { items: Array<{ kind: string; blocks?: unknown[] }> } })
      .turn.items.find((it) => it.kind === "text");
    expect(textItem).toBeTruthy();
    expect(textItem!.blocks).toBeUndefined();
  });

  it("живой ход в памяти свежее журнала", () => {
    const taskId = "live-turn-task-2";
    const live = beginTaskLiveTurn({
      taskId,
      subtaskId: null,
      runId: "run-2",
      userId: "u1",
      name: "Разработчик",
      publish: () => {},
    });
    live.onEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "lt-2", args: { command: "ls" } });
    const snapshots = taskLiveTurns(taskId);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].complete).toBe(false);
    live.finish();
  });
});
