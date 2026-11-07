/**
 * Время миссии для шапки Mission Control (владелец 05.11.2026): сколько команда
 * реально работала. Параллельные попытки не складываются, дочерние карточки входят.
 */
import db from "../db.js";
import { ensureModelUsageSchema } from "./modelUsage.js";

/** Попытка без конца и без свежего сигнала считается брошенной. */
const STALE_MS = 10 * 60_000;

type Interval = { start: number; end: number };

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function mergedSeconds(intervals: Interval[]): number {
  let total = 0;
  let current: Interval | null = null;
  for (const item of [...intervals].sort((a, b) => a.start - b.start)) {
    if (current && item.start <= current.end) {
      current.end = Math.max(current.end, item.end);
      continue;
    }
    if (current) total += current.end - current.start;
    current = { ...item };
  }
  if (current) total += current.end - current.start;
  return Math.round(total / 1000);
}

export function missionTime(taskId: string, nowMs = Date.now()): { started_at: string | null; worked_seconds: number; running: boolean; tokens: number } {
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id
       )
       SELECT started_at, ended_at, heartbeat_at FROM attempts
        WHERE task_id IN tree AND started_at IS NOT NULL
        ORDER BY started_at ASC`,
    )
    .all(taskId) as Array<{ started_at: string; ended_at: string | null; heartbeat_at: string | null }>;
  let running = false;
  let startedAt: string | null = null;
  let earliest = Number.POSITIVE_INFINITY;
  const intervals: Interval[] = [];
  for (const row of rows) {
    const start = parseTime(row.started_at);
    if (start === null) continue;
    if (start < earliest) {
      earliest = start;
      startedAt = row.started_at;
    }
    let end = parseTime(row.ended_at);
    if (end === null) {
      const signal = parseTime(row.heartbeat_at) ?? start;
      if (nowMs - signal <= STALE_MS) {
        running = true;
        end = nowMs;
      } else {
        end = signal;
      }
    }
    if (end > start) intervals.push({ start, end });
  }
  ensureModelUsageSchema();
  // Ввод и вывод модели, без кэша: кэш многократно считает один и тот же контекст.
  const usage = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id
       )
       SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM model_usage WHERE task_id IN tree`,
    )
    .get(taskId) as { tokens: number };
  return { started_at: startedAt, worked_seconds: mergedSeconds(intervals), running, tokens: usage.tokens };
}
