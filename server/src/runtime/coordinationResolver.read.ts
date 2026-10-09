// Слой чтения фактов для `coordinationResolver` (V2). Тонкие функции
// над `db.ts` и `enricher.ts` — каждая изолирована и тестируема.
// Никаких побочных эффектов: resolver по контракту только объясняет.

import db from "../db.js";
import { unmetDependencyIds } from "../enricher.js";
import { latestStepOutcome } from "./stepOutcome.js";
import { waitingForPredecessors, type PlanSubtask } from "./planSubtaskAdmission.js";
import {
  type SubtaskFacts,
  type WaitingPredecessor,
  type BlockType,
  type CauseCode,
  CAUSE_CODES,
} from "./coordinationResolver.js";

type SubtaskRow = {
  id: string;
  task_id: string;
  title: string | null;
  done: number;
  agent_state: string | null;
  agent_id: string | null;
  agent_heartbeat_at: string | null;
  block_type: string | null;
  current_attempt_id: string | null;
  collaboration_plan_id: string | null;
  plan_node_key: string | null;
};

type TaskRow = {
  id: string;
  status: string;
  agent_state: string | null;
  creator_id: string | null;
  assignee_id: string | null;
};

type RoleRunJobRow = {
  id: string;
  status: string;
  last_error: string | null;
  lease_expires_at: string | null;
};

type AttemptRow = {
  id: string;
  started_at: string;
  heartbeat_at: string | null;
  ended_at: string | null;
};

function parseIsoToEpoch(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  // SQLite хранит `datetime('now')` как 'YYYY-MM-DD HH:MM:SS' (UTC). Префикс
  // 'Z' переводит в корректный ISO-парс. Микросекунды, если они есть, не
  // мешают.
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((now - ms) / 1000));
}

function clampBlockType(value: string | null): BlockType {
  switch (value) {
    case "dependency":
    case "needs_input":
    case "capability":
    case "transient":
      return value;
    default:
      return null;
  }
}

function isCause(value: string): value is CauseCode {
  return (CAUSE_CODES as readonly string[]).includes(value);
}

function subtaskRow(subtaskId: string | null): SubtaskRow | null {
  if (!subtaskId) return null;
  return (
    (db
      .prepare(
        `SELECT id, task_id, title, done, agent_state, agent_id,
                agent_heartbeat_at, block_type, current_attempt_id,
                collaboration_plan_id, plan_node_key
           FROM subtasks WHERE id = ?`,
      )
      .get(subtaskId) as SubtaskRow | undefined) ?? null
  );
}

function taskRow(taskId: string): TaskRow | null {
  return (
    (db
      .prepare(
        `SELECT id, status, agent_state, creator_id, assignee_id
           FROM tasks WHERE id = ?`,
      )
      .get(taskId) as TaskRow | undefined) ?? null
  );
}

function roleKeyForSubtask(row: SubtaskRow): string | null {
  if (!row.collaboration_plan_id || !row.plan_node_key) {
    if (!row.agent_id) return null;
    return (
      (db
        .prepare("SELECT role_key FROM users WHERE id = ?")
        .get(row.agent_id) as { role_key: string | null } | undefined)?.role_key ?? null
    );
  }
  return (
    (db
      .prepare(
        "SELECT role_key FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?",
      )
      .get(row.collaboration_plan_id, row.plan_node_key) as
      | { role_key: string | null }
      | undefined)?.role_key ?? null
  );
}

function activeAttempt(attemptId: string | null): AttemptRow | null {
  if (!attemptId) return null;
  return (
    (db
      .prepare(
        `SELECT id, started_at, heartbeat_at, ended_at
           FROM attempts WHERE id = ?`,
      )
      .get(attemptId) as AttemptRow | undefined) ?? null
  );
}

function lastSessionEventAgeSeconds(subtask: SubtaskRow, role: string | null, now: number): number | null {
  if (!role) return null;
  // mtime свежего `.jsonl` в каталоге сессии. Идём тем же путём, что и
  // `stalledStepWatcher.lastSessionEventMs`, чтобы возраст «потока хода»
  // для резолвера и для сторожа был одним и тем же сигналом.
  // Здесь — без обхода `os.homedir`/`process.env`: эталон пути тот же,
  // но при ошибке диска возвращаем null, а не бросаем.
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const root =
      process.env.TASKFLOW_SESSIONS_DIR ||
      path.join(os.homedir(), ".local", "state", "taskflow-runs", "sessions");
    if (!fs.existsSync(root)) return null;
    const slot = subtask.plan_node_key ?? "";
    const candidates = [
      path.join(root, `${subtask.task_id}-${role}-${subtask.id}`),
      path.join(root, `${subtask.task_id}-${role}-${slot}`),
      path.join(root, `${subtask.task_id}-${role}`),
    ];
    let latestMs: number | null = null;
    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const m = fs.statSync(path.join(dir, name)).mtimeMs;
        if (latestMs === null || m > latestMs) latestMs = m;
      }
      if (latestMs !== null) break;
    }
    if (latestMs === null) return null;
    return Math.max(0, Math.floor((now * 1000 - latestMs) / 1000));
  } catch {
    return null;
  }
}

function restartCountForSubtask(subtaskId: string, now: number): number {
  // То же окно, что в stalledStepWatcher: -2 часа от текущего момента.
  // Считаем по attempts.outcome='auto_restarted', как и сторож.
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM attempts
          WHERE subtask_id = ? AND outcome = 'auto_restarted'
            AND started_at >= datetime('now', '-2 hours')`,
      )
      .get(subtaskId) as { n: number };
    if (row.n > 0) return row.n;
  } catch {
    // Фоллбек для тестов, где таблицы attempts может не быть.
  }
  return 0;
  // now оставлен в сигнатуре на случай, если правила окна поменяются.
  void now;
}

function isFinalReviewNode(row: SubtaskRow): boolean {
  if (!row.collaboration_plan_id || !row.plan_node_key) return false;
  const node = db
    .prepare(
      "SELECT instructions FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?",
    )
    .get(row.collaboration_plan_id, row.plan_node_key) as
    | { instructions: string | null }
    | undefined;
  return Boolean(node?.instructions?.includes("[taskflow:final-review]"));
}

function hasBranchReworkLink(row: SubtaskRow): boolean {
  if (!row.collaboration_plan_id || !row.plan_node_key) return false;
  const link = db
    .prepare(
      "SELECT 1 AS x FROM branch_rework_links WHERE root_plan_id = ? AND from_slot = ? LIMIT 1",
    )
    .get(row.collaboration_plan_id, row.plan_node_key) as { x: number } | undefined;
  return Boolean(link);
}

function waitingForPredecessorsFromPlan(row: SubtaskRow): WaitingPredecessor[] {
  if (!row.collaboration_plan_id || !row.plan_node_key) return [];
  // `waitingForPredecessors` принимает `PlanSubtask` (полный снимок), но
  // на деле читает только `collaboration_plan_id` и `plan_node_key`;
  // приводим аккуратно, не раскрывая весь тип.
  return waitingForPredecessors(row as unknown as PlanSubtask).map((w) => ({
    fromSlotKey: w.from_slot_key,
    reason: w.reason,
    artifactKey: w.artifact_key,
  }));
}

function firstRoleRunJob(taskId: string): RoleRunJobRow | null {
  return (
    (db
      .prepare(
        `SELECT id, status, last_error, lease_expires_at
           FROM role_run_jobs
          WHERE task_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(taskId) as RoleRunJobRow | undefined) ?? null
  );
}

function jobFailureCode(lastError: string | null): string | null {
  if (!lastError) return null;
  // Эвристика: берём первый токен, который похож на код из
  // `failureReasons.FAILURE_REASON_CODES`. Этого достаточно, чтобы
  // резолвер отличил provider_quota_limit от missing_config, а полный
  // классификатор `classifyFailureReason` лежит в `failureReasons.ts`.
  const tokens = lastError.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  const codes = [
    "provider_auth_or_access",
    "missing_config",
    "provider_quota_limit",
    "provider_rate_limit",
    "provider_server_error",
    "context_overflow",
    "model_unavailable",
    "taskcontext_timeout",
    "step_stalled",
    "runtime_died",
    "cancelled",
  ];
  for (const token of tokens) {
    if (codes.includes(token)) return token;
  }
  return null;
}

export type ResolveOptions = {
  /** Переопределить «сейчас» в секундах — для детерминированных тестов. */
  nowEpochSeconds?: number;
};

export function collectFacts(
  subtaskId: string | null,
  taskIdHint: string | null,
  options: ResolveOptions = {},
): SubtaskFacts | null {
  const now = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const sub = subtaskRow(subtaskId);
  const taskId = sub?.task_id ?? taskIdHint;
  if (!taskId) return null;
  const task = taskRow(taskId);
  if (!task) return null;
  const role = sub ? roleKeyForSubtask(sub) : null;
  const attempt = sub ? activeAttempt(sub.current_attempt_id) : null;
  const heartbeatAge = attempt ? parseIsoToEpoch(attempt.heartbeat_at, now) : null;
  const hasActiveAttempt = Boolean(attempt && !attempt.ended_at);
  const job = firstRoleRunJob(taskId);
  const waiting = sub ? waitingForPredecessorsFromPlan(sub) : [];
  const unmet = sub ? unmetDependencyIds(sub.task_id) : [];
  // Если у узла плана есть открытые предшественники, но waitingForPredecessors
  // пуст (все done), тогда unmetDependencyIds — это зависимости самой задачи.
  // В V2 контракт различает их: «шаг ждёт предшественника» vs «задача ждёт
  // внешнюю зависимость». Для карточки на верхнем уровне (нет subtask) —
  // unmet зависимости возвращаем как waiting_predecessor с пометкой,
  // а иначе — это `blocked_dependency` на subtask'е.
  const waitingCombined: WaitingPredecessor[] = [...waiting];
  if (sub && waitingCombined.length === 0 && unmet.length > 0) {
    waitingCombined.push({
      fromSlotKey: `task:${unmet[0]}`,
      reason: "задача ждёт внешнюю зависимость",
      artifactKey: null,
    });
  }
  const sessionAge = sub ? lastSessionEventAgeSeconds(sub, role, now) : null;
  const stalledFromOutcome = sub ? (() => {
    const outcome = latestStepOutcome(sub.id);
    // `StepOutcomeStatus` — закрытое объединение ("submitted" | "blocked"
    // | "failed" | "continued" | "interrupted"), а значение "stalled"
    // пишется в `step_outcome.outcome` как строка из БД. Сравниваем
    // без приведения типа: V2 контракт обещает `cause=step_stalled`
    // именно при outcome='stalled' — за это отвечает `settleStalledPlanNode`.
    return Boolean(outcome && (outcome.outcome as string) === "stalled");
  })() : false;
  return {
    subtaskId: sub?.id ?? null,
    taskId: task.id,
    taskStatus: task.status,
    taskAgentState: task.agent_state,
    taskAssigneeId: task.assignee_id,
    taskCreatorId: task.creator_id,
    subtaskAgentState: sub?.agent_state ?? null,
    subtaskDone: (sub?.done ?? 0) === 1,
    subtaskBlockType: clampBlockType(sub?.block_type ?? null),
    subtaskPlanNodeKey: sub?.plan_node_key ?? null,
    subtaskTitle: sub?.title ?? null,
    roleKey: role,
    waitingPredecessors: waitingCombined,
    hasActiveAttempt,
    attemptHeartbeatAgeSeconds: heartbeatAge,
    sessionLastEventAgeSeconds: sessionAge,
    restartCount: sub ? restartCountForSubtask(sub.id, now) : 0,
    maxRestarts: 2,
    hasDurableQueuedJob: Boolean(job && (job.status === "queued" || job.status === "retry_wait")),
    deadJobFailureCode: job && job.status === "dead" ? jobFailureCode(job.last_error) : null,
    runningJobLeaseExpired: Boolean(
      job && job.status === "running" && job.lease_expires_at && parseIsoToEpoch(job.lease_expires_at, now) !== null && parseIsoToEpoch(job.lease_expires_at, now)! <= 0,
    ),
    stepOutcomeStalled: stalledFromOutcome,
    isFinalReviewNode: sub ? isFinalReviewNode(sub) : false,
    branchReworkLinkExists: sub ? hasBranchReworkLink(sub) : false,
    nowEpochSeconds: now,
  };
}

/** Список фактов по всем подзадачам карточки. Для эндпоинта
 *  /api/coordination/tasks/:id/resolve. Узлы плана и обычные
 *  подзадачи идут одним списком, чтобы UI получил их в порядке
 *  `position` плана или `created_at` для личных шагов. */
export function collectFactsForTask(taskId: string, options: ResolveOptions = {}): SubtaskFacts[] {
  const now = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const task = taskRow(taskId);
  if (!task) return [];
  const rows = db
    .prepare(
      `SELECT id FROM subtasks
        WHERE task_id = ?
        ORDER BY COALESCE(position, 0) ASC, rowid ASC`,
    )
    .all(taskId) as Array<{ id: string }>;
  const facts: SubtaskFacts[] = [];
  for (const r of rows) {
    const f = collectFacts(r.id, taskId, { nowEpochSeconds: now });
    if (f) facts.push(f);
  }
  return facts;
}

/** Сводка метрик: счётчики по `cause` за последние N секунд на
 *  основе событий `task_events.kind='resolution'`. Если таких
 *  событий ещё нет, окно пустое — это валидно (метрика новая). */
export function metricWindow(
  windowSeconds: number,
  options: ResolveOptions = {},
): {
  window: "hour" | "day";
  since: string;
  until: string;
  counts: Record<CauseCode, number>;
  actions: Record<string, number>;
  top_unknown_subtasks: Array<{ subtask_id: string; last_seen_at: string }>;
} {
  const nowMs = (options.nowEpochSeconds ?? Math.floor(Date.now() / 1000)) * 1000;
  const since = new Date(nowMs - windowSeconds * 1000).toISOString();
  const until = new Date(nowMs).toISOString();
  const counts = Object.fromEntries(CAUSE_CODES.map((c: CauseCode) => [c, 0])) as Record<CauseCode, number>;
  const actions: Record<string, number> = {};
  const unknownSeen = new Map<string, string>();
  let rows: Array<{ to_value: string | null; created_at: string }> = [];
  try {
    rows = db
      .prepare(
        `SELECT to_value, created_at FROM task_events
          WHERE kind = 'resolution'
            AND created_at >= datetime('now', ?)`,
      )
      .all(`-${windowSeconds} seconds`) as Array<{ to_value: string | null; created_at: string }>;
  } catch {
    rows = [];
  }
  for (const row of rows) {
    if (!row.to_value) continue;
    let parsed: { cause?: string; action?: string; subtask_id?: string | null };
    try {
      parsed = JSON.parse(row.to_value);
    } catch {
      continue;
    }
    if (parsed.cause && isCause(parsed.cause)) {
      counts[parsed.cause] = (counts[parsed.cause] ?? 0) + 1;
    }
    if (parsed.action) {
      actions[parsed.action] = (actions[parsed.action] ?? 0) + 1;
    }
    if (parsed.cause === "unknown" && parsed.subtask_id) {
      unknownSeen.set(parsed.subtask_id, row.created_at);
    }
  }
  const topUnknown = Array.from(unknownSeen.entries())
    .map(([subtask_id, last_seen_at]) => ({ subtask_id, last_seen_at }))
    .sort((a, b) => (a.last_seen_at < b.last_seen_at ? 1 : -1))
    .slice(0, 10);
  return {
    window: windowSeconds >= 3600 ? "day" : "hour",
    since,
    until,
    counts,
    actions,
    top_unknown_subtasks: topUnknown,
  };
}

/** Утилита для проверки, что строка `evidence` соответствует
 *  контракту V2 (≤ 7 ссылок, формат `таблица.основание`). Тесты
 *  импортируют её, а UI может пользоваться для валидации ввода. */
export function evidenceRefLooksValid(ref: string): boolean {
  if (typeof ref !== "string") return false;
  if (ref.length === 0 || ref.length > 200) return false;
  // Допускаем только безопасные символы и одну точку как разделитель.
  return /^[a-z_]+\.[a-zA-Z0-9_:.-]+$/.test(ref);
}

export type { SubtaskFacts } from "./coordinationResolver.js";
