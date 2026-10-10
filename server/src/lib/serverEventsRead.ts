/**
 * Чтение и выгрузка общего серверного журнала событий (карточка e87cd93f,
 * шаг «Разработка API чтения и выгрузки диагностики»).
 *
 * Контракт API:
 *  - `listServerEvents`           — список с фильтрами, курсорная пагинация.
 *  - `getServerEventById`         — одна запись.
 *  - `getOperationChain`          — все события одной операции.
 *  - `getServerEventStats`        — счётчики по scope/kind/outcome за период.
 *  - `exportServerEvents`         — сериализация для скачивания владельцем.
 *
 * Правила (см. serverEvents.ts):
 *  - данные в БД уже прошли редакцию секретов (именованные ключи +
 *    JWT/Bearer/api_key), повторно править при чтении не нужно;
 *  - таблица append-only для записи: из этих функций в БД пишет
 *    ТОЛЬКО `pruneServerEvents` в serverEvents.ts (чистка старых строк
 *    по `created_at`). Все читающие функции SELECT-только;
 *  - все запросы идут под `db` (better-sqlite3) — синхронные и атомарные.
 *
 * Два разных лимита (их легко спутать — D3 карточки):
 *   * `MAX_LIMIT` (ниже) — размер страницы для UI (1..1000).
 *   * `SERVER_EVENTS_EXPORT_MAX_EVENTS` (внизу файла) — верхняя
 *     граница числа событий в одной выгрузке. Это размер ОДНОГО
 *     скачиваемого файла, а не лимит таблицы.
 *   * Срок хранения таблицы (`DEFAULT_SERVER_EVENTS_RETENTION_DAYS` в
 *     `serverEvents.ts`, по умолчанию 180 дней) — отдельная ось:
 *     «насколько далеко в прошлое читать можно». Ротация применяется
 *     периодически (`startServerEventsRetention`).
 *
 * Все читающие функции возвращают сериализуемый JSON: `data_json` парсится
 * в объект `data`, `created_at` отдаётся как ISO-строка (как в БД).
 */
import db from "../db.js";
import {
  type ServerEventScope,
  type ServerEventOutcome,
} from "./serverEvents.js";
import { snapshotSettings } from "./serverSettings.js";

export const SERVER_EVENT_SCOPES: readonly ServerEventScope[] = [
  "lifecycle",
  "queue",
  "role_run",
  "mcp",
  "enricher",
  "http_error",
  "system",
];

export const SERVER_EVENT_OUTCOMES: readonly ServerEventOutcome[] = [
  "ok",
  "err",
  "timeout",
  "skipped",
  "cancelled",
];

export type ServerEventRow = {
  id: string;
  operationId: string | null;
  scope: ServerEventScope;
  kind: string;
  actorId: string | null;
  taskId: string | null;
  subtaskId: string | null;
  subtype: string | null;
  message: string | null;
  data: unknown;
  durationMs: number | null;
  outcome: ServerEventOutcome | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export type ServerEventFilters = {
  /** ISO-строка вида "2026-10-10T00:00:00Z". Сравнение по строке —
   *  SQLite хранит `created_at` в этом же формате через `datetime('now')`. */
  since?: string | null;
  until?: string | null;
  /** Один или несколько scope. Пусто/null = все. */
  scopes?: ServerEventScope[] | null;
  /** Подстрока или точный kind. Точный — если `kindExact=true`. */
  kind?: string | null;
  kindExact?: boolean;
  /** Фильтры по связанным сущностям. Пусто/null = не фильтруем. */
  taskId?: string | null;
  subtaskId?: string | null;
  operationId?: string | null;
  actorId?: string | null;
  /** Фильтр по исходу. */
  outcome?: ServerEventOutcome | null;
  /** Текст в message (LIKE %x%). */
  messageContains?: string | null;
  /** Пагинация. */
  limit?: number;
  /** Курсор формата `<created_at>|<id>` для чтения «после». */
  cursor?: string | null;
  /** Сортировка: 'asc' (по возрастанию) или 'desc' (по убыванию, по умолчанию). */
  order?: "asc" | "desc";
};

export type ServerEventListResult = {
  events: ServerEventRow[];
  nextCursor: string | null;
  totalEstimate: number | null;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function normalizeLimit(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  const n = Math.floor(value);
  if (n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
  if (!cursor || typeof cursor !== "string") return null;
  const idx = cursor.indexOf("|");
  if (idx <= 0 || idx === cursor.length - 1) return null;
  const createdAt = cursor.slice(0, idx);
  const id = cursor.slice(idx + 1);
  if (!/^sev_/.test(id)) return null;
  return { createdAt, id };
}

function encodeCursor(row: { createdAt: string; id: string }): string {
  return `${row.createdAt}|${row.id}`;
}

type WhereClause = { sql: string; params: unknown[] };

function buildWhere(filters: ServerEventFilters, order: "asc" | "desc"): WhereClause {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const isDesc = order === "desc";

  if (filters.since) {
    clauses.push(isDesc ? "created_at <= ?" : "created_at >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    clauses.push(isDesc ? "created_at >= ?" : "created_at <= ?");
    params.push(filters.until);
  }
  const scopes = asArray(filters.scopes).filter((s) =>
    SERVER_EVENT_SCOPES.includes(s),
  );
  if (scopes.length > 0) {
    clauses.push(
      `scope IN (${scopes.map(() => "?").join(",")})`,
    );
    for (const s of scopes) params.push(s);
  }
  if (filters.kind) {
    if (filters.kindExact) {
      clauses.push("kind = ?");
      params.push(filters.kind);
    } else {
      clauses.push("kind LIKE ?");
      params.push(`${filters.kind}%`);
    }
  }
  if (filters.taskId) {
    clauses.push("task_id = ?");
    params.push(filters.taskId);
  }
  if (filters.subtaskId) {
    clauses.push("subtask_id = ?");
    params.push(filters.subtaskId);
  }
  if (filters.operationId) {
    clauses.push("operation_id = ?");
    params.push(filters.operationId);
  }
  if (filters.actorId) {
    clauses.push("actor_id = ?");
    params.push(filters.actorId);
  }
  if (filters.outcome) {
    clauses.push("outcome = ?");
    params.push(filters.outcome);
  }
  if (filters.messageContains) {
    clauses.push("message LIKE ?");
    params.push(`%${filters.messageContains}%`);
  }

  // Курсор: идём «после» (для desc — моложе) последней строки.
  const cursor = parseCursor(filters.cursor);
  if (cursor) {
    if (isDesc) {
      // desc: следующая страница — строки МЕНЬШЕ (created_at, id).
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    } else {
      // asc: следующая страница — строки БОЛЬШЕ.
      clauses.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
  }

  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function rowFromDb(row: Record<string, unknown>): ServerEventRow {
  let data: unknown = null;
  if (typeof row.data_json === "string" && row.data_json.length > 0) {
    try {
      data = JSON.parse(row.data_json);
    } catch {
      data = { __unparseable__: row.data_json };
    }
  }
  return {
    id: String(row.id),
    operationId: (row.operation_id as string | null) ?? null,
    scope: row.scope as ServerEventScope,
    kind: String(row.kind),
    actorId: (row.actor_id as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    subtaskId: (row.subtask_id as string | null) ?? null,
    subtype: (row.subtype as string | null) ?? null,
    message: (row.message as string | null) ?? null,
    data,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    outcome: (row.outcome as ServerEventOutcome | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

/**
 * Список событий с фильтрами и курсорной пагинацией. `totalEstimate` —
 * приблизительный счётчик по фильтру (LIMIT+1) для UI; точный COUNT(*)
 * намеренно не делаем — таблица будет расти, и это дорого. Если нужно
 * «сколько всего за час» — отдельная функция `getServerEventStats`.
 */
export function listServerEvents(
  filters: ServerEventFilters = {},
): ServerEventListResult {
  const order: "asc" | "desc" = filters.order === "asc" ? "asc" : "desc";
  const limit = normalizeLimit(filters.limit);
  const where = buildWhere(filters, order);

  const rows = db
    .prepare(
      `SELECT id, operation_id, scope, kind, actor_id, task_id, subtask_id,
              subtype, message, data_json, duration_ms, outcome,
              error_code, error_message, created_at
         FROM server_events
         ${where.sql}
         ORDER BY created_at ${order === "asc" ? "ASC" : "DESC"}, id ${order === "asc" ? "ASC" : "DESC"}
         LIMIT ?`,
    )
    .all(...where.params, limit + 1) as Array<Record<string, unknown>>;

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const events = slice.map(rowFromDb);
  const last = events[events.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  return { events, nextCursor, totalEstimate: hasMore ? null : events.length };
}

/**
 * Одна запись по id. Возвращает null, если такой строки нет — это не
 * ошибка вызывающего кода, просто запись могла быть удалена ротацией.
 */
export function getServerEventById(id: string): ServerEventRow | null {
  if (!id || typeof id !== "string") return null;
  const row = db
    .prepare(
      `SELECT id, operation_id, scope, kind, actor_id, task_id, subtask_id,
              subtype, message, data_json, duration_ms, outcome,
              error_code, error_message, created_at
         FROM server_events
        WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowFromDb(row) : null;
}

/**
 * Полная цепочка одной операции, упорядоченная по времени создания.
 * Используется, когда нужно показать весь жизненный цикл: старт →
 * терминальное событие →, возможно, промежуточные mcp/enricher.
 *
 * Не пагинируется внутри: операция в норме короткая (единицы записей),
 * предел MAX_OPERATION_EVENTS защищает от гигантских выборок на случай,
 * если кто-то случайно начал писать operation_id без группировки.
 */
export const MAX_OPERATION_EVENTS = 500;

export function getOperationChain(operationId: string): {
  events: ServerEventRow[];
  truncated: boolean;
} {
  if (!operationId || typeof operationId !== "string") {
    return { events: [], truncated: false };
  }
  const rows = db
    .prepare(
      `SELECT id, operation_id, scope, kind, actor_id, task_id, subtask_id,
              subtype, message, data_json, duration_ms, outcome,
              error_code, error_message, created_at
         FROM server_events
        WHERE operation_id = ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
    .all(operationId, MAX_OPERATION_EVENTS + 1) as Array<Record<string, unknown>>;
  const truncated = rows.length > MAX_OPERATION_EVENTS;
  const slice = truncated ? rows.slice(0, MAX_OPERATION_EVENTS) : rows;
  return { events: slice.map(rowFromDb), truncated };
}

/**
 * Сводка за период: счётчики по scope и по (scope,kind). Удобно для
 * «что упало за последние сутки» — без прокрутки тысяч строк.
 *
 * Лимит количества уникальных kind в ответе — TOP_KINDS, чтобы карточка
 * оставалась компактной. Хвост склеен в «(other kinds)».
 */
export const TOP_KINDS = 25;

export type ServerEventStats = {
  filters: ServerEventFilters;
  total: number;
  byScope: Array<{ scope: ServerEventScope; count: number }>;
  byOutcome: Array<{ outcome: ServerEventOutcome | "null"; count: number }>;
  byKind: Array<{ scope: ServerEventScope; kind: string; count: number }>;
  /** Самые top-25 (scope,kind), остальные агрегированы в `byKindOverflow`. */
  byKindOverflow: number;
};

export function getServerEventStats(
  filters: ServerEventFilters = {},
): ServerEventStats {
  const order: "asc" | "desc" = filters.order === "asc" ? "asc" : "desc";
  const where = buildWhere(filters, order);

  const total =
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM server_events ${where.sql}`)
        .get(...where.params) as { n: number }
    ).n ?? 0;

  const byScopeRows = db
    .prepare(
      `SELECT scope, COUNT(*) AS n FROM server_events ${where.sql}
       ${where.sql ? "AND" : "WHERE"} scope IS NOT NULL
       GROUP BY scope
       ORDER BY n DESC`,
    )
    .all(...where.params) as Array<{ scope: ServerEventScope; n: number }>;
  const byOutcomeRows = db
    .prepare(
      `SELECT COALESCE(outcome, 'null') AS outcome, COUNT(*) AS n
         FROM server_events ${where.sql}
         GROUP BY COALESCE(outcome, 'null')
         ORDER BY n DESC`,
    )
    .all(...where.params) as Array<{ outcome: string; n: number }>;

  const byKindRows = db
    .prepare(
      `SELECT scope, kind, COUNT(*) AS n FROM server_events ${where.sql}
       ${where.sql ? "AND" : "WHERE"} kind IS NOT NULL
       GROUP BY scope, kind
       ORDER BY n DESC
       LIMIT ?`,
    )
    .all(...where.params, TOP_KINDS + 1) as Array<{
    scope: ServerEventScope;
    kind: string;
    n: number;
  }>;

  const overflow = byKindRows.length > TOP_KINDS
    ? byKindRows.slice(TOP_KINDS).reduce((sum, r) => sum + r.n, 0)
    : 0;
  const byKind = byKindRows.slice(0, TOP_KINDS).map((r) => ({
    scope: r.scope,
    kind: r.kind,
    count: r.n,
  }));

  return {
    filters,
    total,
    byScope: byScopeRows.map((r) => ({ scope: r.scope, count: r.n })),
    byOutcome: byOutcomeRows.map((r) => ({
      outcome: r.outcome as ServerEventOutcome | "null",
      count: r.n,
    })),
    byKind,
    byKindOverflow: overflow,
  };
}

/**
 * Сборка пакета для скачивания: серверные настройки + фильтры + события.
 * Дополнительно — компактные счётчики. Возвращается как готовый объект,
 * который сериализуется в JSON или NDJSON вызывающим кодом.
 */
export type ExportPayload = {
  format_version: 1;
  generated_at: string;
  server: {
    node: string;
    commit: string | null;
  };
  filters: ServerEventFilters;
  counts: Pick<ServerEventStats, "total" | "byScope" | "byOutcome">;
  settings: Record<string, unknown>;
  events: ServerEventRow[];
};

export function buildExportPayload(
  filters: ServerEventFilters,
  events: ServerEventRow[],
  counts: Pick<ServerEventStats, "total" | "byScope" | "byOutcome">,
  server: { node: string; commit: string | null },
): ExportPayload {
  return {
    format_version: 1,
    generated_at: new Date().toISOString(),
    server,
    filters,
    counts,
    settings: snapshotSettings(),
    events,
  };
}

/**
 * Сериализация пакета в NDJSON (по одной записи на строку) — удобно для
 * `grep`/`jq` в консоли. `data` каждой записи остаётся вложенным JSON.
 */
export function serializeNdjson(events: ServerEventRow[]): string {
  const out: string[] = [];
  for (const e of events) out.push(JSON.stringify(e));
  // Финальный перевод строки — обычные тулзы ожидают, что последняя запись
  // тоже заканчивается \n; без него скрипты `tail -1` теряют последнее.
  return out.join("\n") + (out.length ? "\n" : "");
}

/**
 * Верхняя граница числа событий в ОДНОЙ выгрузке (`/export`) — это
 * лимит размера файла, а не лимит хранения. Если фильтр вернул больше
 * строк — экспорт обрежет хвост и предупредит владельца в ответе; для
 * большого периода нужно несколько экспортов по подпериоду.
 *
 * Лимит ХРАНЕНИЯ таблицы — отдельная ось, см. `serverEvents.ts` →
 * `DEFAULT_SERVER_EVENTS_RETENTION_DAYS` (ротация периодически
 * удаляет строки старше этого срока).
 */
export const SERVER_EVENTS_EXPORT_MAX_EVENTS = 5000;