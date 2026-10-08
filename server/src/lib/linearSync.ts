// Обратная синхронизация TaskFlow → Linear (карточка 20e30338).
//
// Задача: статус привязанной карточки сам отмечается в Linear.
//   взята в работу (agent_state=in_progress) → In Progress;
//   на проверке (agent_state=review)              → In Review;
//   закрыта (status=completed)                    → Done;
//   заблокирована (agent_state=blocked)           → In Progress + комментарий
//                                                    с причиной (один раз на
//                                                    эпизод блокировки);
//   активна без запуска (agent_state=null)        → не трогаем.
//
// Устройство: периодический проход считает желаемый статус по каждой строке
// линейной таблицы соответствий (linear_import_tasks), кладёт расхождение в
// очередь фиксированных операций и тут же разбирает созревшие задания. Запись
// идёт только для привязанных задач и только через узкий транспорт
// runtime/linearWrite.ts. Идемпотентность даёт уникальный ключ задания:
// повторный проход не плодит дубли и не шлёт мутацию, если Linear уже в нужном
// статусе. Сбой Linear не трогает карточку — задание остаётся в очереди с
// backoff и повторами; если простой затянулся больше 30 минут, владелец
// получает уведомление. Выключатель — в linear_sync_state.

import crypto from "node:crypto";
import { getSetting, onChange, setSetting } from "./serverSettings.js";
import db from "../db.js";
import * as linearWrite from "../runtime/linearWrite.js";
import { LinearWriteError } from "../runtime/linearWrite.js";

/** Период прохода: укладывается в «в пределах нескольких минут». */
export const LINEAR_SYNC_INTERVAL_MS = 60 * 1000;
/** Простой отправки дольше этого — владельцу уведомление. */
export const LINEAR_SYNC_STALE_MS = 30 * 60 * 1000;
/** Не повторять одно и то же уведомление чаще раза в час. */
const NOTIFY_REPEAT_MS = 60 * 60 * 1000;
/** Первый проход — не сразу после старта, чтобы сервер встал. */
const FIRST_PASS_DELAY_MS = 45 * 1000;
/** Максимум заданий за проход — проход не должен залипать на одной очереди. */
const BATCH_SIZE = 20;
/** Бэкофф между повторами: 30 c, 1 м, 2 м, ... до 30 м. */
const BACKOFF_BASE_SEC = 30;
const BACKOFF_MAX_SEC = 30 * 60;

export type LinearWriter = {
  updateIssueState(issueId: string, stateId: string): Promise<void>;
  createComment(issueId: string, body: string): Promise<void>;
  fetchTeamStates(teamId: string): Promise<Array<{ id: string; name: string; type: string }>>;
};

const defaultWriter: LinearWriter = {
  updateIssueState: linearWrite.updateIssueState,
  createComment: linearWrite.createComment,
  fetchTeamStates: linearWrite.fetchTeamStates,
};

export type DesiredState = { name: string; type: string; blocked: boolean };

/** Отображение «карточка → статус Linear». null — карточку не трогаем. */
export function desiredLinearState(task: { status: string; agent_state: string | null }): DesiredState | null {
  if (task.status === "completed") return { name: "Done", type: "completed", blocked: false };
  if (task.agent_state === "review") return { name: "In Review", type: "started", blocked: false };
  if (task.agent_state === "in_progress") return { name: "In Progress", type: "started", blocked: false };
  if (task.agent_state === "blocked") return { name: "In Progress", type: "started", blocked: true };
  return null;
}

const nowIso = (ms = Date.now()) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const parseUtc = (value: string) => Date.parse(value.replace(" ", "T") + "Z");

function ownerRow(ownerId?: string): { id: string } | undefined {
  return ownerId
    ? (db.prepare("SELECT id FROM users WHERE id = ?").get(ownerId) as { id: string } | undefined)
    : (db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined);
}

export type LinearSyncState = {
  owner_id: string;
  enabled: number;
  started_at: string;
  last_pass_at: string | null;
  last_success_at: string | null;
  last_sent_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  notified_at: string | null;
  sent_total: number;
  failed_total: number;
};

/** Строка состояния; создаётся лениво, включённой по умолчанию. */
export function linearSyncState(ownerId: string): LinearSyncState {
  db.prepare("INSERT OR IGNORE INTO linear_sync_state(owner_id) VALUES(?)").run(ownerId);
  return db.prepare("SELECT * FROM linear_sync_state WHERE owner_id = ?").get(ownerId) as LinearSyncState;
}

export function isLinearSyncEnabled(ownerId: string): boolean {
  return linearSyncState(ownerId).enabled === 1;
}

export function setLinearSyncEnabled(ownerId: string, enabled: boolean): LinearSyncState {
  linearSyncState(ownerId);
  setSetting("linear_sync_enabled", enabled as never, ownerId);
  return linearSyncState(ownerId);
}

export type LinearSyncHealth = {
  enabled: boolean;
  pending: number;
  failed: number;
  sent: number;
  oldest_pending_age_sec: number | null;
  last_pass_at: string | null;
  last_success_at: string | null;
  last_sent_at: string | null;
  last_error: string | null;
  sent_total: number;
  failed_total: number;
};

/** Наблюдаемость для настроек: очередь, простой, последняя ошибка. */
export function linearSyncHealth(ownerId: string): LinearSyncHealth {
  const state = linearSyncState(ownerId);
  const counts = db.prepare("SELECT status, COUNT(*) n FROM linear_sync_queue WHERE owner_id=? GROUP BY status").all(ownerId) as Array<{ status: string; n: number }>;
  const byStatus = new Map(counts.map(c => [c.status, c.n]));
  const oldest = db.prepare("SELECT MIN(created_at) t FROM linear_sync_queue WHERE owner_id=? AND status='pending'").get(ownerId) as { t: string | null };
  const latestError = db.prepare("SELECT last_error FROM linear_sync_queue WHERE owner_id=? AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(ownerId) as { last_error: string } | undefined;
  return {
    enabled: state.enabled === 1,
    pending: byStatus.get("pending") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    sent: byStatus.get("sent") ?? 0,
    oldest_pending_age_sec: oldest.t ? Math.max(0, Math.floor((Date.now() - parseUtc(oldest.t)) / 1000)) : null,
    last_pass_at: state.last_pass_at,
    last_success_at: state.last_success_at,
    last_sent_at: state.last_sent_at,
    last_error: latestError?.last_error ?? state.last_error,
    sent_total: state.sent_total,
    failed_total: state.failed_total,
  };
}

type MappingRow = {
  workspace_id: string; task_id: string; source_id: string; snapshot: string;
  status: string; agent_state: string | null; blocked_reason: string | null;
  block_type: string | null; blocked_at: string | null;
};

type QueueRow = {
  id: string; owner_id: string; workspace_id: string; task_id: string; issue_id: string;
  team_id: string; operation: "state" | "comment"; payload: string | null; desired_key: string;
  status: string; attempts: number; next_attempt_at: string | null;
};

function syncTaskRow(owner: string, workspace: string, task: string): { last_state: string | null; last_comment_key: string | null } | undefined {
  return db.prepare("SELECT last_state, last_comment_key FROM linear_sync_tasks WHERE owner_id=? AND workspace_id=? AND task_id=?").get(owner, workspace, task) as any;
}

function upsertSyncTask(owner: string, workspace: string, task: string, issue: string, team: string, fields: { last_state?: string | null; last_comment_key?: string | null }) {
  db.prepare(`INSERT INTO linear_sync_tasks(owner_id,workspace_id,task_id,issue_id,team_id,last_state,last_comment_key)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(owner_id,workspace_id,task_id) DO UPDATE SET
      issue_id=excluded.issue_id, team_id=excluded.team_id,
      last_state=COALESCE(excluded.last_state, linear_sync_tasks.last_state),
      last_comment_key=COALESCE(excluded.last_comment_key, linear_sync_tasks.last_comment_key),
      updated_at=datetime('now')`).run(
    owner, workspace, task, issue, team, fields.last_state ?? null, fields.last_comment_key ?? null,
  );
}

function enqueue(row: { owner: string; workspace: string; task: string; issue: string; team: string; operation: "state" | "comment"; payload: string; desiredKey: string }): boolean {
  const result = db.prepare(`INSERT OR IGNORE INTO linear_sync_queue(id,owner_id,workspace_id,task_id,issue_id,team_id,operation,payload,desired_key)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(
    crypto.randomUUID(), row.owner, row.workspace, row.task, row.issue, row.team, row.operation, row.payload, row.desiredKey,
  );
  return result.changes > 0;
}

/**
 * Задание на смену статуса. Ключ — имя статуса, поэтому задача, вернувшаяся
 * из «Done» обратно в работу, должна отправить тот же статус заново: если по
 * этому ключу уже есть ОТПРАВЛЕННОЕ задание, возвращаем его в очередь. Живое
 * (pending) или постоянное (failed) задание не трогаем — иначе починили бы
 * backoff и долбили бы Linear каждым проходом.
 */
function enqueueState(row: { owner: string; workspace: string; task: string; issue: string; team: string; payload: string; desiredKey: string }): boolean {
  const existing = db.prepare("SELECT id,status FROM linear_sync_queue WHERE owner_id=? AND workspace_id=? AND task_id=? AND desired_key=?").get(row.owner, row.workspace, row.task, row.desiredKey) as { id: string; status: string } | undefined;
  if (!existing) return enqueue({ ...row, operation: "state" });
  if (existing.status !== "sent") return false;
  db.prepare("UPDATE linear_sync_queue SET status='pending', attempts=0, next_attempt_at=NULL, last_error=NULL, payload=?, updated_at=datetime('now') WHERE id=?").run(row.payload, existing.id);
  return true;
}

function blockedComment(task: MappingRow): string {
  const reason = (task.blocked_reason || "").trim() || (task.block_type || "").trim() || "не указана";
  return `TaskFlow: карточка заблокирована.\nПричина: ${reason}`;
}

/** Посчитать расхождения и поставить задания. Возвращает число новых заданий. */
function reconcile(owner: string): number {
  const mappings = db.prepare(`SELECT m.workspace_id,m.task_id,m.source_id,m.snapshot,
      t.status,t.agent_state,t.blocked_reason,t.block_type,t.blocked_at
    FROM linear_import_tasks m JOIN tasks t ON t.id = m.task_id WHERE m.owner_id = ?`).all(owner) as MappingRow[];
  let queued = 0;
  for (const mapping of mappings) {
    const desired = desiredLinearState(mapping);
    if (!desired) continue;
    let snapshot: any = {};
    try { snapshot = JSON.parse(mapping.snapshot); } catch { /* повреждённый снимок — пропускаем команду */ }
    const teamId: string | undefined = snapshot.team?.id;
    if (!teamId || typeof teamId !== "string") continue;
    const remoteState: string | null = snapshot.state?.name ?? null;
    const row = syncTaskRow(owner, mapping.workspace_id, mapping.task_id);
    if (row?.last_state !== desired.name) {
      if (remoteState === desired.name) {
        // Linear уже в нужном статусе — просто запоминаем, мутацию не шлём.
        upsertSyncTask(owner, mapping.workspace_id, mapping.task_id, mapping.source_id, teamId, { last_state: desired.name });
      } else if (enqueueState({ owner, workspace: mapping.workspace_id, task: mapping.task_id, issue: mapping.source_id, team: teamId, payload: JSON.stringify({ name: desired.name, type: desired.type }), desiredKey: desired.name })) {
        queued += 1;
      }
    }
    if (desired.blocked) {
      const key = `blocked:${mapping.blocked_at ?? "once"}`;
      if (row?.last_comment_key !== key && enqueue({ owner, workspace: mapping.workspace_id, task: mapping.task_id, issue: mapping.source_id, team: teamId, operation: "comment", payload: blockedComment(mapping), desiredKey: key })) {
        queued += 1;
      }
    }
  }
  return queued;
}

/** id статуса по имени с кэшем в линейной команде. null — статуса нет. */
async function resolveStateId(owner: string, workspace: string, team: string, name: string, writer: LinearWriter): Promise<string | null> {
  const cached = db.prepare("SELECT state_id FROM linear_sync_states_cache WHERE owner_id=? AND workspace_id=? AND team_id=? AND name=?").get(owner, workspace, team, name) as { state_id: string } | undefined;
  if (cached) return cached.state_id;
  const states = await writer.fetchTeamStates(team);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM linear_sync_states_cache WHERE owner_id=? AND workspace_id=? AND team_id=?").run(owner, workspace, team);
    const insert = db.prepare("INSERT OR REPLACE INTO linear_sync_states_cache(owner_id,workspace_id,team_id,name,state_id,type,cached_at) VALUES(?,?,?,?,?,?,datetime('now'))");
    for (const state of states) insert.run(owner, workspace, team, state.name, state.id, state.type);
  });
  tx();
  return states.find(s => s.name === name)?.id ?? null;
}

function backoffSeconds(attempts: number): number {
  return Math.min(BACKOFF_MAX_SEC, BACKOFF_BASE_SEC * 2 ** Math.max(0, attempts - 1));
}

/** Постоянный отказ отправки (статуса нет и т.п.) — владельцу один раз. */
function notifyLinearSyncFailed(owner: string, message: string): void {
  const already = db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND type='linear_sync_failed' AND text LIKE ?").get(owner, `%${message.slice(0, 80)}%`);
  if (already) return;
  const text = [
    "⚠️ Статус карточки не удалось отметить в Linear.",
    `Причина: ${message}`,
    "Карточки TaskFlow продолжают работать. Повтор остановлен, чтобы не долбить Linear впустую.",
  ].join("\n");
  db.prepare("INSERT INTO notifications(id,user_id,type,task_id,text,actor_id) VALUES(?,?,?,NULL,?,NULL)").run(crypto.randomUUID(), owner, "linear_sync_failed", text);
}

export type LinearSyncResult = {
  owner_id: string;
  skipped?: "disabled";
  mappings: number;
  queued: number;
  sent: number;
  failed: number;
  errors: string[];
};

/**
 * Один проход: посчитать расхождения и разобрать созревшие задания.
 * Не бросает наружу — причина остаётся в состоянии и в результате.
 */
export async function runLinearSyncPass(ownerId?: string, options: { writer?: LinearWriter; now?: number; limit?: number; retryFailed?: boolean } = {}): Promise<LinearSyncResult> {
  const owner = ownerRow(ownerId);
  if (!owner) throw new LinearWriteError("Владелец не найден.", 404);
  const result: LinearSyncResult = { owner_id: owner.id, mappings: 0, queued: 0, sent: 0, failed: 0, errors: [] };
  const state = linearSyncState(owner.id);
  if (state.enabled !== 1 || !getSetting("linear_sync_enabled")) return { ...result, skipped: "disabled" };
  const now = options.now ?? Date.now();
  const writer = options.writer ?? defaultWriter;
  // Ручной внеочередной проход — единственный способ вернуть постоянные
  // отказы в очередь (например, владелец поправил статусы в Linear).
  if (options.retryFailed) db.prepare("UPDATE linear_sync_queue SET status='pending', attempts=0, next_attempt_at=NULL, last_error=NULL, updated_at=datetime('now') WHERE owner_id=? AND status='failed'").run(owner.id);
  db.prepare("UPDATE linear_sync_state SET last_pass_at=? WHERE owner_id=?").run(nowIso(now), owner.id);
  result.mappings = (db.prepare("SELECT COUNT(*) n FROM linear_import_tasks WHERE owner_id=?").get(owner.id) as { n: number }).n;
  try {
    result.queued = reconcile(owner.id);
    const due = db.prepare(`SELECT * FROM linear_sync_queue
      WHERE owner_id=? AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at LIMIT ?`).all(owner.id, nowIso(now), options.limit ?? BATCH_SIZE) as QueueRow[];
    for (const job of due) {
      try {
        if (job.operation === "state") {
          const payload = JSON.parse(job.payload || "{}") as { name: string; type: string };
          const stateId = await resolveStateId(owner.id, job.workspace_id, job.team_id, payload.name, writer);
          if (!stateId) throw new LinearWriteError(`В команде Linear нет статуса «${payload.name}». Дальнейшие повторы остановлены.`, 409);
          await writer.updateIssueState(job.issue_id, stateId);
          upsertSyncTask(owner.id, job.workspace_id, job.task_id, job.issue_id, job.team_id, { last_state: payload.name });
        } else {
          await writer.createComment(job.issue_id, job.payload || "");
          upsertSyncTask(owner.id, job.workspace_id, job.task_id, job.issue_id, job.team_id, { last_comment_key: job.desired_key });
        }
        db.prepare("UPDATE linear_sync_queue SET status='sent', last_error=NULL, updated_at=datetime('now') WHERE id=?").run(job.id);
        result.sent += 1;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        result.errors.push(message);
        if (error instanceof LinearWriteError && error.status === 409) {
          // Постоянная ошибка конфигурации: повторять бесконечно нельзя.
          db.prepare("UPDATE linear_sync_queue SET status='failed', attempts=attempts+1, last_error=?, updated_at=datetime('now') WHERE id=?").run(message, job.id);
          db.prepare("UPDATE linear_sync_state SET last_error=?, last_error_at=? WHERE owner_id=?").run(message, nowIso(now), owner.id);
          notifyLinearSyncFailed(owner.id, message);
          result.failed += 1;
        } else {
          const attempts = job.attempts + 1;
          db.prepare("UPDATE linear_sync_queue SET attempts=?, next_attempt_at=?, last_error=?, updated_at=datetime('now') WHERE id=?")
            .run(attempts, nowIso(now + backoffSeconds(attempts) * 1000), message, job.id);
        }
      }
    }
    db.prepare("UPDATE linear_sync_state SET last_success_at=?, last_sent_at=CASE WHEN ? > 0 THEN ? ELSE last_sent_at END, sent_total=sent_total+?, failed_total=failed_total+?, last_error=CASE WHEN ? > 0 THEN last_error ELSE NULL END, last_error_at=CASE WHEN ? > 0 THEN last_error_at ELSE NULL END WHERE owner_id=?")
      .run(nowIso(now), result.sent, nowIso(now), result.sent, result.failed, result.errors.length, result.errors.length, owner.id);
    return result;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    result.errors.push(message);
    db.prepare("UPDATE linear_sync_state SET last_error=?, last_error_at=? WHERE owner_id=?").run(message, nowIso(now), owner.id);
    return result;
  }
}

/** Уведомление владельцу, если самое старое задание висит дольше 30 минут. */
export function notifyLinearSyncStale(ownerId?: string, now = Date.now()): boolean {
  const owner = ownerRow(ownerId);
  if (!owner) return false;
  const state = linearSyncState(owner.id);
  if (state.enabled !== 1 || !getSetting("linear_sync_enabled")) return false;
  const oldest = db.prepare("SELECT MIN(created_at) t FROM linear_sync_queue WHERE owner_id=? AND status='pending'").get(owner.id) as { t: string | null };
  if (!oldest.t) return false;
  if (now - parseUtc(oldest.t) <= LINEAR_SYNC_STALE_MS) return false;
  const notified = state.notified_at ? parseUtc(state.notified_at) : null;
  if (notified !== null && now - notified < NOTIFY_REPEAT_MS) return false;
  const latestError = db.prepare("SELECT last_error FROM linear_sync_queue WHERE owner_id=? AND status='pending' AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(owner.id) as { last_error: string } | undefined;
  const text = [
    "⚠️ Отправка статусов в Linear не проходит больше 30 минут.",
    latestError?.last_error ? `Последняя ошибка: ${latestError.last_error}` : "Задания очереди ждут отправки.",
    "Карточки TaskFlow продолжают работать. Проверьте подключение Linear (OAuth-приложение TaskFlow) и повторите.",
  ].join("\n");
  db.prepare("INSERT INTO notifications(id,user_id,type,task_id,text,actor_id) VALUES(?,?,?,NULL,?,NULL)").run(
    crypto.randomUUID(), owner.id, "linear_sync_stale", text,
  );
  db.prepare("UPDATE linear_sync_state SET notified_at=? WHERE owner_id=?").run(nowIso(now), owner.id);
  return true;
}

/** Раз в минуту; первый проход — через 45 секунд после старта. */
export function startLinearSync(): () => void {
  let busy = false;
  const tick = async () => {
    if (busy || !getSetting("linear_sync_enabled")) return;
    busy = true;
    try {
      if (linearWrite.linearWriteConfigured()) {
        const result = await runLinearSyncPass();
        if (result.queued || result.sent || result.failed || result.errors.length) {
          console.log(`[linear-sync] привязано ${result.mappings}, в очередь ${result.queued}, отправлено ${result.sent}${result.failed ? `, отказов ${result.failed}` : ""}${result.errors.length ? `, ошибок ${result.errors.length}` : ""}`);
        }
        notifyLinearSyncStale();
      } else {
        notifyLinearSyncStale();
      }
    } catch (error) {
      console.warn("[linear-sync] проход не удался:", error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_PASS_DELAY_MS);
  let timer = setInterval(() => void tick(), getSetting("linear_sync_interval_min") * 60_000);
  const off = onChange("linear_sync_interval_min", () => {
    clearInterval(timer);
    timer = setInterval(() => void tick(), getSetting("linear_sync_interval_min") * 60_000);
  });
  return () => {
    off();
    clearTimeout(first);
    clearInterval(timer);
  };
}
