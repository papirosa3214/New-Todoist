/** Журнал исходов наблюдателя памяти — для экрана статистики. */
import { randomUUID } from "node:crypto";
import db from "../db.js";
import { getSetting } from "./serverSettings.js";
import { DEFAULT_EMBEDDING_MODEL, getEmbeddings } from "./embeddingClient.js";

export type MemoryObserverOutcome =
  | "wrote"
  | "skip"
  | "disabled"
  | "not_done"
  | "no_role"
  | "already"
  | "model"
  | "low_confidence"
  | "similar"
  | "parse_error";

export type MemoryObserverEventInput = {
  outcome: MemoryObserverOutcome;
  role_key?: string | null;
  task_id?: string | null;
  subtask_id?: string | null;
  source_ref?: string | null;
  confidence?: number | null;
  title?: string | null;
  detail?: string | null;
};

export function recordMemoryObserverEvent(input: MemoryObserverEventInput): void {
  try {
    db.prepare(
      `INSERT INTO memory_observer_events
         (id, outcome, role_key, task_id, subtask_id, source_ref, confidence, title, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.outcome,
      input.role_key ?? null,
      input.task_id ?? null,
      input.subtask_id ?? null,
      input.source_ref ?? null,
      input.confidence ?? null,
      input.title ? String(input.title).slice(0, 200) : null,
      input.detail ? String(input.detail).slice(0, 500) : null,
    );
  } catch (error) {
    console.warn(
      "[memory-observer-log]",
      error instanceof Error ? error.message : error,
    );
  }
}

export type MemoryObserverStats = {
  days: number;
  embedding: {
    model: string;
    timeout_ms: number;
    ok: boolean;
    dim: number | null;
    error: string | null;
  };
  duplicate_similarity: number;
  counts: Record<string, number>;
  recent: Array<{
    id: string;
    created_at: string;
    outcome: string;
    role_key: string | null;
    task_id: string | null;
    subtask_id: string | null;
    source_ref: string | null;
    confidence: number | null;
    title: string | null;
    detail: string | null;
  }>;
};

export async function memoryObserverStats(days = 7): Promise<MemoryObserverStats> {
  const safeDays = Math.min(90, Math.max(1, Math.floor(Number(days) || 7)));
  const model = String(getSetting("embedding_model") || DEFAULT_EMBEDDING_MODEL);
  const timeout_ms = Number(getSetting("embedding_timeout_ms") ?? 30_000);
  const duplicate_similarity = Number(getSetting("memory_duplicate_similarity") ?? 92);

  let ok = false;
  let dim: number | null = null;
  let error: string | null = null;
  try {
    const result = await getEmbeddings("ping", { model, timeoutMs: Math.min(timeout_ms, 15_000) });
    const vec = result.embeddings as number[];
    if (Array.isArray(vec) && vec.length > 0) {
      ok = true;
      dim = vec.length;
    } else {
      error = "пустой вектор";
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const cutoff = `-${safeDays} days`;
  const rows = db
    .prepare(
      `SELECT outcome, COUNT(*) AS n FROM memory_observer_events
        WHERE created_at >= datetime('now', ?)
        GROUP BY outcome`,
    )
    .all(cutoff) as Array<{ outcome: string; n: number }>;
  const counts: Record<string, number> = { total: 0 };
  for (const row of rows) {
    counts[row.outcome] = row.n;
    counts.total += row.n;
  }

  const recent = db
    .prepare(
      `SELECT id, created_at, outcome, role_key, task_id, subtask_id, source_ref, confidence, title, detail
         FROM memory_observer_events
        WHERE created_at >= datetime('now', ?)
        ORDER BY created_at DESC, rowid DESC
        LIMIT 40`,
    )
    .all(cutoff) as MemoryObserverStats["recent"];

  return {
    days: safeDays,
    embedding: { model, timeout_ms, ok, dim, error },
    duplicate_similarity,
    counts,
    recent,
  };
}
