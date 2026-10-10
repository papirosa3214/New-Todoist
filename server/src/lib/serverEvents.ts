/**
 * Общий серверный журнал событий с привязкой к операциям (карточка e87cd93f).
 *
 * Контракт:
 *  - `logServerEvent({...})` записывает одну структурированную строку в
 *    `server_events` (см. миграцию 128). Любые исключения внутри записи
 *    проглатываются: журнал не должен сам валить сервер.
 *  - `recordServerOperation({...})` создаёт временную обвязку для
 *    одной операции: сразу пишет стартовое событие, возвращает объект
 *    с методами `ok`, `err`, `timeout`, `cancel` и свойством
 *    `step`. Все методы автоматически проставляют outcome, duration_ms
 *    и общий operation_id.
 *  - Перед записью данные прогоняются через `redactServerEventData`:
 *    убираются секреты, длинные строки обрезаются. Журнал смотрит
 *    владелец — туда не должно попасть ничего, что можно показать
 *    постороннему или использовать против хозяина сервера.
 *
 * Обвязка:
 *  - процесс стартует → lifecycle.process_boot (index.ts)
 *  - процесс завершается → lifecycle.process_shutdown (index.ts)
 *  - 5xx ответ маршрута → http_error.route_error (index.ts)
 *  - unhandledRejection / uncaughtException → system.unhandled_error (index.ts)
 *  - запуск роли → role_run.role_run_{started,succeeded,failed,timeout}
 *  - вызов MCP-инструмента → mcp.mcp_call_{started,ok,err,timeout}
 *  - вызов обогатителя → enricher.enricher_call_{started,ok,err,timeout}
 *  - постановка в очередь ролей → queue.queue_enqueued
 *  - просроченный claim → queue.queue_expired
 *  - отложенный job → queue.queue_deferred
 *  - сдохший job → queue.queue_dead
 *
 * Журнал append-only по замыслу: ни один маршрут не правит и не стирает
 * строки `server_events`. Очистка старых строк — отдельная задача модуля
 * (`pruneServerEvents`, шаг «Настройка ротации логов и ограничения
 * хранения» карточки e87cd93f). Эту функцию вызывает периодический
 * планировщик, поднимаемый из `index.ts` через
 * `startServerEventsRetention()`. Удаление идёт по `created_at`; на
 * операционные индексы это не влияет, потому что строки удаляются
 * пакетом и за один проход таблица не перегружается.
 */
import crypto from "node:crypto";
import db from "../db.js";

export type ServerEventScope =
  | "lifecycle"
  | "queue"
  | "role_run"
  | "mcp"
  | "enricher"
  | "http_error"
  | "system";

export type ServerEventOutcome = "ok" | "err" | "timeout" | "skipped" | "cancelled";

export type ServerEventInput = {
  scope: ServerEventScope;
  kind: string;
  operationId?: string | null;
  actorId?: string | null;
  taskId?: string | null;
  subtaskId?: string | null;
  subtype?: string | null;
  message?: string | null;
  data?: Record<string, unknown> | null;
  durationMs?: number | null;
  outcome?: ServerEventOutcome | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type ServerEventRecord = {
  id: string;
  operationId: string | null;
  createdAt: string;
};

const MAX_MESSAGE_BYTES = 1024;
const MAX_ERROR_MESSAGE_BYTES = 2048;
const MAX_JSON_BYTES = 8 * 1024;

// Ключи, значения которых вычищаются из data_json и message перед записью.
// Имена — по аналогии с redact-правилами Fastify (см. index.ts: вся та же
// причина: случайно залогированный токен — это уже утечка).
const REDACT_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "api_token",
  "api_key",
  "apikey",
  "authorization",
  "auth",
  "password",
  "secret",
  "cookie",
  "set-cookie",
  "x-taskflow-token",
  "session",
  "session_id",
  "bearer",
  "private_key",
]);

// Те же правила применяются и к message: если строка выглядит как
// `authorization: Bearer eyJ...` — это утечка. Эвристика намеренно грубая:
// лучше спрятать лишнее, чем пропустить настоящий токен.
const SECRET_LIKE_RE = new RegExp(
  [
    String.raw`(?:authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/=-]{8,}`,
    String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"',;]{6,}`,
    String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`,
  ].join("|"),
  "gi",
);

function clipString(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

function safeJson(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Buffer) return `<Buffer:${value.length}>`;
  if (depth > 6) return "[Truncated]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length && i < 32; i += 1) {
      out.push(safeJson(value[i], depth + 1, seen));
    }
    if (value.length > 32) out.push(`[…${value.length - 32} more]`);
    return out;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key of Object.keys(obj)) {
    if (count > 64) {
      out["__truncated__"] = `[${Object.keys(obj).length - count} more keys]`;
      break;
    }
    const lower = key.toLowerCase();
    if (REDACT_KEYS.has(lower)) {
      out[key] = "***";
      count += 1;
      continue;
    }
    out[key] = safeJson(obj[key], depth + 1, seen);
    count += 1;
  }
  return out;
}

function redactString(value: string): string {
  return value.replace(SECRET_LIKE_RE, (match) => {
    // Если в начале совпадения уже есть ключ (authorization/api_key/...) —
    // заменяем "ключ: <значение>" на "<ключ>: ***". Иначе значение
    // рассматриваем как самостоятельный токен: Bearer, JWT или просто
    // длинная строка.
    const prefixMatch = /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*/i.exec(match);
    if (prefixMatch) {
      const prefix = match.slice(0, prefixMatch[0].length);
      const tail = match.slice(prefixMatch[0].length).trim();
      if (/^bearer\s+/i.test(tail)) return `${prefix}Bearer ***`;
      if (/^eyJ/i.test(tail)) return `${prefix}[redacted-jwt]`;
      return `${prefix}***`;
    }
    if (/^bearer\s+/i.test(match)) return "Bearer ***";
    if (/^eyJ/i.test(match)) return "[redacted-jwt]";
    return "***";
  });
}

function redactServerEventData(input: ServerEventInput): {
  message: string | null;
  dataJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
} {
  let message: string | null = input.message ?? null;
  if (message) {
    message = redactString(message);
    message = clipString(message, MAX_MESSAGE_BYTES);
  }

  let errorMessage: string | null = input.errorMessage ?? null;
  if (errorMessage) {
    errorMessage = redactString(errorMessage);
    errorMessage = clipString(errorMessage, MAX_ERROR_MESSAGE_BYTES);
  }

  let dataJson: string | null = null;
  if (input.data) {
    const cleaned = safeJson(input.data, 0, new WeakSet());
    let json: string;
    try {
      json = JSON.stringify(cleaned);
    } catch {
      json = JSON.stringify({ unserializable: true });
    }
    // Дополнительная редакция поверх готовой строки: ловит JWT и Bearer,
    // которые могут оказаться в полях без чувствительных имён (например,
    // в свободной строке ответа эмбеддинга). safeJson уже убрал опасное
    // по имени ключа, это — по содержимому.
    json = redactString(json);
    if (json.length > MAX_JSON_BYTES) {
      json = clipString(json, MAX_JSON_BYTES - 32) + `…(truncated ${json.length}b)`;
    }
    dataJson = json;
  }

  let errorCode: string | null = input.errorCode ?? null;
  if (errorCode) {
    errorCode = clipString(errorCode.replace(/[^A-Za-z0-9_.:-]/g, "_"), 128);
  }

  return { message, dataJson, errorCode, errorMessage };
}

export function newServerOperationId(): string {
  return `op_${crypto.randomUUID()}`;
}

export function newServerEventId(): string {
  return `sev_${crypto.randomUUID()}`;
}

/**
 * Прямая запись одного события. Возвращает идентификатор строки и время
 * из БД — для мест, где вызов не связан с длинной операцией
 * (process_boot, queue_enqueued, http_error). Сбой записи глотается,
 * чтобы журнал не валил сервер.
 */
export function logServerEvent(input: ServerEventInput): ServerEventRecord | null {
  try {
    const id = newServerEventId();
    const redacted = redactServerEventData(input);
    db.prepare(
      `INSERT INTO server_events (
         id, operation_id, scope, kind, actor_id, task_id, subtask_id,
         subtype, message, data_json, duration_ms, outcome,
         error_code, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.operationId ?? null,
      input.scope,
      input.kind,
      input.actorId ?? null,
      input.taskId ?? null,
      input.subtaskId ?? null,
      input.subtype ?? null,
      redacted.message,
      redacted.dataJson,
      input.durationMs ?? null,
      input.outcome ?? null,
      redacted.errorCode,
      redacted.errorMessage,
    );
    return {
      id,
      operationId: input.operationId ?? null,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    // Последний рубеж: если INSERT упал (например, из-за блокировки БД),
    // мы НЕ хотим тащить ошибку наружу — это журнал, его собственные
    // сбои не должны ломать компонент, который им пользуется.
    console.warn(
      "[serverEvents] запись не удалась:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Стартовать операцию: сразу пишется первое событие `…_started`, и
 * возвращается обвязка, на которой можно вызвать финальные методы.
 *
 * Каждый финальный метод:
 *  - один раз (защита от двойного закрытия); повторные вызовы
 *    молча игнорируются;
 *  - пишет событие с тем же operation_id и пройденной длительностью;
 *  - нормализует outcome ("ok"/"err"/"timeout"/"cancelled"/"skipped").
 *
 * Если вызвать `cancel()` или `err()` без `ok()`, финальное событие всё
 * равно запишется — дыр в последовательности быть не должно.
 */
export type ServerOperationHandle = {
  operationId: string;
  startedAt: number;
  ok: (details?: {
    taskId?: string | null;
    subtaskId?: string | null;
    subtype?: string | null;
    message?: string | null;
    data?: Record<string, unknown> | null;
  }) => void;
  err: (details: {
    taskId?: string | null;
    subtaskId?: string | null;
    subtype?: string | null;
    message?: string | null;
    data?: Record<string, unknown> | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }) => void;
  timeout: (details: {
    taskId?: string | null;
    subtaskId?: string | null;
    subtype?: string | null;
    message?: string | null;
    data?: Record<string, unknown> | null;
  }) => void;
  cancel: (details?: {
    taskId?: string | null;
    subtaskId?: string | null;
    subtype?: string | null;
    message?: string | null;
    data?: Record<string, unknown> | null;
  }) => void;
};

export function recordServerOperation(input: {
  scope: ServerEventScope;
  kind: string;
  subtype?: string | null;
  actorId?: string | null;
  taskId?: string | null;
  subtaskId?: string | null;
  message?: string | null;
  data?: Record<string, unknown> | null;
  startedKind?: string; // например "role_run_started" вместо "role_run". По умолчанию `${kind}_started`.
}): ServerOperationHandle {
  const operationId = newServerOperationId();
  const startedAt = Date.now();
  const startedKind = input.startedKind ?? `${input.kind}_started`;

  logServerEvent({
    operationId,
    scope: input.scope,
    kind: startedKind,
    actorId: input.actorId ?? null,
    taskId: input.taskId ?? null,
    subtaskId: input.subtaskId ?? null,
    subtype: input.subtype ?? null,
    message: input.message ?? null,
    data: input.data ?? null,
  });

  let closed = false;
  const finish = (outcome: ServerEventOutcome, details: {
    taskId?: string | null;
    subtaskId?: string | null;
    subtype?: string | null;
    message?: string | null;
    data?: Record<string, unknown> | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }) => {
    if (closed) return;
    closed = true;
    logServerEvent({
      operationId,
      scope: input.scope,
      kind: `${input.kind}_${outcome}`,
      actorId: input.actorId ?? null,
      taskId: details.taskId ?? input.taskId ?? null,
      subtaskId: details.subtaskId ?? input.subtaskId ?? null,
      subtype: details.subtype ?? input.subtype ?? null,
      message: details.message ?? null,
      data: details.data ?? null,
      durationMs: Date.now() - startedAt,
      outcome,
      errorCode: details.errorCode ?? null,
      errorMessage: details.errorMessage ?? null,
    });
  };

  return {
    operationId,
    startedAt,
    ok: (details = {}) => finish("ok", details),
    err: (details) => finish("err", details),
    timeout: (details) => finish("timeout", details),
    cancel: (details = {}) => finish("cancelled", details),
  };
}

/**
 * Превращает произвольную ошибку в безопасную пару (code, message),
 * пригодную для журнала. Сначала пробует `error.name` (например,
 * `ToolError`, `TypeError`), иначе — `Error`. Сообщение проходит через
 * редактирование секретов.
 */
export function normalizeServerError(
  err: unknown,
  fallbackCode: string,
): { code: string; message: string } {
  if (err && typeof err === "object" && "name" in err && typeof (err as any).name === "string") {
    const name = (err as any).name as string;
    const rawMessage =
      "message" in err && typeof (err as any).message === "string"
        ? (err as any).message as string
        : "";
    const message = rawMessage
      ? redactString(clipString(rawMessage, MAX_ERROR_MESSAGE_BYTES))
      : "";
    return { code: clipString(name, 128), message };
  }
  if (typeof err === "string") {
    return { code: fallbackCode, message: redactString(clipString(err, MAX_ERROR_MESSAGE_BYTES)) };
  }
  return { code: fallbackCode, message: "" };
}

// ───────────────────────── ротация и лимит хранения ─────────────────────────
//
// Лимит хранения (по возрасту) — отдельная задача: ни одна запись в
// `server_events` сама себя не вычищает, чистку делает
// `pruneServerEvents`. Без неё таблица будет расти, и `byKind` за
// длинный период однажды станет дорогим.
//
// Управление:
//
//  - `DEFAULT_SERVER_EVENTS_RETENTION_DAYS` — дефолтный срок хранения
//    (дней). Переопределяется переменной окружения
//    `TASKFLOW_SERVER_EVENTS_RETENTION_DAYS` (положительное целое).
//  - `DEFAULT_SERVER_EVENTS_ROTATION_INTERVAL_MS` — дефолтный интервал
//    запуска чистки (мс). Переопределяется переменной окружения
//    `TASKFLOW_SERVER_EVENTS_ROTATION_INTERVAL_MS`. Можно отключить
//    (`=0`) — полезно для тестов, в проде интервал меньше минуты не
//    имеет смысла.
//  - `setServerEventsRetentionDays(value)` /
//    `setServerEventsRotationIntervalMs(value)` — программное
//    переопределение (используется в тестах и в проде, если в будущем
//    появится настройка через `server_settings`).
//
// Решения, которые здесь зафиксированы осознанно:
//
//  - чистка по `created_at`, а не по `id` или размеру файла: это
//    ровно тот критерий, который нужен владельцу («не старше N
//    дней»);
//  - порог округляется до целой секунды (SQLite хранит `created_at` в
//    формате `datetime('now')` без миллисекунд), но сравнение идёт по
//    ISO-строке — формат совпадает с точностью до секунды;
//  - `prune` возвращает число удалённых строк и порог; это полезно
//    и для диагностики, и для тестов;
//  - планировщик поднимается отдельной функцией
//    `startServerEventsRetention()` и не запускается из модуля
//    сам по себе — иначе unit-тесты на каждый `import` плагина
//    получили бы сторонний `setInterval`.

/** Сколько дней хранить записи `server_events` по умолчанию. */
export const DEFAULT_SERVER_EVENTS_RETENTION_DAYS = 180;

/** С какой периодичностью по умолчанию запускается чистка (мс). */
export const DEFAULT_SERVER_EVENTS_ROTATION_INTERVAL_MS = 60 * 60_000;

const SERVER_EVENTS_RETENTION_OVERRIDE = { value: undefined as number | undefined };
const SERVER_EVENTS_ROTATION_OVERRIDE = { value: undefined as number | undefined };

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

/** Текущий эффективный срок хранения (дней). */
export function getServerEventsRetentionDays(): number {
  const programmatic = SERVER_EVENTS_RETENTION_OVERRIDE.value;
  if (typeof programmatic === "number" && Number.isFinite(programmatic)) {
    return Math.max(0, Math.trunc(programmatic));
  }
  const fromEnv = envInt("TASKFLOW_SERVER_EVENTS_RETENTION_DAYS");
  if (typeof fromEnv === "number") {
    return Math.max(0, fromEnv);
  }
  return DEFAULT_SERVER_EVENTS_RETENTION_DAYS;
}

/** Текущий эффективный интервал ротации (мс). */
export function getServerEventsRotationIntervalMs(): number {
  const programmatic = SERVER_EVENTS_ROTATION_OVERRIDE.value;
  if (typeof programmatic === "number" && Number.isFinite(programmatic)) {
    return Math.max(0, Math.trunc(programmatic));
  }
  const fromEnv = envInt("TASKFLOW_SERVER_EVENTS_ROTATION_INTERVAL_MS");
  if (typeof fromEnv === "number") {
    return Math.max(0, fromEnv);
  }
  return DEFAULT_SERVER_EVENTS_ROTATION_INTERVAL_MS;
}

/**
 * Программно переопределить срок хранения (дней). Используется в
 * тестах. Передача `null` сбрасывает override и возвращает к
 * дефолту/env.
 */
export function setServerEventsRetentionDays(value: number | null): void {
  if (value === null || value === undefined) {
    SERVER_EVENTS_RETENTION_OVERRIDE.value = undefined;
    return;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("server_events retention_days должен быть неотрицательным целым");
  }
  SERVER_EVENTS_RETENTION_OVERRIDE.value = Math.trunc(value);
}

/**
 * Программно переопределить интервал ротации (мс). `0` — отключить
 * планировщик (тестам это удобно). `null` — к дефолту.
 */
export function setServerEventsRotationIntervalMs(value: number | null): void {
  if (value === null || value === undefined) {
    SERVER_EVENTS_ROTATION_OVERRIDE.value = undefined;
    return;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("server_events rotation_interval_ms должен быть неотрицательным целым");
  }
  SERVER_EVENTS_ROTATION_OVERRIDE.value = Math.trunc(value);
}

export type ServerEventsPruneResult = {
  removed: number;
  remaining: number;
  retentionDays: number;
  /** ISO-строка, ниже которой строки считались устаревшими. */
  threshold: string;
  /** Реальное время запуска (для диагностики). */
  ranAt: string;
};

/**
 * Удаляет записи `server_events` старше указанного срока. По умолчанию
 * использует текущее значение `getServerEventsRetentionDays()`. Если
 * срок = 0 — удаляются ВСЕ строки (используется только в тестах/
 * разовых разовых чистках; в проде не выставляйте 0).
 *
 * Возвращает счётчик удалённых и оставшихся строк. Если во время
 * удаления БД недоступна — пробрасывает ошибку наверх: ротация —
 * фоновая операция, без отказа она бы тихо сидела «вечно».
 */
export function pruneServerEvents(options: {
  retentionDays?: number;
  now?: Date;
} = {}): ServerEventsPruneResult {
  const ranAt = (options.now ?? new Date()).toISOString();
  const retentionDays =
    options.retentionDays !== undefined
      ? Math.max(0, Math.trunc(options.retentionDays))
      : getServerEventsRetentionDays();
  const baseTime = (options.now ?? new Date()).getTime();
  const threshold = new Date(baseTime - retentionDays * 24 * 60 * 60_000);
  const thresholdIso = threshold.toISOString();
  // SQLite хранит `created_at` как `datetime('now')` с секундной
  // точностью; ISO-строка миллисекундной точности сравнивается со
  // строковым форматом «лексикографически» — `2026-10-10T12:00:00`
  // меньше `2026-10-10T12:00:00.123Z`, итого сравнение работает
  // корректно и с миллисекундами, и без.
  const tx = db.transaction(() => {
    const info = db
      .prepare("DELETE FROM server_events WHERE created_at < ?")
      .run(thresholdIso);
    const remaining =
      (db.prepare("SELECT COUNT(*) AS n FROM server_events").get() as { n: number }).n ?? 0;
    return { removed: Number(info.changes ?? 0), remaining };
  });
  const { removed, remaining } = tx();
  return {
    removed,
    remaining,
    retentionDays,
    threshold: thresholdIso,
    ranAt,
  };
}

export type ServerEventsRetentionHandle = {
  /** Остановить периодическую чистку. Идемпотентно. */
  stop: () => void;
  /** Какой интервал сейчас актуален (мс). */
  intervalMs: number;
  /** Полная последняя сводка чистки (или null, если ещё не было). */
  lastResult: ServerEventsPruneResult | null;
};

const ACTIVE_RETENTION = new Set<ServerEventsRetentionHandle>();

/**
 * Поднять периодическую чистку. По умолчанию — раз в час, интервал
 * переопределяется через env/override. `intervalMs = 0` — планировщик
 * НЕ запускается, выполнится одна синхронная чистка и вернётся
 * «выключенный» handle. Это удобно для тестов: запустили прогон,
 * дёрнули `pruneServerEvents` руками и проверили результат без
 * интервалов.
 *
 * Любые ошибки `pruneServerEvents` глушатся в `console.warn`, чтобы
 * поломанная БД не валила процесс; следующий тик через час попробует
 * снова.
 */
export function startServerEventsRetention(options: {
  intervalMs?: number;
  retentionDays?: number;
  now?: Date;
} = {}): ServerEventsRetentionHandle {
  const intervalMs =
    options.intervalMs !== undefined
      ? Math.max(0, Math.trunc(options.intervalMs))
      : getServerEventsRotationIntervalMs();
  let lastResult: ServerEventsPruneResult | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const handle: ServerEventsRetentionHandle = {
    intervalMs,
    get lastResult() {
      return lastResult;
    },
    stop: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      ACTIVE_RETENTION.delete(handle);
    },
  };
  // Первая чистка — сразу, чтобы запись «200 дней назад» не лежала
  // до следующего тика. Если ротация выключена (`intervalMs = 0`) —
  // всё равно делаем первый прогон, иначе ручной запуск без
  // планировщика был бы бесполезен.
  try {
    lastResult = pruneServerEvents({
      retentionDays: options.retentionDays,
      now: options.now,
    });
  } catch (error) {
    console.warn(
      "[serverEvents] первичная чистка не удалась:",
      error instanceof Error ? error.message : error,
    );
  }
  if (intervalMs > 0 && typeof setInterval === "function") {
    timer = setInterval(() => {
      try {
        lastResult = pruneServerEvents();
      } catch (error) {
        console.warn(
          "[serverEvents] чистка по таймеру не удалась:",
          error instanceof Error ? error.message : error,
        );
      }
    }, intervalMs);
    // Ротация — не критическая работа; разрешаем процессу уйти без
    // висящего таймера.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    ACTIVE_RETENTION.add(handle);
  }
  return handle;
}

/** Остановить все активные планировщики ротации. Используется в
 *  тестах, чтобы интервал не висел между прогонами. */
export function stopAllServerEventsRetention(): void {
  for (const handle of Array.from(ACTIVE_RETENTION)) {
    handle.stop();
  }
}

