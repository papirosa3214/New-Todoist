import crypto from "node:crypto";
import db from "../db.js";
import { logServerEvent } from "../lib/serverEvents.js";

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
         (id, task_id, reason, actor_id, dedupe_key, max_attempts, chain_depth, manual_start, status, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?,
         CASE WHEN (SELECT archived_at FROM tasks WHERE id = ?) IS NOT NULL THEN 'cancelled' ELSE 'queued' END,
         CASE WHEN (SELECT archived_at FROM tasks WHERE id = ?) IS NOT NULL THEN datetime('now') ELSE NULL END)
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
      input.taskId,
      input.taskId,
    );
  if (result.changes > 0) {
    const cancelled = getRoleRunJob(id)?.status === "cancelled";
    logServerEvent({
      scope: "queue",
      kind: cancelled ? "queue_cancelled" : "queue_enqueued",
      taskId: input.taskId,
      actorId: input.actorId ?? null,
      subtype: input.reason,
      message: cancelled
        ? "запуск отменён: задача архивирована"
        : `роль встала в очередь: ${input.reason}`,
      data: {
        job_id: id,
        reason: input.reason,
        dedupe_key: input.dedupeKey,
        max_attempts: input.maxAttempts ?? 3,
        manual_start: input.manualStart ? 1 : 0,
      },
    });
    return { id, created: true };
  }

  const existing = db
    .prepare("SELECT id FROM role_run_jobs WHERE dedupe_key = ?")
    .get(input.dedupeKey) as { id: string };
  return { id: existing.id, created: false };
}

/** Вернуть просроченные claims в очередь после падения/рестарта worker. */
export function recoverExpiredRoleRunJobs(): number {
  // Серверный журнал: считаем, сколько вернулось, и каждую строку помечаем
  // отдельным событием — без этого нельзя понять, «почему очередь дёрнулась»
  // (карточка e87cd93f). Читаем «до» список, чтобы записать именно те id,
  // которые мы и восстановили, а не свежие рекавери за прошлые тики.
  const expired = db
    .prepare(
      `SELECT id, task_id, attempts, max_attempts
         FROM role_run_jobs
        WHERE status = 'running'
          AND lease_expires_at <= datetime('now')`,
    )
    .all() as Array<{
    id: string;
    task_id: string;
    attempts: number;
    max_attempts: number;
  }>;
  if (expired.length === 0) return 0;
  const changed = db
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
  for (const row of expired) {
    logServerEvent({
      scope: "queue",
      kind: "queue_expired",
      taskId: row.task_id,
      subtype: row.attempts >= row.max_attempts ? "dead" : "requeued",
      message: `job ${row.id} просрочен (${
        row.attempts >= row.max_attempts
          ? "лимит исчерпан — dead"
          : "возврат в очередь"
      })`,
      data: {
        job_id: row.id,
        attempts: row.attempts,
        max_attempts: row.max_attempts,
      },
      outcome: row.attempts >= row.max_attempts ? "err" : "ok",
    });
  }
  return changed;
}

/**
 * Атомарно взять один готовый job. Пока по задаче уже есть живой running job,
 * следующий повод той же задачи не claim-ится и сохраняет порядок.
 *
 * Архивные задачи (карточка 57c69735…) сразу отбрасываются на этом шаге —
 * даже если у них ещё висит pending job, worker её не подхватит. Дополнительно
 * `archiveTask` отменяет queued/retry_wait job’и при архивировании, но
 * гонку между archive и race здесь ловит именно JOIN на tasks.
 */
export function claimNextRoleRunJob(input: {
  workerId: string;
  leaseSeconds?: number;
}): RoleRunJob | null {
  const leaseSeconds = Math.max(0, Math.floor(input.leaseSeconds ?? 120));
  const claim = db.transaction(() => {
    recoverExpiredRoleRunJobs();
    // Archive can precede enqueue or recovery. Keep the audit rows, but
    // terminate pending work that can never be claimed.
    db.prepare(
      `UPDATE role_run_jobs SET status='cancelled',
      lease_owner=NULL, lease_expires_at=NULL, finished_at=datetime('now'),
      updated_at=datetime('now'), last_error='task archived'
      WHERE status IN ('queued','retry_wait') AND task_id IN
        (SELECT id FROM tasks WHERE archived_at IS NOT NULL)`,
    ).run();
    const candidate = db
      .prepare(
        `SELECT candidate.id
           FROM role_run_jobs AS candidate
           JOIN tasks t ON t.id = candidate.task_id
          WHERE candidate.status IN ('queued', 'retry_wait')
            AND candidate.available_at <= datetime('now')
            AND t.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1
                FROM role_run_jobs AS active
               WHERE active.task_id = candidate.task_id
                 AND active.status = 'running'
            )
          -- Ответ на комментарий не задерживает движение по плану
          -- (сдача на проверку, передача шага): 20.10.2026 запуск критика
          -- ждал 9,5 минуты за пятью ответами на проверочные комментарии.
          ORDER BY CASE candidate.reason WHEN 'commented' THEN 1 ELSE 0 END,
                   candidate.available_at, candidate.created_at, candidate.rowid
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
      .run(`+${leaseSeconds} seconds`, input.jobId, input.workerId).changes ===
    1
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
    { attempts: number; max_attempts: number } | undefined;
  if (!row) return null;

  const nextStatus = row.attempts >= row.max_attempts ? "dead" : "retry_wait";
  const defaultDelay = Math.min(300, 5 * 2 ** Math.max(0, row.attempts - 1));
  const delay = Math.max(
    0,
    Math.floor(input.retryDelaySeconds ?? defaultDelay),
  );
  const message = (
    input.error instanceof Error ? input.error.message : String(input.error)
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
    RoleRunJob | undefined;
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

/**
 * Группа задания: часть dedupe-ключа, которая отвечает за СМЫСЛ задания.
 * Ключи строятся как `<вид>:<объект>[:<подпись>]`:
 *   `stalled-restart:<subtaskId>` — автоперезапуск шага (ключ стабильный);
 *   `review:<taskId>:<token>`    — задача ушла на проверку;
 *   `ready:<taskId>:<token>`     — владелец поднял флаг готовности.
 * Подпись после второго двоеточия — переменная часть (id попытки, номер
 * захода), а группа — постоянная: «тот же шаг», «та же карточка».
 */
export function roleRunJobGroup(dedupeKey: string): string | null {
  const match = /^(stalled-restart|review|ready):([^:]+)(?::|$)/.exec(dedupeKey);
  return match ? `${match[1]}:${match[2]}` : null;
}

/**
 * Вернуть существующее задание в очередь.
 *
 * Нужно для автоперезапуска зависшего шага: ключ дедупликации стабилен
 * (одна строка на шаг), поэтому следующий заход роли должен ПЕРЕИСПОЛЬЗОВАТЬ
 * то же задание. Без этого «стабильный ключ» означал бы «задание выполнится
 * один раз и больше никогда» (Г1-к, 06.10.2026: worker возвращал прежнее
 * задание в состоянии `succeeded`).
 *
 * Задание в работе (`running`) или уже стоящее в очереди не трогаем.
 */
export function rearmRoleRunJob(dedupeKey: string): boolean {
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
        WHERE dedupe_key = ?
          AND status IN ('succeeded', 'dead', 'cancelled', 'skipped')`,
    )
    .run(dedupeKey);
  return changed.changes === 1;
}

/**
 * Сверка лавины в очереди ролей (карточка 568a2b93).
 *
 * Накопившиеся дубли одного и того же намерения (например, 438 заданий
 * `after_run` на две карточки) занимают очередь и не дают ролям стартовать.
 * При старте сервера оставляем по ОДНОМУ заданию на группу (самое свежее —
 * оно отражает последнее намерение), остальные переводим в `cancelled`.
 * Задания без понятной группы (прочие причины) не трогаем: их склеивать
 * не с чем.
 *
 * Возвращает число свёрнутых дублей.
 */
export function collapseDuplicateQueuedJobs(): number {
  const rows = db
    .prepare(
      `SELECT id, dedupe_key FROM role_run_jobs
        WHERE status IN ('queued', 'retry_wait')
        ORDER BY created_at, rowid`,
    )
    .all() as Array<{ id: string; dedupe_key: string }>;
  const kept = new Map<string, string>();
  const duplicates: string[] = [];
  for (const row of rows) {
    const group = roleRunJobGroup(row.dedupe_key);
    if (!group) continue;
    const previous = kept.get(group);
    // Из группы выживает самое свежее задание (оно отражает последнее
    // намерение), все предыдущие уходят в cancelled.
    if (previous) duplicates.push(previous);
    kept.set(group, row.id);
  }
  if (duplicates.length === 0) return 0;
  const cancel = db.prepare(
    `UPDATE role_run_jobs
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            finished_at = datetime('now'),
            updated_at = datetime('now'),
            last_error = 'дубль задания свёрнут при старте сервера'
      WHERE id = ? AND status IN ('queued', 'retry_wait')`,
  );
  const apply = db.transaction((ids: string[]) => {
    let changed = 0;
    for (const id of ids) changed += cancel.run(id).changes;
    return changed;
  });
  const changed = apply(duplicates);
  if (changed > 0) {
    logServerEvent({
      scope: "queue",
      kind: "queue_duplicates_collapsed",
      taskId: null,
      actorId: null,
      subtype: "startup",
      message: `дублей заданий очереди ролей свёрнуто: ${changed}`,
      data: { collapsed: changed },
    });
  }
  return changed;
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
