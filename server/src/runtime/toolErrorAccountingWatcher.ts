// Сторож учёта ошибок вызовов инструментов ролей (карточка 64af4c85-…,
// часть 2 «сторож»). Правило приборов и сторожей — CLAUDE.md, docs/watchers.md.
//
// Что сторожит. Учёт отклонённых вызовов ролей: server/src/runtime/
// toolAuditStore.ts — таблица `role_tool_audit` (строка на отказ: время, роль,
// модель, провайдер, операция, код ошибки) и `role_tool_audit_counters`
// (счётчики вызовов и ошибок по часу и разрезам). На этом приборе стоят
// сводка и выгрузка ошибок.
//
// Почему сторож обязателен. Шлюз (runtime/universalTaskflow.ts) отсекает
// неверный вызов ДО того, как он попал в журнал операций `role_tool_requests`:
// тот знает только операции с request_id. Поэтому «таблица учёта есть» ничего
// не значит — шлюз может молча перестать писать в неё, и роли будут ошибаться
// дальше, а сводка покажет ноль ошибок. Разбирать придётся по журналам ходов
// руками, ровно как 20.10.2026 разбирали 15 `discover` подряд у секретаря.
//
// Как проверяет. ПРОБНЫМ ХОДОМ: тот же шлюз, которым ходят роли
// (createUniversalTaskflow), получает заведомо ошибочные вызовы — с неверным
// типом аргумента у настоящей операции и с несуществующей операцией — плюс
// один настоящий успешный вызов (счётчик успешных вызовов тоже прибор: без
// него доля ошибок в сводке неверна). Проба идёт под отдельной ролью и
// отдельной моделью, поэтому её следы видны и их можно убрать: проба не
// портит статистику ошибок.
//
// Тревога. Уведомление владельцу в «Состояние системы» (notifications, тип
// tool_error_accounting_watch), не чаще одного раза в сутки. Карточек не
// заводим: тревоги сторожей — шум для доски (владелец 13.10.2026).
// Текст тревоги отвечает на три вопроса (CLAUDE.md, «Правило приборов и
// сторожей», п.3): что сломано, что от этого ломается дальше, что делать.
// Целый текст НЕ обрезается: режется только список замечаний, чтобы хвост
// «что делать» не терялся (карточка 64af4c85, D2).

import crypto from "node:crypto";

import db from "../db.js";
import { roleToolAllowed } from "../lib/roleToolScope.js";
import { createUniversalTaskflow, type Context, type Tool } from "./universalTaskflow.js";
import { taskflowTools } from "./inProcessRun.js";
import { toolRequestStore } from "./toolRequestStore.js";

export const TOOL_ERROR_ACCOUNTING_WATCH_TYPE = "tool_error_accounting_watch";

/** Роль и модель пробы: отдельные, чтобы следы пробы были видны и убирались. */
const PROBE_ROLE = "tool_audit_watch_probe";
const PROBE_MODEL = "tool-audit-watch-probe";
const PROBE_RUN_PREFIX = "tool-audit-watch-run-";
const PROBE_OPERATION_PREFIX = "taskflow_probe_accounting_";

/** Таблицы прибора. Имена — контракт с частью 1 карточки (учёт и API). */
const AUDIT_TABLE = "role_tool_audit";
const COUNTERS_TABLE = "role_tool_audit_counters";

/** Успешный вызов пробы: операция без аргументов, ничего не меняет. */
const PROBE_SUCCESS_OPERATION = "taskflow_rules";

export type ToolAuditProbe = {
  /** Отклонил ли шлюз вызов. */
  kind: "rejected" | "accepted";
  operation: string;
  /** Код отказа шлюза или "OK". */
  code: string;
  message?: string;
};

export type ToolAuditEvidence = {
  /** Строки учёта, найденные по следам пробы. */
  rows: Array<Record<string, unknown>>;
  /** Есть ли в таблице счётчиков нужные колонки. */
  countersSupported: boolean;
  calls: number;
  errors: number;
  byOperation: Record<string, { calls: number; errors: number }>;
};

/**
 * Что именно сломано. От области зависит, что тревога советует чинить:
 * «запись отказов» и «счётчики» — разные поломки с разными последствиями
 * (карточка 64af4c85, D3: при сломанной записи отказов счётчик успешных
 * вызовов остаётся целым, и владельца нельзя уводить чинить счётчики).
 */
export type ToolAuditFaultArea = "audit" | "counters" | "gateway" | "probe";

export type ToolAuditFault = {
  /** Область поломки. */
  area: ToolAuditFaultArea;
  /** Текст замечания — в тревоге идёт владельцу. */
  text: string;
};

export type ToolErrorAccountingWatchResult = {
  ok: boolean;
  /** Замечания текстом — для журнала сервера и отчёта. */
  problems: string[];
  /** Замечания с указанием, что именно сломано, — для тревоги. */
  faults: ToolAuditFault[];
  probes: ToolAuditProbe[];
};

let cachedTools: Tool[] | null = null;

/**
 * Каталог операций для пробы — тот же, что у роли. Берётся один раз и
 * переиспользуется: проба зовёт шлюз, а не операции, поэтому исполнять
 * инструменты пробы не нужно.
 */
function probeTools(): Tool[] {
  if (!cachedTools) {
    cachedTools = taskflowTools(
      "secretary",
      null,
      undefined,
      undefined,
      true,
      { chatId: "", messageId: "" },
    ) as unknown as Tool[];
  }
  return cachedTools;
}

function parseEnvelope(out: {
  content?: Array<{ type?: string; text?: string }>;
}): { ok: boolean; code?: string; message?: string } {
  const text =
    out?.content?.find((part) => part?.type === "text")?.text ?? "{}";
  try {
    const parsed = JSON.parse(text);
    if (parsed?.ok) return { ok: true };
    return {
      ok: false,
      code: parsed?.error?.code ?? "UNKNOWN",
      message: parsed?.error?.message,
    };
  } catch {
    return { ok: false, code: "UNREADABLE", message: text.slice(0, 200) };
  }
}

/**
 * Пробный ход: три вызова через настоящий шлюз ролей. Два — заведомо
 * ошибочные (их обязан отклонить шлюз и записать в учёт), третий — успешный
 * (его обязан посчитать счётчик вызовов).
 */
async function runProbe(nonce: string): Promise<ToolAuditProbe[]> {
  const context: Context = {
    actor: `role_${PROBE_ROLE}`,
    role: PROBE_ROLE,
    mode: "work",
    runId: `${PROBE_RUN_PREFIX}${nonce}`,
    model: PROBE_MODEL,
    // Права роли — как у настоящей роли, иначе пробу отсекло бы правилом
    // доступа и она ничего не проверяла бы.
    authorize: (name) => roleToolAllowed("secretary", name),
  };
  const gateway = createUniversalTaskflow(probeTools(), context, toolRequestStore);
  const calls: Array<{ operation: string; args: Record<string, unknown> }> = [
    // Неверный тип аргумента у настоящей операции — ошибка проверки.
    { operation: "taskflow_task", args: { id: 424242 } },
    // Несуществующая операция — вторая настоящая ошибка роли.
    { operation: `${PROBE_OPERATION_PREFIX}${nonce}`, args: {} },
    // Настоящий успешный вызов: счётчик успешных вызовов тоже прибор.
    { operation: PROBE_SUCCESS_OPERATION, args: {} },
  ];
  const probes: ToolAuditProbe[] = [];
  for (const call of calls) {
    const out = await gateway.execute(`probe-${nonce}`, {
      action: "invoke",
      operation: call.operation,
      version: 1,
      arguments: call.args,
    });
    const envelope = parseEnvelope(out);
    probes.push({
      kind: envelope.ok ? "accepted" : "rejected",
      operation: call.operation,
      code: envelope.ok ? "OK" : (envelope.code ?? "UNKNOWN"),
      message: envelope.ok ? undefined : envelope.message,
    });
  }
  return probes;
}

function tableExists(name: string): boolean {
  try {
    return !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  } catch {
    return false;
  }
}

function columnsOf(table: string): string[] {
  try {
    return (
      db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
  } catch {
    return [];
  }
}

/** Вся строка таблицы как текст — чтобы искать следы пробы по любой колонке. */
function rowTextExpr(table: string, columns: string[]): string {
  return columns
    .map((column) => `COALESCE(CAST("${column}" AS TEXT),'')`)
    .join(" || ' ' || ");
}

function sqliteTimestamp(at: Date = new Date()): string {
  return at.toISOString().replace("T", " ").slice(0, 19);
}

/** Строки учёта, в которых видны следы пробы. */
function findProbeRows(
  table: string,
  markers: string[],
  since: string,
): Array<Record<string, unknown>> {
  const columns = columnsOf(table);
  if (!columns.length) return [];
  const expr = rowTextExpr(table, columns);
  const fresh = columns.includes("created_at")
    ? " AND datetime(created_at) >= datetime(?)"
    : "";
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const marker of markers) {
    let found: Array<Record<string, unknown>> = [];
    try {
      found = db
        .prepare(
          `SELECT * FROM "${table}" WHERE instr(${expr}, ?) > 0${fresh}`,
        )
        .all(marker, ...(fresh ? [since] : [])) as Array<Record<string, unknown>>;
    } catch {
      found = [];
    }
    for (const row of found) {
      const key = String(row.id ?? JSON.stringify(row));
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

/** Счётчики пробы: сколько вызовов и ошибок записано по её роли. */
function counterTotals(table: string, role: string): {
  supported: boolean;
  calls: number;
  errors: number;
  byOperation: Record<string, { calls: number; errors: number }>;
} {
  const empty = {
    supported: false,
    calls: 0,
    errors: 0,
    byOperation: {} as Record<string, { calls: number; errors: number }>,
  };
  const columns = columnsOf(table);
  if (
    !columns.includes("calls") ||
    !columns.includes("errors") ||
    !columns.includes("role")
  )
    return empty;
  const operation = columns.includes("operation") ? "operation" : "''";
  try {
    const rows = db
      .prepare(
        `SELECT ${operation} AS op, SUM(calls) AS calls, SUM(errors) AS errors
           FROM "${table}" WHERE role = ? GROUP BY ${operation}`,
      )
      .all(role) as Array<{
      op: string | null;
      calls: number | null;
      errors: number | null;
    }>;
    const byOperation: Record<string, { calls: number; errors: number }> = {};
    let calls = 0;
    let errors = 0;
    for (const row of rows) {
      const key = row.op ?? "";
      const rowCalls = Number(row.calls ?? 0);
      const rowErrors = Number(row.errors ?? 0);
      byOperation[key] = { calls: rowCalls, errors: rowErrors };
      calls += rowCalls;
      errors += rowErrors;
    }
    return { supported: true, calls, errors, byOperation };
  } catch {
    return empty;
  }
}

/** Есть ли в строках учёта непустое значение в колонке с таким именем. */
function hasValue(
  rows: Array<Record<string, unknown>>,
  pattern: RegExp,
): boolean {
  for (const row of rows) {
    for (const [column, value] of Object.entries(row)) {
      if (!pattern.test(column)) continue;
      if (value === null || value === undefined) continue;
      if (String(value).trim() === "") continue;
      return true;
    }
  }
  return false;
}

/**
 * Суд по доказательствам: что именно сломалось. Отдельная чистая функция —
 * её проверяют тесты без базы.
 *
 * Различение поломок (D3 карточки 64af4c85). Запись вызова и счётчики идут
 * ОДНОЙ транзакцией (toolAuditStore.ts), поэтому:
 *  • если счётчик успешных вызовов цел, а строк об отказах нет — сломана
 *    именно запись отказов (`role_tool_audit`);
 *  • если не посчитан ни один вызов — сломаны счётчики, и строки об отказах
 *    падают вместе с ними;
 *  • следствие сломанной записи (потерянные счётчики отказов) отдельной
 *    поломкой не считается: уводить владельца чинить счётчики, когда сломана
 *    запись, — ложный след.
 */
export function evaluateToolAudit(
  probes: ToolAuditProbe[],
  evidence: ToolAuditEvidence | null,
): ToolAuditFault[] {
  const faults: ToolAuditFault[] = [];
  if (!probes.length) return faults;
  const rejected = probes.filter((probe) => probe.kind === "rejected");
  const accepted = probes.filter((probe) => probe.kind === "accepted");
  if (!rejected.length)
    faults.push({
      area: "gateway",
      text: "шлюз не отклонил пробный ошибочный вызов — проба не проверяет учёт",
    });
  if (!evidence) {
    faults.push({
      area: "probe",
      text: "в базе нет следов пробного хода",
    });
    return faults;
  }
  const notCounted = accepted.filter(
    (probe) => (evidence.byOperation[probe.operation]?.calls ?? 0) < 1,
  );
  const rowsMissing = evidence.rows.length === 0;
  if (rowsMissing) {
    if (notCounted.length) {
      // Не посчитан ни один вызов: первым падает счётчик, а запись отказов
      // уезжает вместе с ним (одна транзакция).
      faults.push({
        area: "counters",
        text: "счётчики вызовов сломаны: успешный вызов пробного хода не посчитан, и запись отказов падает вместе со счётчиком (одна транзакция) — строк об отказах тоже нет",
      });
    } else {
      // Счётчик успешных вызовов цел — сломана именно запись отказов.
      faults.push({
        area: "audit",
        text:
          "запись отказов сломана: отказ пробного вызова не попал в учёт — строки об отказах не пишутся (счётчик успешных вызовов при этом цел: в счётчиках вызовов " +
          String(evidence.calls) +
          ", ошибок " +
          String(evidence.errors) +
          ")",
      });
    }
  } else {
    if (!hasValue(evidence.rows, /role|роль/i))
      faults.push({ area: "audit", text: "в записи об отказе нет роли" });
    if (!hasValue(evidence.rows, /model|модел/i))
      faults.push({ area: "audit", text: "в записи об отказе нет модели" });
    if (!hasValue(evidence.rows, /operation|операц|tool|инструмент/i))
      faults.push({ area: "audit", text: "в записи об отказе нет операции" });
    if (!hasValue(evidence.rows, /code|код/i))
      faults.push({ area: "audit", text: "в записи об отказе нет кода ошибки" });
  }
  if (!evidence.countersSupported) {
    faults.push({
      area: "counters",
      text: "в таблице счётчиков нет колонок вызовов и ошибок",
    });
    return faults;
  }
  if (!rowsMissing) {
    for (const probe of notCounted)
      faults.push({
        area: "counters",
        text: `успешный вызов (${probe.operation}) не посчитан — доля ошибок в сводке будет неверной`,
      });
    if (evidence.errors < rejected.length)
      faults.push({
        area: "counters",
        text: "счётчик ошибок не считает отказы пробного хода — доля ошибок в сводке будет неверной",
      });
    if (evidence.calls < probes.length)
      faults.push({
        area: "counters",
        text: "счётчик вызовов не считает все вызовы пробного хода — доля ошибок в сводке будет неверной",
      });
  }
  return faults;
}

/** Убрать следы пробы: статистика ошибок не должна искажаться пробой. */
function cleanupProbe(
  auditTable: string | null,
  countersTable: string | null,
  markers: string[],
): void {
  for (const table of [auditTable, countersTable]) {
    if (!table) continue;
    const columns = columnsOf(table);
    if (!columns.length) continue;
    const expr = rowTextExpr(table, columns);
    for (const marker of markers) {
      try {
        db.prepare(`DELETE FROM "${table}" WHERE instr(${expr}, ?) > 0`).run(
          marker,
        );
      } catch {
        // Уборка не должна ронять проверку: след пробки в сводке — мелочь
        // против молчащей поломки прибора.
      }
    }
  }
}

/**
 * Проверка прибора: пробный ход через настоящий шлюз и сверка с учётом.
 * Возвращает вердикт и причины; сама тревогу не поднимает.
 */
export async function checkToolErrorAccounting(): Promise<ToolErrorAccountingWatchResult> {
  const nonce = crypto.randomBytes(6).toString("hex");
  const since = sqliteTimestamp();
  const faults: ToolAuditFault[] = [];
  const auditTable = tableExists(AUDIT_TABLE) ? AUDIT_TABLE : null;
  const countersTable = tableExists(COUNTERS_TABLE) ? COUNTERS_TABLE : null;
  if (!auditTable)
    faults.push({
      area: "audit",
      text: `в базе нет таблицы учёта отказов (${AUDIT_TABLE})`,
    });
  if (!countersTable)
    faults.push({
      area: "counters",
      text: `в базе нет таблицы счётчиков (${COUNTERS_TABLE})`,
    });
  let probes: ToolAuditProbe[] = [];
  if (auditTable && countersTable) {
    try {
      probes = await runProbe(nonce);
    } catch (error) {
      faults.push({
        area: "probe",
        text: `пробный ход не отработал: ${String(error)}`,
      });
    }
  }
  const markers = [
    PROBE_ROLE,
    PROBE_MODEL,
    `${PROBE_RUN_PREFIX}${nonce}`,
    `${PROBE_OPERATION_PREFIX}${nonce}`,
  ];
  let evidence: ToolAuditEvidence | null = null;
  if (auditTable && countersTable && probes.length) {
    const rows = findProbeRows(auditTable, markers, since);
    const counters = counterTotals(countersTable, PROBE_ROLE);
    evidence = {
      rows,
      countersSupported: counters.supported,
      calls: counters.calls,
      errors: counters.errors,
      byOperation: counters.byOperation,
    };
  }
  const all = [...faults, ...evaluateToolAudit(probes, evidence)];
  cleanupProbe(auditTable, countersTable, markers);
  return {
    ok: all.length === 0,
    problems: all.map((fault) => fault.text),
    faults: all,
    probes,
  };
}

/**
 * Что от поломки ломается дальше и что делать — по области поломки.
 * Тревога обязана отвечать на три вопроса (CLAUDE.md, «Правило приборов и
 * сторожей», п.3): что сломано, что от этого ломается дальше, что делать.
 */
const AREA_ADVICE: Record<
  ToolAuditFaultArea,
  { consequence: string; action: string }
> = {
  audit: {
    consequence:
      "сводка и выгрузка покажут ноль отказов или заниженную долю ошибок, а поломки шлюза видны только вручную по журналам ходов ролей",
    action:
      "Проверить запись отказов в role_tool_audit (server/src/runtime/toolAuditStore.ts) и шлюз ролей (server/src/runtime/universalTaskflow.ts)",
  },
  counters: {
    consequence:
      "доля ошибок в сводке и выгрузке будет неверной — часть вызовов в счётчиках не учтена",
    action:
      "Проверить счётчики role_tool_audit_counters и запись вызовов (server/src/runtime/toolAuditStore.ts)",
  },
  gateway: {
    consequence:
      "часть отказов ролей не доходит до учёта — сводка покажет меньше ошибок, чем было на самом деле",
    action: "Проверить шлюз ролей (server/src/runtime/universalTaskflow.ts)",
  },
  probe: {
    consequence:
      "сторож может промолчать о поломке прибора — тогда поломку увидят только по журналам ходов",
    action:
      "Проверить пробный ход сторожа (server/src/runtime/toolErrorAccountingWatcher.ts)",
  },
};

/** Сколько замечаний и какой длины входят в тревогу: лавина причин не должна
 *  превращать уведомление в простыню, но хвост «что делать» не режется. */
const ALERT_MAX_FAULTS = 6;
const ALERT_MAX_FAULT_LENGTH = 200;

/**
 * Тревога в «Состояние системы» — не чаще одного раза в сутки.
 * Возвращает true, если уведомление создано.
 *
 * Текст собирается из трёх частей и НЕ обрезается целиком: прежняя обрезка
 * по 400 знаков отрезала хвост «что делать» на полуслове (карточка
 * 64af4c85, D2). Режется только список замечаний — «что делать» остаётся
 * целиком при любой длине поломки.
 */
export function alertToolErrorAccounting(faults: ToolAuditFault[]): boolean {
  if (!faults.length) return false;
  try {
    const already = db
      .prepare(
        "SELECT 1 FROM notifications WHERE type = ? AND created_at >= datetime('now','-1 day') LIMIT 1",
      )
      .get(TOOL_ERROR_ACCOUNTING_WATCH_TYPE);
    if (already) return false;
    const owners = db
      .prepare("SELECT id FROM users WHERE role = 'owner'")
      .all() as Array<{ id: string }>;
    const shown = faults.slice(0, ALERT_MAX_FAULTS).map((fault) =>
      fault.text.length > ALERT_MAX_FAULT_LENGTH
        ? fault.text.slice(0, ALERT_MAX_FAULT_LENGTH - 1).trimEnd() + "…"
        : fault.text,
    );
    const rest = faults.length - shown.length;
    const broken =
      shown.join("; ") + (rest > 0 ? `; и ещё ${rest} замечаний` : "");
    const areas = [...new Set(faults.map((fault) => fault.area))];
    const consequences = [
      ...new Set(areas.map((area) => AREA_ADVICE[area].consequence)),
    ].join("; ");
    const actions = [
      ...new Set(areas.map((area) => AREA_ADVICE[area].action)),
    ].join("; ");
    const text =
      "Учёт ошибок вызовов инструментов ролей сломан. " +
      "Что сломано: " +
      broken +
      ". " +
      "Что от этого ломается дальше: " +
      consequences +
      ". " +
      "Что делать: " +
      actions +
      ". " +
      "После починки сторож сам перепроверит прибор пробным ходом (раз в 15 минут).";
    for (const owner of owners) {
      db.prepare(
        "INSERT INTO notifications (id, user_id, type, text) VALUES (?,?,?,?)",
      ).run(crypto.randomUUID(), owner.id, TOOL_ERROR_ACCOUNTING_WATCH_TYPE, text);
    }
    return owners.length > 0;
  } catch (error) {
    console.warn("[tool-audit-watch] тревога не записана:", error);
    return false;
  }
}

/** Сторож: при старте сервера и далее раз в 15 минут. */
export function startToolErrorAccountingWatcher(): () => void {
  let running = false;
  const check = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await checkToolErrorAccounting();
      if (!result.ok) alertToolErrorAccounting(result.faults);
    } catch (error) {
      console.warn("[tool-audit-watch] проверка не отработала:", error);
    } finally {
      running = false;
    }
  };
  void check();
  const timer = setInterval(() => {
    void check();
  }, 15 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
