// Архив, возврат и удаление карточки TaskFlow, пришедшей из Linear, —
// то же в Linear (владелец 14.10.2026): «что есть в TaskFlow, то есть и в
// Linear». Удаление в Linear — в корзину (30 дней можно вернуть) и запись в
// «не заводить», чтобы автоимпорт не вернул задачу.
import crypto from "node:crypto";
import db from "../db.js";

export type LifecycleOp = "archive" | "unarchive" | "delete";
const OPPOSITE: Record<LifecycleOp, LifecycleOp[]> = { archive: ["unarchive"], unarchive: ["archive"], delete: ["archive", "unarchive"] };

/** Поставить задания для связанных с Linear карточек из списка. */
export function enqueueLinearLifecycle(taskIds: string[], op: LifecycleOp): number {
  if (!taskIds.length) return 0;
  const rows = db.prepare(`SELECT owner_id, workspace_id, source_id FROM linear_import_tasks WHERE task_id IN (${taskIds.map(() => "?").join(",")})`)
    .all(...taskIds) as Array<{ owner_id: string; workspace_id: string; source_id: string }>;
  db.transaction(() => {
    for (const r of rows) {
      // Последнее действие владельца побеждает: архив отменяет ждущий возврат и наоборот.
      db.prepare(`DELETE FROM linear_lifecycle_queue WHERE issue_id = ? AND status = 'pending' AND operation IN (${OPPOSITE[op].map(() => "?").join(",")})`)
        .run(r.source_id, ...OPPOSITE[op]);
      db.prepare("INSERT INTO linear_lifecycle_queue(id, owner_id, workspace_id, issue_id, operation) VALUES (?,?,?,?,?)")
        .run(crypto.randomUUID(), r.owner_id, r.workspace_id, r.source_id, op);
      if (op === "delete") {
        db.prepare("INSERT OR IGNORE INTO linear_import_tombstones(owner_id, workspace_id, source_id, reason) VALUES (?,?,?,'удалена в TaskFlow')")
          .run(r.owner_id, r.workspace_id, r.source_id);
      }
    }
  })();
  return rows.length;
}

export function isLinearTombstoned(ownerId: string, workspaceId: string, sourceId: string): boolean {
  return !!db.prepare("SELECT 1 FROM linear_import_tombstones WHERE owner_id = ? AND workspace_id = ? AND source_id = ?").get(ownerId, workspaceId, sourceId);
}

export type LifecycleWriter = {
  archiveIssue(id: string): Promise<void>;
  unarchiveIssue(id: string): Promise<void>;
  deleteIssue(id: string): Promise<void>;
};

const MAX_ATTEMPTS = 20;
const backoff = (n: number) => Math.min(1800, 30 * 2 ** Math.max(0, n - 1));
const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

/** Разобрать созревшие задания. Не бросает: причина остаётся в задании. */
export async function runLinearLifecyclePass(writer: LifecycleWriter, now = Date.now(), limit = 20): Promise<{ sent: number; failed: number }> {
  const due = db.prepare(`SELECT * FROM linear_lifecycle_queue WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT ?`)
    .all(iso(now), limit) as Array<{ id: string; issue_id: string; operation: LifecycleOp; attempts: number }>;
  let sent = 0, failed = 0;
  for (const job of due) {
    try {
      if (job.operation === "archive") await writer.archiveIssue(job.issue_id);
      else if (job.operation === "unarchive") await writer.unarchiveIssue(job.issue_id);
      else await writer.deleteIssue(job.issue_id);
      db.prepare("UPDATE linear_lifecycle_queue SET status = 'sent', last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(job.id);
      sent++;
    } catch (error) {
      const attempts = job.attempts + 1;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      db.prepare("UPDATE linear_lifecycle_queue SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?")
        .run(attempts >= MAX_ATTEMPTS ? "failed" : "pending", attempts, iso(now + backoff(attempts) * 1000), message, job.id);
      failed++;
    }
  }
  return { sent, failed };
}
