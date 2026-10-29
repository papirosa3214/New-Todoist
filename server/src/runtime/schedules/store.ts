// Хранилище рутин: таблицы task_schedules и schedule_runs.
//
// Схема — из заметки «Рутины и расписание TaskFlow» (раздел «Модель данных»):
//   task_schedules: id, title, task_payload (JSON), rule_kind, rule_expr,
//                   time_local, timezone, next_run_at, last_run_at, status,
//                   catch_up, overlap_policy, current_task_id, created_by,
//                   created_at, updated_at
//   schedule_runs:  id, schedule_id, run_at (UTC), task_id, status,
//                   detail, created_at, UNIQUE(schedule_id, run_at)
//
// UNIQUE(schedule_id, run_at) — инвариант идемпотентности: повторный обход
// планировщика в то же окно не создаёт вторую карточку.

import crypto from "node:crypto";
import db from "../../db.js";
import { logEvent } from "../../agentState.js";
import { localDateParts, type ScheduleRule, type ScheduleRuleKind } from "./rules.js";

export type ScheduleStatus = "active" | "paused" | "finished";
export type RunStatus = "created" | "skipped" | "failed" | "error";

export interface TaskPayload {
  title: string;
  description?: string | null;
  project_id?: string | null;
  /** Роль-исполнитель (ключ роли: builder, qa, …). */
  assignee_id?: string | null;
  /** Явный профиль штатного collaboration template; null — автоматический подбор. */
  plan_profile?: string | null;
  priority?: number | null;
  duration_min?: number | null;
  labels?: string[] | null;
  requires_reviewer_review?: boolean | null;
  needs_research?: boolean | null;
}

export interface ScheduleRow {
  id: string;
  title: string;
  task_payload: string;
  rule_kind: ScheduleRuleKind;
  rule_expr: string | null;
  time_local: string;
  timezone: string;
  next_run_at: string | null;
  last_run_at: string | null;
  status: ScheduleStatus;
  catch_up: number;
  overlap_policy: "skip" | "allow";
  current_task_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ScheduleRunRow {
  id: string;
  schedule_id: string;
  run_at: string;
  task_id: string | null;
  status: RunStatus;
  detail: string | null;
  created_at: string;
}

const uid = () => crypto.randomUUID();

/** UTC-строка в формате, который понимает SQLite и JS. */
export function toUtcIso(date: Date): string {
  return date.toISOString();
}

export function parseUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function listSchedules(): ScheduleRow[] {
  return db
    .prepare("SELECT * FROM task_schedules ORDER BY created_at DESC, id")
    .all() as ScheduleRow[];
}

export function getSchedule(id: string): ScheduleRow | undefined {
  return db.prepare("SELECT * FROM task_schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
}

export function getScheduleByTitle(title: string): ScheduleRow | undefined {
  return db
    .prepare("SELECT * FROM task_schedules WHERE title = ? ORDER BY created_at DESC LIMIT 1")
    .get(title) as ScheduleRow | undefined;
}

export function createSchedule(input: {
  title: string;
  taskPayload: TaskPayload;
  rule: ScheduleRule;
  nextRunAt: Date | null;
  catchUp: boolean;
  overlapPolicy: "skip" | "allow";
  createdBy: string;
}): ScheduleRow {
  const id = uid();
  db.prepare(
    `INSERT INTO task_schedules
       (id, title, task_payload, rule_kind, rule_expr, time_local, timezone,
        next_run_at, last_run_at, status, catch_up, overlap_policy,
        current_task_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, NULL, ?, datetime('now'), datetime('now'))`,
  ).run(
    id,
    input.title,
    JSON.stringify(input.taskPayload),
    input.rule.kind,
    input.rule.expr,
    input.rule.timeLocal,
    input.rule.timezone,
    input.nextRunAt ? toUtcIso(input.nextRunAt) : null,
    input.catchUp ? 1 : 0,
    input.overlapPolicy,
    input.createdBy,
  );
  return getSchedule(id)!;
}

export function updateSchedule(
  id: string,
  patch: {
    title?: string;
    taskPayload?: TaskPayload;
    rule?: ScheduleRule;
    nextRunAt?: Date | null;
    status?: ScheduleStatus;
    catchUp?: boolean;
    overlapPolicy?: "skip" | "allow";
  },
): ScheduleRow | undefined {
  const existing = getSchedule(id);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE task_schedules
        SET title = ?, task_payload = ?, rule_kind = ?, rule_expr = ?,
            time_local = ?, timezone = ?, next_run_at = ?, status = ?,
            catch_up = ?, overlap_policy = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    patch.title ?? existing.title,
    patch.taskPayload ? JSON.stringify(patch.taskPayload) : existing.task_payload,
    patch.rule?.kind ?? existing.rule_kind,
    patch.rule ? patch.rule.expr ?? null : existing.rule_expr,
    patch.rule?.timeLocal ?? existing.time_local,
    patch.rule?.timezone ?? existing.timezone,
    patch.nextRunAt === undefined
      ? existing.next_run_at
      : patch.nextRunAt
        ? toUtcIso(patch.nextRunAt)
        : null,
    patch.status ?? existing.status,
    patch.catchUp === undefined ? existing.catch_up : patch.catchUp ? 1 : 0,
    patch.overlapPolicy ?? existing.overlap_policy,
    id,
  );
  return getSchedule(id);
}

export function deleteSchedule(id: string): boolean {
  const changes = db.prepare("DELETE FROM task_schedules WHERE id = ?").run(id).changes;
  return changes > 0;
}

export function markScheduleRun(
  id: string,
  patch: { lastRunAt?: Date | null; nextRunAt?: Date | null; currentTaskId?: string | null },
): void {
  const existing = getSchedule(id);
  if (!existing) return;
  db.prepare(
    `UPDATE task_schedules
        SET last_run_at = ?, next_run_at = ?, current_task_id = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    patch.lastRunAt === undefined ? existing.last_run_at : patch.lastRunAt ? toUtcIso(patch.lastRunAt) : null,
    patch.nextRunAt === undefined ? existing.next_run_at : patch.nextRunAt ? toUtcIso(patch.nextRunAt) : null,
    patch.currentTaskId === undefined ? existing.current_task_id : patch.currentTaskId,
    id,
  );
}

/**
 * Слоты, занятые в ЭТОМ процессе.
 *
 * Слот занимается ДО создания карточки (это и даёт идемпотентность), и
 * между «заняли слот» и «появилась карточка» есть окно. Если в этом окне
 * процесс упал, в истории остаётся запись «создана» без карточки — а
 * карточки нет.
 *
 * Память процесса — то, что отличает такой брошенный слот от живого
 * запуска, идущего прямо сейчас (в том числе в соседнем проходе
 * планировщика). После перезапуска сервера память пуста, и брошенный слот
 * виден как чужой.
 */
const liveSlots = new Set<string>();

const slotKey = (scheduleId: string, runAt: string) => `${scheduleId}|${runAt}`;

/**
 * Занять слот запуска. UNIQUE(schedule_id, run_at) гасит повтор: если слот
 * уже занят (второй проход планировщика в то же окно), created=false — и
 * вторая карточка не создаётся.
 *
 * Дальше результат запуска пишется updateRun в ту же строку.
 */
export function claimRun(input: {
  scheduleId: string;
  runAt: Date;
}): { created: boolean; row?: ScheduleRunRow } {
  const id = uid();
  const runAt = toUtcIso(input.runAt);
  const key = slotKey(input.scheduleId, runAt);
  try {
    db.prepare(
      `INSERT INTO schedule_runs (id, schedule_id, run_at, task_id, status, detail, created_at)
       VALUES (?, ?, ?, NULL, 'created', 'запуск', datetime('now'))`,
    ).run(id, input.scheduleId, runAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("UNIQUE")) throw error;
    const row = db
      .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? AND run_at = ?")
      .get(input.scheduleId, runAt) as ScheduleRunRow | undefined;
    if (row && !row.task_id && row.status === "created" && !liveSlots.has(key)) {
      // Слот занят, карточки нет, и в этом процессе он не в работе —
      // значит, его оставил упавший процесс. Честная запись — ошибка
      // запуска, а не «создана» (D5).
      db.prepare(
        `UPDATE schedule_runs
            SET status = 'failed', detail = 'запуск прерван: карточка не создана'
          WHERE id = ?`,
      ).run(row.id);
      row.status = "failed";
      row.detail = "запуск прерван: карточка не создана";
    }
    return { created: false, row };
  }
  liveSlots.add(key);
  const row = db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id) as ScheduleRunRow;
  return { created: true, row };
}

/** Дописать результат запуска в занятый слот. */
export function updateRun(input: {
  scheduleId: string;
  runAt: Date;
  status: RunStatus;
  detail?: string | null;
  taskId?: string | null;
}): void {
  db.prepare(
    `UPDATE schedule_runs
        SET status = ?, detail = ?, task_id = COALESCE(?, task_id)
      WHERE schedule_id = ? AND run_at = ?`,
  ).run(input.status, input.detail ?? null, input.taskId ?? null, input.scheduleId, toUtcIso(input.runAt));
  // Слот отработал — он больше не «в работе».
  liveSlots.delete(slotKey(input.scheduleId, toUtcIso(input.runAt)));
}

export function listRuns(scheduleId: string, limit = 50): ScheduleRunRow[] {
  return db
    .prepare(
      "SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY run_at DESC LIMIT ?",
    )
    .all(scheduleId, limit) as ScheduleRunRow[];
}

export function countRuns(scheduleId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = ?").get(scheduleId) as { n: number }
  ).n;
}

/**
 * Через сколько минут брошенный запуск считается прерванным.
 *
 * Страховка для записей, слот которых уже не текущий (например, рутина
 * пересчитала расписание, а запись осталась). Основной механизм — па��ять
 * процесса в claimRun.
 */
export const INTERRUPTED_RUN_AFTER_MS = 10 * 60_000;

/**
 * Чинит брошенные записи запуска: помечает их ошибкой запуска.
 *
 * Отличаем от нормальной картины по двум признакам: у успешного запуска
 * есть task_id, а незавершённый старше порога (значит, он не «прямо сейчас»).
 */
export function repairInterruptedRuns(
  olderThanMs: number = INTERRUPTED_RUN_AFTER_MS,
): number {
  const rows = db
    .prepare(
      `SELECT id, schedule_id, run_at FROM schedule_runs
        WHERE status = 'created' AND task_id IS NULL
          AND CAST(strftime('%s', created_at) AS INTEGER)
              < CAST(strftime('%s', 'now') AS INTEGER) - ?`,
    )
    .all(Math.round(olderThanMs / 1000)) as Array<{
    id: string;
    schedule_id: string;
    run_at: string;
  }>;
  const update = db.prepare(
    `UPDATE schedule_runs
        SET status = 'failed', detail = 'запуск прерван: карточка не создана'
      WHERE id = ?`,
  );
  let fixed = 0;
  for (const row of rows) {
    // Живой запуск этого процесса не трогаем: он ещё в работе.
    if (liveSlots.has(slotKey(row.schedule_id, row.run_at))) continue;
    update.run(row.id);
    fixed += 1;
  }
  return fixed;
}

/** Экземпляр рутины ещё открыт? (для overlap_policy=skip). */
export function currentInstanceOpen(schedule: ScheduleRow): boolean {
  if (!schedule.current_task_id) return false;
  const task = db
    .prepare("SELECT status FROM tasks WHERE id = ?")
    .get(schedule.current_task_id) as { status?: string } | undefined;
  if (!task) return false;
  return task.status === "active";
}

export function parsePayload(row: ScheduleRow): TaskPayload {
  try {
    const parsed = JSON.parse(row.task_payload);
    return parsed && typeof parsed === "object" ? (parsed as TaskPayload) : { title: row.title };
  } catch {
    return { title: row.title };
  }
}

export function ruleOf(row: ScheduleRow, anchor: { year: number; month: number; day: number }): ScheduleRule {
  return {
    kind: row.rule_kind,
    expr: row.rule_expr,
    timeLocal: row.time_local,
    timezone: row.timezone,
    // Якорь — дата создания рутины в её зоне. Явный день правила (день
    // недели или число месяца) главнее якоря — это учитывает
    // ruleMatchesDate.
    anchor,
  };
}

/** Дата-якорь для «раз в неделю»/«раз в месяц» — местная дата создания. */
export function anchorFromCreatedAt(row: ScheduleRow): { year: number; month: number; day: number } {
  const created = parseUtc(row.created_at) ?? new Date();
  return localDateParts(created, row.timezone);
}

export function logScheduleEvent(
  taskId: string | null,
  actorId: string | null,
  kind: string,
  field?: string,
  toValue?: string,
): void {
  if (!taskId) return;
  logEvent({ taskId, actorId, kind, field: field ?? null, toValue: toValue ?? null });
}
