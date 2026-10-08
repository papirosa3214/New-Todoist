import { LiveTurn, type LiveTurnSnapshot } from "./chatLiveTurn.js";

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
}) {
  taskLiveTurns(args.taskId);
  const id = key(args.taskId, args.subtaskId ?? null);
  let live: LiveTurn;
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
    const snapshot: TaskLiveSnapshot = {
      task_id: args.taskId, subtask_id: args.subtaskId ?? null, run_id: args.runId,
      complete: turn === null, turn: finalTurn,
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
