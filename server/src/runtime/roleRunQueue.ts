import crypto from "node:crypto";
import db from "../db.js";

export const ROLE_RUN_REASONS = [
  "assigned",
  "commented",
  "review",
  "after_run",
] as const;

export type RoleRunReason = (typeof ROLE_RUN_REASONS)[number];
export type RoleRunJobStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "skipped"
  | "dead"
  | "cancelled";

export type RoleRunJob = {
  id: string;
  task_id: string;
  reason: RoleRunReason;
  actor_id: string | null;
  dedupe_key: string;
  status: RoleRunJobStatus;
  attempts: number;
  max_attempts: number;
  chain_depth: number;
  manual_start: number;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Записать повод запуска. Функция синхронная, поэтому caller может вызвать её
 * внутри своей better-sqlite3 transaction: изменение карточки и job тогда
 * коммитятся или откатываются вместе.
 */
export function enqueueRoleRunJob(input: {
  taskId: string;
  reason: RoleRunReason;
  actorId?: string | null;
  dedupeKey: string;
  maxAttempts?: number;
  chainDepth?: number;
  manualStart?: boolean;
}): { id: string; created: boolean } {
  const id = `rrj_${crypto.randomUUID()}`;
  const result = db
    .prepare(
      `INSERT INTO role_run_jobs
         (id, task_id, reason, actor_id, dedupe_key, max_attempts, chain_depth, manual_start)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO NOTHING`,
    )
    .run(
      id,
      input.taskId,
      input.reason,
      input.actorId ?? null,
      input.dedupeKey,
      input.maxAttempts ?? 3,
      input.chainDepth ?? 0,
      input.manualStart ? 1 : 0,
    );
  if (result.changes > 0) return { id, created: true };

  const existing = db
    .prepare("SELECT id FROM role_run_jobs WHERE dedupe_key = ?")
    .get(input.dedupeKey) as { id: string };
  return { id: existing.id, created: false };
}

/** Вернуть просроченные claims в очередь после падения/рестарта worker. */
export function recoverExpiredRoleRunJobs(): number {
  return db
    .prepare(
      `UPDATE role_run_jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
              available_at = datetime('now'),
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = CASE
                WHEN last_error IS NULL THEN 'lease expired before completion'
                ELSE last_error
              END,
              finished_at = CASE WHEN attempts >= max_attempts THEN datetime('now') ELSE NULL END,
              updated_at = datetime('now')
        WHERE status = 'running'
          AND lease_expires_at <= datetime('now')`,
    )
    .run().changes;
}

/**
 * Атомарно взять один готовый job. Пока по задаче уже есть живой running job,
 * следующий повод той же задачи не claim-ится и сохраняет порядок.
 */
export function claimNextRoleRunJob(input: {
  workerId: string;
  leaseSeconds?: number;
}): RoleRunJob | null {
  const leaseSeconds = Math.max(0, Math.floor(input.leaseSeconds ?? 120));
  const claim = db.transaction(() => {
    recoverExpiredRoleRunJobs();
    const candidate = db
      .prepare(
        `SELECT id
           FROM role_run_jobs AS candidate
          WHERE candidate.status IN ('queued', 'retry_wait')
            AND candidate.available_at <= datetime('now')
            AND NOT EXISTS (
              SELECT 1
                FROM role_run_jobs AS active
               WHERE active.task_id = candidate.task_id
                 AND active.status = 'running'
            )
          ORDER BY candidate.available_at, candidate.created_at, candidate.rowid
          LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (!candidate) return null;

    const modifier = `+${leaseSeconds} seconds`;
    const updated = db
      .prepare(
        `UPDATE role_run_jobs
            SET status = 'running',
                attempts = attempts + 1,
                lease_owner = ?,
                lease_expires_at = datetime('now', ?),
                started_at = COALESCE(started_at, datetime('now')),
                finished_at = NULL,
                updated_at = datetime('now')
          WHERE id = ?
            AND status IN ('queued', 'retry_wait')
            AND available_at <= datetime('now')`,
      )
      .run(input.workerId, modifier, candidate.id);
    if (updated.changes !== 1) return null;
    return db
      .prepare("SELECT * FROM role_run_jobs WHERE id = ?")
      .get(candidate.id) as RoleRunJob;
  });
  return claim();
}

export function renewRoleRunJob(input: {
  jobId: string;
  workerId: string;
  leaseSeconds?: number;
}): boolean {
  const leaseSeconds = Math.max(1, Math.floor(input.leaseSeconds ?? 120));
  return (
    db
      .prepare(
        `UPDATE role_run_jobs
            SET lease_expires_at = datetime('now', ?),
                updated_at = datetime('now')
          WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(`+${leaseSeconds} seconds`, input.jobId, input.workerId).changes === 1
  );
}

export function completeRoleRunJob(input: {
  jobId: string;
  workerId: string;
  status: "succeeded" | "skipped";
}): boolean {
  return (
    db
      .prepare(
        `UPDATE role_run_jobs
            SET status = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = NULL,
                finished_at = datetime('now'),
                updated_at = datetime('now')
          WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(input.status, input.jobId, input.workerId).changes === 1
  );
}

/**
 * Вернуть job в ожидание без расходования попытки. Это не техническое
 * падение: например, владелец временно выключил автономную «Систему» или
 * ручной запуск уже держит ту же карточку.
 */
export function deferRoleRunJob(input: {
  jobId: string;
  workerId: string;
  reason: string;
  delaySeconds?: number;
}): boolean {
  const delay = Math.max(1, Math.floor(input.delaySeconds ?? 30));
  return (
    db
      .prepare(
        `UPDATE role_run_jobs
            SET status = 'retry_wait',
                attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
                available_at = datetime('now', ?),
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = ?,
                updated_at = datetime('now')
          WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(
        `+${delay} seconds`,
        input.reason.slice(0, 1000),
        input.jobId,
        input.workerId,
      ).changes === 1
  );
}

export function failRoleRunJob(input: {
  jobId: string;
  workerId: string;
  error: unknown;
  retryDelaySeconds?: number;
}): "retry_wait" | "dead" | null {
  const row = db
    .prepare(
      `SELECT attempts, max_attempts
         FROM role_run_jobs
        WHERE id = ? AND status = 'running' AND lease_owner = ?`,
    )
    .get(input.jobId, input.workerId) as
    | { attempts: number; max_attempts: number }
    | undefined;
  if (!row) return null;

  const nextStatus = row.attempts >= row.max_attempts ? "dead" : "retry_wait";
  const defaultDelay = Math.min(300, 5 * 2 ** Math.max(0, row.attempts - 1));
  const delay = Math.max(0, Math.floor(input.retryDelaySeconds ?? defaultDelay));
  const message = (input.error instanceof Error
    ? input.error.message
    : String(input.error)
  ).slice(0, 1000);

  db.prepare(
    `UPDATE role_run_jobs
        SET status = ?,
            available_at = CASE WHEN ? = 'retry_wait' THEN datetime('now', ?) ELSE available_at END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = ?,
            finished_at = CASE WHEN ? = 'dead' THEN datetime('now') ELSE NULL END,
            updated_at = datetime('now')
      WHERE id = ? AND status = 'running' AND lease_owner = ?`,
  ).run(
    nextStatus,
    nextStatus,
    `+${delay} seconds`,
    message,
    nextStatus,
    input.jobId,
    input.workerId,
  );
  return nextStatus;
}

export function getRoleRunJob(id: string): RoleRunJob | undefined {
  return db.prepare("SELECT * FROM role_run_jobs WHERE id = ?").get(id) as
    | RoleRunJob
    | undefined;
}

export function listRoleRunJobs(input?: {
  taskId?: string;
  limit?: number;
}): RoleRunJob[] {
  const limit = Math.min(200, Math.max(1, Math.floor(input?.limit ?? 50)));
  if (input?.taskId) {
    return db
      .prepare(
        `SELECT * FROM role_run_jobs
          WHERE task_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(input.taskId, limit) as RoleRunJob[];
  }
  return db
    .prepare(
      `SELECT * FROM role_run_jobs
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(limit) as RoleRunJob[];
}

export function retryRoleRunJob(id: string): RoleRunJob | undefined {
  const changed = db
    .prepare(
      `UPDATE role_run_jobs
          SET status = 'queued',
              attempts = 0,
              available_at = datetime('now'),
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              started_at = NULL,
              finished_at = NULL,
              updated_at = datetime('now')
        WHERE id = ? AND status IN ('dead', 'cancelled', 'skipped')`,
    )
    .run(id);
  return changed.changes === 1 ? getRoleRunJob(id) : undefined;
}

/** Running job здесь намеренно не отменяется: для него нужен подтверждённый
 * abort протокол конкретной Pi-сессии. API возвращает conflict вместо лжи. */
export function cancelPendingRoleRunJob(id: string): RoleRunJob | undefined {
  const changed = db
    .prepare(
      `UPDATE role_run_jobs
          SET status = 'cancelled',
              lease_owner = NULL,
              lease_expires_at = NULL,
              finished_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ? AND status IN ('queued', 'retry_wait')`,
    )
    .run(id);
  return changed.changes === 1 ? getRoleRunJob(id) : undefined;
}
