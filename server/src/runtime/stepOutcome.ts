// Единое событие-исход запуска шага (владелец 06.10.2026, MAK-96).
//
// Любое завершение хода по шагу — сдан, блок, сбой, прерывание — пишет ОДНО
// типизированное событие `step_outcome` в журнал карточки. В `to_value` лежит
// машиночитаемый исход: статус и код из закрытого словаря причин сбоя
// (`failureReasons.ts`). Так серверу есть на что реагировать без чтения
// свободного текста, а в ленте видно, чем кончился запуск.
//
// Место записи одно (этот модуль) — существующие `plan_subtask_autostart_failed`,
// `plan_subtask_stalled_blocked`, `subtask_blocked`, `model_failover` переведены
// сюда, чтобы одинаковые провалы не трактовались по-разному в разных файлах.

import db from "../db.js";
import { logEvent } from "../agentState.js";
import {
  classifyFailureReason,
  failureReasonLabel,
  isFailureReasonCode,
  type FailureReasonCode,
} from "./failureReasons.js";

export const STEP_OUTCOME_KIND = "step_outcome";

export type StepOutcomeStatus =
  | "submitted"
  | "blocked"
  | "failed"
  | "continued"
  | "interrupted";

export type StepOutcome = {
  outcome: StepOutcomeStatus;
  /** Код причины; null — только у успешной сдачи (не сбой). */
  code: FailureReasonCode | null;
  label: string | null;
  message: string | null;
  subtask_id: string | null;
  slot_key: string | null;
  role: string | null;
};

export type StepOutcomeInput = {
  taskId: string;
  actorId?: string | null;
  subtaskId?: string | null;
  role?: string | null;
  outcome: StepOutcomeStatus;
  /** Текст ошибки/причины: код выводит классификатор. */
  error?: string | null;
  /** Явный код, когда причина известна не по тексту (шаг брошен, сдано). */
  code?: FailureReasonCode | null;
  /** Короткое пояснение для человека. */
  message?: string | null;
};

type SlotRow = {
  id: string;
  task_id: string;
  plan_node_key: string | null;
  agent_id: string | null;
  title: string | null;
};

function slotInfo(subtaskId: string): SlotRow | undefined {
  return db
    .prepare(
      `SELECT s.id, s.task_id, s.plan_node_key, s.agent_id, s.title
         FROM subtasks s WHERE s.id = ?`,
    )
    .get(subtaskId) as SlotRow | undefined;
}

function roleOf(userId: string | null): string | null {
  if (!userId) return null;
  const row = db.prepare("SELECT role_key FROM users WHERE id = ?").get(userId) as { role_key?: string | null } | undefined;
  return row?.role_key ?? null;
}

/**
 * Собрать исход, не записывая его. Успешная сдача и продолжение — без кода
 * (сбоя не было); блок/сбой/прерывание — с кодом из закрытого словаря,
 * выведенным из текста ошибки, либо заданным явно.
 */
export function buildStepOutcome(input: StepOutcomeInput): StepOutcome {
  const slot = input.subtaskId ? slotInfo(input.subtaskId) : undefined;
  const outcome = input.outcome;
  const isFailure = outcome !== "submitted" && outcome !== "continued";
  const explicit = input.code && isFailureReasonCode(input.code) ? input.code : null;
  const code: FailureReasonCode | null = !isFailure
    ? null
    : explicit
      ?? classifyFailureReason(input.error ?? input.message ?? "");
  return {
    outcome,
    code,
    label: code ? failureReasonLabel(code) : null,
    message: (input.message ?? input.error ?? "").trim().slice(0, 500) || null,
    subtask_id: input.subtaskId ?? null,
    slot_key: slot?.plan_node_key ?? null,
    role: input.role ?? roleOf(slot?.agent_id ?? null),
  };
}

let warnedMalformed = false;

/** Записать событие-исход в журнал карточки. Не бросает — исход не должен
 *  валить сам путь, на котором случился сбой. */
export function logStepOutcome(input: StepOutcomeInput): StepOutcome | null {
  try {
    const outcome = buildStepOutcome(input);
    logEvent({
      taskId: input.taskId,
      actorId: input.actorId ?? null,
      kind: STEP_OUTCOME_KIND,
      field: outcome.slot_key ?? outcome.subtask_id ?? null,
      toValue: JSON.stringify(outcome),
    });
    return outcome;
  } catch (error) {
    if (!warnedMalformed) {
      warnedMalformed = true;
      console.warn("[stepOutcome] событие-исход не записано:", error);
    }
    return null;
  }
}

function parseOutcome(toValue: unknown): StepOutcome | null {
  try {
    const parsed = typeof toValue === "string" ? JSON.parse(toValue) : toValue;
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as Partial<StepOutcome>;
    if (typeof row.outcome !== "string") return null;
    return {
      outcome: row.outcome as StepOutcomeStatus,
      code: isFailureReasonCode(row.code) ? row.code : null,
      label: typeof row.label === "string" ? row.label : null,
      message: typeof row.message === "string" ? row.message : null,
      subtask_id: typeof row.subtask_id === "string" ? row.subtask_id : null,
      slot_key: typeof row.slot_key === "string" ? row.slot_key : null,
      role: typeof row.role === "string" ? row.role : null,
    };
  } catch {
    return null;
  }
}

/** Последний исход запуска конкретного шага — то, что сервер отдаёт дальше. */
export function latestStepOutcome(subtaskId: string): StepOutcome | null {
  try {
    const rows = db
      .prepare(
        `SELECT to_value, field FROM task_events
          WHERE kind = ? AND (field = ? OR field = (SELECT plan_node_key FROM subtasks WHERE id = ?))
          ORDER BY created_at DESC, rowid DESC LIMIT 5`,
      )
      .all(STEP_OUTCOME_KIND, subtaskId, subtaskId) as Array<{ to_value: string | null; field: string | null }>;
    for (const row of rows) {
      const outcome = parseOutcome(row.to_value);
      if (outcome) return outcome;
    }
    return null;
  } catch {
    return null;
  }
}

/** Событие-исход по id — для проверок и реакции сервера. */
export function stepOutcomeById(eventId: string): StepOutcome | null {
  const row = db
    .prepare("SELECT to_value FROM task_events WHERE id = ? AND kind = ?")
    .get(eventId, STEP_OUTCOME_KIND) as { to_value: string | null } | undefined;
  return row ? parseOutcome(row.to_value) : null;
}
