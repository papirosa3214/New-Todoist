import { LiveTurn, type LiveTurnSnapshot } from "./chatLiveTurn.js";
import { liveDeltaOps, type LiveView } from "./chatLiveDelta.js";

export interface TaskLiveSnapshot {
  task_id: string;
  subtask_id: string | null;
  run_id: string;
  complete: boolean;
  turn: LiveTurnSnapshot;
}
const turns = new Map<string, { snapshot: TaskLiveSnapshot; updated: number }>();
const key = (task: string, subtask: string | null) => JSON.stringify([task, subtask]);
const TTL = 30 * 60_000;

export function taskLiveTurns(taskId: string): TaskLiveSnapshot[] {
  const now = Date.now();
  // Completed snapshots are short-lived reconnect support, not report storage.
  while (turns.size > 200) {
    const oldest = [...turns.entries()].filter(([, e]) => e.snapshot.complete)
      .sort((a, b) => a[1].updated - b[1].updated)[0];
    if (!oldest) break;
    turns.delete(oldest[0]);
  }
  for (const [id, entry] of turns) {
    if (entry.snapshot.complete && now - entry.updated > TTL) turns.delete(id);
  }
  return [...turns.values()].filter(e => e.snapshot.task_id === taskId).map(e => e.snapshot);
}

/** Shares the chat event parser, never registers or broadcasts a chat turn. */
export function beginTaskLiveTurn(args: {
  taskId: string; subtaskId?: string; runId: string; userId: string; name: string;
  publish: (snapshot: TaskLiveSnapshot) => void;
  /** Ход шага дельтами (27.10.2026): tasks:live:start/patch/end рядом со
   *  старым полным снимком. Поля как у чата — клиент разбирает их тем же
   *  обработчиком: turn_id — прогон, chat_id — задача. */
  publishDelta?: (event: Record<string, unknown>) => void;
}) {
  taskLiveTurns(args.taskId);
  const id = key(args.taskId, args.subtaskId ?? null);
  let live: LiveTurn;
  let seq = 0, started = false, sentView: LiveView | null = null;
  const ids = { chat_id: args.taskId, task_id: args.taskId, subtask_id: args.subtaskId ?? null, run_id: args.runId, turn_id: args.runId, user_id: args.userId };
  const sendDelta = (turn: LiveTurnSnapshot, complete: boolean) => {
    if (!args.publishDelta) return;
    if (!started) {
      started = true;
      args.publishDelta({ type: "tasks:live:start", ...ids, name: args.name, started_at: turn.started_at, message_id: null, seq: 0 });
    }
    const view: LiveView = { items: turn.items.map((it) => ({ ...it, id: (it as { id?: string }).id ?? "" })), thinking: turn.thinking };
    const ops = liveDeltaOps(sentView, view);
    if (ops.length) {
      sentView = view;
      args.publishDelta({ type: "tasks:live:patch", ...ids, seq: ++seq, ops });
    }
    if (complete) args.publishDelta({ type: "tasks:live:end", ...ids, seq: ++seq, message_id: null });
  };
  const send = (turn: LiveTurnSnapshot | null) => {
    if (turns.get(id)?.snapshot.run_id !== args.runId) return;
    const finalTurn = turn ?? live.snapshot();
    if (turn === null) {
      for (const item of finalTurn.items) {
        if (item.kind === "step" && item.status === "running") {
          item.status = "error"; item.ended_at = new Date().toISOString();
        }
      }
    }
    sendDelta(finalTurn, turn === null);
    const snapshot: TaskLiveSnapshot = {
      task_id: args.taskId, subtask_id: args.subtaskId ?? null, run_id: args.runId,
      complete: turn === null,
      turn: args.publishDelta ? { ...finalTurn, turn_id: args.runId, message_id: null, seq } : finalTurn,
    };
    turns.set(id, { snapshot, updated: Date.now() });
    args.publish(snapshot);
  };
  live = new LiveTurn({
    chatId: args.taskId, userId: args.userId, name: args.name, audience: () => [],
    publish: send,
  });
  turns.set(id, { snapshot: {
    task_id: args.taskId, subtask_id: args.subtaskId ?? null, run_id: args.runId,
    complete: false, turn: live.snapshot(),
  }, updated: Date.now() });
  send(live.snapshot());
  return live;
}
