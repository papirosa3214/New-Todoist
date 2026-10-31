// Учёт вызовов инструментов ролями (карточка 64af4c85-93ed-4926-bd78-5cdfaf6a9ba5,
// P0 карточки e73e7314).
//
// Два хранилища, одно — рядом с уже существующим журналом операций
// (`role_tool_requests`, toolRequestStore.ts), второе — счётчики:
//
//   • role_tool_audit — по одной строке на КАЖДОЕ действие роли (P0/A1):
//     время, роль, модель и провайдер, инструмент и операция, исход
//     (`ok`/`error`/`repaired`), код ошибки, короткое сообщение, область
//     (`scope`: chat|task), элемент (`item_id`), на что похож повтор
//     (`dup_of`) и длительность вызова. Значения аргументов НЕ сохраняются:
//     только путь поля и ожидаемый тип (см. `error_field`/`error_expected`).
//     До P0 успешные вызовы сюда не писались, поэтому сторож видел `ok = 0`
//     и гасил работающий ход после трёх любых отказов за 10 минут.
//
//   • role_tool_audit_counters — счётчики по часу и разрезам (роль, модель,
//     провайдер, операция, инструмент): успешные вызовы, отказы и доля
//     ошибок считаются отсюда.
//
// Отдельного журнала операций не заводим: успешные вызовы с request_id
// уже пишутся в `role_tool_requests`.

import crypto from "node:crypto";
import db from "../db.js";
import { parseModelRef } from "../lib/attemptModel.js";

export const TOOL_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS role_tool_audit (
 id TEXT PRIMARY KEY,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 role TEXT NOT NULL,
 model TEXT,
 provider TEXT,
 mode TEXT,
 scope TEXT,
 item_id TEXT,
 run_id TEXT,
 task_id TEXT,
 subtask_id TEXT,
 action TEXT,
 tool TEXT,
 operation TEXT,
 outcome TEXT NOT NULL,
 error_code TEXT,
 error_message TEXT,
 error_field TEXT,
 error_expected TEXT,
 dup_of TEXT,
 duration_ms INTEGER,
 request_id TEXT
);
CREATE INDEX IF NOT EXISTS role_tool_audit_created_at ON role_tool_audit(created_at);
CREATE INDEX IF NOT EXISTS role_tool_audit_role ON role_tool_audit(role);
CREATE INDEX IF NOT EXISTS role_tool_audit_code ON role_tool_audit(error_code);
CREATE INDEX IF NOT EXISTS role_tool_audit_item ON role_tool_audit(item_id, created_at);
CREATE TABLE IF NOT EXISTS role_tool_audit_counters (
 bucket TEXT NOT NULL,
 role TEXT NOT NULL,
 model TEXT NOT NULL DEFAULT '',
 provider TEXT NOT NULL DEFAULT '',
 operation TEXT NOT NULL DEFAULT '',
 tool TEXT NOT NULL DEFAULT '',
 calls INTEGER NOT NULL DEFAULT 0,
 errors INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (bucket, role, model, provider, operation, tool)
);
CREATE INDEX IF NOT EXISTS role_tool_audit_counters_bucket ON role_tool_audit_counters(bucket);
`;

export type ToolAuditEvent = {
  role: string;
  model?: string | null;
  provider?: string | null;
  mode?: string | null;
  /** Область действия роли: чат или шаг карточки (A1). */
  scope?: string | null;
  /** Элемент действия: шаг, карточка или чат (A1). */
  itemId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  subtaskId?: string | null;
  /** Чат — когда действие идёт в чате, а не в шаге карточки. */
  chatId?: string | null;
  action?: string | null;
  tool?: string | null;
  operation?: string | null;
  outcome: "ok" | "error" | "repaired";
  errorCode?: string | null;
  errorMessage?: string | null;
  errorField?: string | null;
  errorExpected?: string | null;
  /** На какой прежний вызов похож этот (дедупликация, P1). */
  dupOf?: string | null;
  /** Сколько шёл вызов, миллисекунды (A1). */
  durationMs?: number | null;
  requestId?: string | null;
};

export type ToolAuditRecord = {
  id: string;
  created_at: string;
  role: string;
  model: string | null;
  provider: string | null;
  mode: string | null;
  scope: string | null;
  item_id: string | null;
  run_id: string | null;
  task_id: string | null;
  subtask_id: string | null;
  action: string | null;
  tool: string | null;
  operation: string | null;
  outcome: string;
  error_code: string | null;
  error_message: string | null;
  error_field: string | null;
  error_expected: string | null;
  dup_of: string | null;
  duration_ms: number | null;
  request_id: string | null;
};

export type ToolAuditFilters = {
  from?: string | null;
  to?: string | null;
  role?: string | null;
  model?: string | null;
  operation?: string | null;
  code?: string | null;
  taskId?: string | null;
  subtaskId?: string | null;
};

/** Час-корзина счётчиков: SQLite отдаёт время в UTC, поэтому и bucket UTC. */
function hourBucket(at: Date = new Date()): string {
  return at.toISOString().replace("T", " ").slice(0, 13);
}

function isoToSqlite(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().replace("T", " ").slice(0, 19);
}

/** Окно поиска повтора: одинаковый вызов в пределах этого времени считается
 *  повтором того же действия (P1 — дедупликация по аргументам). */
const DUP_WINDOW_MINUTES = 10;

/**
 * Найти прежний такой же вызов — на него указывает `dup_of`.
 *
 * «Такой же» — та же роль, тот же элемент действия (шаг/карточка/чат), тот же
 * инструмент и операция, тот же исход и тот же код отказа. Различаются только
 * вызовы в разных элементах: повтор в другом шаге — не повтор этого действия.
 *
 * D2 карточки e73e7314: колонка `dup_of` была заведена, но не заполнялась ни
 * нативным каталогом, ни шлюзом — событие действия по A1 приходило неполным.
 * Заполняем в единой точке записи, чтобы это работало на всех путях.
 */
function findDuplicateCall(event: ToolAuditEvent, itemId: string | null): string | null {
  try {
    const row = db
      .prepare(
        `SELECT id FROM role_tool_audit
          WHERE role = ?
            AND COALESCE(item_id,'') = COALESCE(?,'')
            AND COALESCE(tool,'') = COALESCE(?,'')
            AND COALESCE(operation,'') = COALESCE(?,'')
            AND outcome = ?
            AND COALESCE(error_code,'') = COALESCE(?,'')
            AND created_at >= datetime('now', ?)
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(
        event.role,
        itemId,
        event.tool ?? "taskflow",
        event.operation ?? "",
        event.outcome,
        event.errorCode ?? null,
        `-${DUP_WINDOW_MINUTES} minutes`,
      ) as { id: string } | undefined;
    return row?.id ?? null;
  } catch (error) {
    console.warn("[tool-audit] повтор не найден:", error);
    return null;
  }
}

/**
 * Записать действие роли: строка в `role_tool_audit` на любой исход
 * (успех, отказ, починенная форма вызова) и счётчик в
 * `role_tool_audit_counters`.
 *
 * Строка на успешный вызов нужна: по ней сторож отличает живой ход от
 * цикла неверных вызовов (P0/B1). Без неё `ok` всегда был 0, и три любых
 * отказа за 10 минут гасили работающий шаг.
 *
 * Учёт не должен ломать сам вызов: любая ошибка записи гасится здесь и
 * пишется в журнал сервера.
 */
export function recordToolAudit(event: ToolAuditEvent): void {
  try {
    const model = event.model ?? null;
    // Провайдер — из самой модели: в ходе она приходит как «провайдер/модель»
    // («opencode-go/deepseek-v4.1-flash»). Эвристика по названию знает только
    // anthropic/openai и всё остальное зовёт minimax — по ней владелец не
    // поймёт, у кого истёк ключ. Разбор модели — parseModelRef.
    const provider =
      event.provider ?? (model ? parseModelRef(model).provider : null);
    const bucket = hourBucket();
    const operation = event.operation ?? "";
    const tool = event.tool ?? "taskflow";
    // A1: события действия одинаковой формы у всех путей записи — и у
    // нативного каталога, и у старого шлюза, и у пробы. Кто пишет явно, тот
    // главнее; иначе область и элемент выводятся из карточки и шага.
    const scope = event.scope ?? (event.taskId ? "task" : "chat");
    const itemId = event.itemId ?? event.subtaskId ?? event.taskId ?? event.chatId ?? null;
    const isError = event.outcome === "error";
    // `dup_of` — на прежний такой же вызов; явно переданное значение главнее.
    const dupOf =
      event.dupOf !== undefined && event.dupOf !== null
        ? event.dupOf
        : findDuplicateCall(event, itemId);
    // Две записи — ДВЕ отдельные транзакции (D3 карточки 64af4c85): сломанная
    // запись строки учёта не должна откатывать счётчики. Сторож учёта ищет
    // ровно эту разницу — «отказы не пишутся, а счётчики целы» — и обязан
    // сохранить её и теперь, когда строка пишется на каждый вызов.
    const writeCounters = db.transaction(() => {
      db.prepare(
        `INSERT INTO role_tool_audit_counters
           (bucket,role,model,provider,operation,tool,calls,errors)
         VALUES (?,?,?,?,?,?,1,?)
         ON CONFLICT(bucket,role,model,provider,operation,tool)
         DO UPDATE SET calls=calls+1, errors=errors+excluded.errors`,
      ).run(
        bucket,
        event.role,
        model ?? "",
        provider ?? "",
        operation,
        tool,
        isError ? 1 : 0,
      );
    });
    const writeRow = db.transaction(() => {
      db.prepare(
        `INSERT INTO role_tool_audit
           (id,role,model,provider,mode,scope,item_id,run_id,task_id,subtask_id,
            action,tool,operation,outcome,error_code,error_message,error_field,
            error_expected,dup_of,duration_ms,request_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        crypto.randomUUID(),
        event.role,
        model,
        provider,
        event.mode ?? null,
        scope,
        itemId,
        event.runId ?? null,
        event.taskId ?? null,
        event.subtaskId ?? null,
        event.action ?? null,
        tool,
        event.operation ?? null,
        event.outcome,
        event.errorCode ?? null,
        event.errorMessage ?? null,
        event.errorField ?? null,
        event.errorExpected ?? null,
        dupOf,
        typeof event.durationMs === "number" ? Math.round(event.durationMs) : null,
        event.requestId ?? null,
      );
    });
    try {
      writeCounters();
    } catch (error) {
      console.warn("[tool-audit] счётчики вызова не записаны:", error);
    }
    try {
      writeRow();
    } catch (error) {
      console.warn("[tool-audit] строка вызова не записана:", error);
    }
  } catch (error) {
    console.warn("[tool-audit] вызов не записан:", error);
  }
}

export type ToolAuditPeriod = {
  from: string;
  to: string;
  fromBucket: string;
  toBucket: string;
};

const HOUR_MS = 3_600_000;

/** Период по умолчанию — последние сутки. Границы округляются до часа:
 *  счётчики лежат в часовых корзинах, поэтому период «с 10:17» читается
 *  как «с 10:00» (это оговорено в AGENT-API.md). */
export function toolAuditPeriod(filters: ToolAuditFilters): ToolAuditPeriod {
  const toDate = filters.to ? new Date(filters.to) : new Date();
  const to = Number.isNaN(toDate.getTime()) ? new Date() : toDate;
  const fromDate = filters.from
    ? new Date(filters.from)
    : new Date(to.getTime() - 24 * HOUR_MS);
  const from = Number.isNaN(fromDate.getTime())
    ? new Date(to.getTime() - 24 * HOUR_MS)
    : fromDate;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    fromBucket: hourBucket(from),
    toBucket: hourBucket(to),
  };
}

function counterWhere(
  filters: ToolAuditFilters,
  period: ToolAuditPeriod,
): { sql: string; args: unknown[] } {
  const parts = ["bucket >= ?", "bucket <= ?"];
  const args: unknown[] = [period.fromBucket, period.toBucket];
  if (filters.role) {
    parts.push("role = ?");
    args.push(filters.role);
  }
  if (filters.model) {
    parts.push("model = ?");
    args.push(filters.model);
  }
  if (filters.operation) {
    parts.push("operation = ?");
    args.push(filters.operation);
  }
  return { sql: parts.join(" AND "), args };
}

function recordWhere(
  filters: ToolAuditFilters,
): { sql: string; args: unknown[] } {
  const from = isoToSqlite(filters.from ?? "") ?? "1970-01-01 00:00:00";
  const to = isoToSqlite(filters.to ?? "") ?? "2999-12-31 23:59:59";
  const parts = ["datetime(created_at) >= datetime(?)", "datetime(created_at) <= datetime(?)"];
  const args: unknown[] = [from, to];
  if (filters.role) {
    parts.push("role = ?");
    args.push(filters.role);
  }
  if (filters.model) {
    parts.push("model = ?");
    args.push(filters.model);
  }
  if (filters.operation) {
    parts.push("operation = ?");
    args.push(filters.operation);
  }
  if (filters.code) {
    parts.push("error_code = ?");
    args.push(filters.code);
  }
  if (filters.taskId) {
    parts.push("task_id = ?");
    args.push(filters.taskId);
  }
  if (filters.subtaskId) {
    parts.push("subtask_id = ?");
    args.push(filters.subtaskId);
  }
  return { sql: parts.join(" AND "), args };
}

type Slice = { key: string; calls: number; errors: number; error_rate: number };

function sliceOf(
  dimension: "role" | "model" | "operation",
  filters: ToolAuditFilters,
  period: ToolAuditPeriod,
): Slice[] {
  const where = counterWhere(filters, period);
  const rows = db
    .prepare(
      `SELECT ${dimension} AS key, SUM(calls) AS calls, SUM(errors) AS errors
         FROM role_tool_audit_counters
        WHERE ${where.sql}
        GROUP BY ${dimension}
        ORDER BY calls DESC`,
    )
    .all(...where.args) as Array<{ key: string; calls: number; errors: number }>;
  return rows.map((row) => ({
    key: row.key,
    calls: row.calls,
    errors: row.errors,
    error_rate: row.calls ? Number((row.errors / row.calls).toFixed(4)) : 0,
  }));
}

export type ToolAuditSummary = {
  period: { from: string; to: string; granularity: "hour" };
  totals: {
    calls: number;
    errors: number;
    error_rate: number;
    /** Сколько вызовов сервер починил сам (форма вызова) и выполнил. */
    repairs: number;
  };
  by_role: Slice[];
  by_model: Slice[];
  by_operation: Slice[];
  by_code: Array<{ code: string; errors: number; share_of_errors: number; share_of_calls: number }>;
};

/**
 * Сводка за период: сколько вызовов, сколько ошибок и доля ошибок в
 * разрезах роли, модели, операции и кода ошибки.
 */
export function toolAuditSummary(filters: ToolAuditFilters): ToolAuditSummary {
  const period = toolAuditPeriod(filters);
  const where = counterWhere(filters, period);
  const totalsRow = db
    .prepare(
      `SELECT COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(errors),0) AS errors
         FROM role_tool_audit_counters
        WHERE ${where.sql}`,
    )
    .get(...where.args) as { calls: number; errors: number };
  const calls = totalsRow.calls ?? 0;
  const errors = totalsRow.errors ?? 0;

  const recordWhereSql = recordWhere({ ...filters, from: period.from, to: period.to });
  const codeRows = db
    .prepare(
      `SELECT error_code AS code, COUNT(*) AS errors
         FROM role_tool_audit
        WHERE ${recordWhereSql.sql} AND error_code IS NOT NULL
        GROUP BY error_code
        ORDER BY errors DESC`,
    )
    .all(...recordWhereSql.args) as Array<{ code: string; errors: number }>;

  const repairsRow = db
    .prepare(
      `SELECT COUNT(*) AS repairs
         FROM role_tool_audit
        WHERE ${recordWhereSql.sql} AND outcome = 'repaired'`,
    )
    .get(...recordWhereSql.args) as { repairs: number };
  const repairs = repairsRow.repairs ?? 0;

  return {
    period: { from: period.from, to: period.to, granularity: "hour" },
    totals: {
      calls,
      errors,
      error_rate: calls ? Number((errors / calls).toFixed(4)) : 0,
      repairs,
    },
    by_role: sliceOf("role", filters, period),
    by_model: sliceOf("model", filters, period),
    by_operation: sliceOf("operation", filters, period),
    by_code: codeRows.map((row) => ({
      code: row.code,
      errors: row.errors,
      share_of_errors: errors ? Number((row.errors / errors).toFixed(4)) : 0,
      share_of_calls: calls ? Number((row.errors / calls).toFixed(4)) : 0,
    })),
  };
}

/**
 * Сырые записи об отказах — то, что уходит в выгрузку.
 *
 * Успешные вызовы теперь тоже лежат в `role_tool_audit` (A1: событие на
 * каждое действие), но выгрузка и панель ошибок остаются про отказы:
 * иначе 87 % строк — успехи и отказ не найти. Поток действий целиком
 * читается тем же фильтром с `includeOk`.
 */
export function toolAuditRecords(
  filters: ToolAuditFilters,
  limit = 1000,
  includeOk = false,
): ToolAuditRecord[] {
  const where = recordWhere(filters);
  const capped = Math.max(1, Math.min(Number(limit) || 1000, 10_000));
  const onlyRefusals = includeOk ? "" : " AND outcome <> 'ok'";
  return db
    .prepare(
      `SELECT id, created_at, role, model, provider, mode, scope, item_id,
              run_id, task_id, subtask_id, action, tool, operation, outcome,
              error_code, error_message, error_field, error_expected, dup_of,
              duration_ms, request_id
         FROM role_tool_audit
        WHERE ${where.sql}${onlyRefusals}
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ?`,
    )
    .all(...where.args, capped) as ToolAuditRecord[];
}

const CSV_COLUMNS: Array<keyof ToolAuditRecord> = [
  "created_at",
  "role",
  "model",
  "provider",
  "mode",
  "scope",
  "item_id",
  "run_id",
  "task_id",
  "subtask_id",
  "action",
  "tool",
  "operation",
  "outcome",
  "error_code",
  "error_message",
  "error_field",
  "error_expected",
  "dup_of",
  "duration_ms",
  "request_id",
];

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

/** Выгрузка в CSV: та же выгрузка, что и в JSON, но одной таблицей. */
export function toolAuditCsv(records: ToolAuditRecord[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const record of records) lines.push(CSV_COLUMNS.map((key) => csvCell(record[key])).join(","));
  return lines.join("\n") + "\n";
}

/** Проба учёта для сторожа: запись проходит и читается обратно. */
export function checkToolAudit(): { ok: boolean; reason?: string } {
  try {
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM role_tool_audit").get() as { n: number }
    ).n;
    recordToolAudit({
      role: "tool-audit-probe",
      model: "probe",
      operation: "probe",
      outcome: "error",
      errorCode: "PROBE",
      errorMessage: "проба учёта",
    });
    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM role_tool_audit").get() as { n: number }
    ).n;
    const probe = db
      .prepare(
        "SELECT id FROM role_tool_audit WHERE role='tool-audit-probe' ORDER BY datetime(created_at) DESC LIMIT 1",
      )
      .get() as { id: string } | undefined;
    if (after !== before + 1 || !probe) return { ok: false, reason: "запись не читается обратно" };
    db.prepare("DELETE FROM role_tool_audit WHERE id = ?").run(probe.id);
    db.prepare(
      "DELETE FROM role_tool_audit_counters WHERE role='tool-audit-probe' AND model='probe'",
    ).run();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}
