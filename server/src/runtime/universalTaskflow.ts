import { CARD_WORK_OPERATIONS, type ChatExecutionMode } from "./chatExecutionMode.js";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { recordToolAudit } from "./toolAuditStore.js";
import { MISTAKE_LIMIT, stopRoleOnErrorLoop } from "./errorLoopStop.js";
export type Tool = {
  name: string;
  description: string;
  parameters: any;
  /** Образец правильного вызова — дописывается к INVALID_ARGUMENTS, когда схема (anyOf) сама его не объясняет. */
  invalidArgsHint?: (args: Record<string, unknown>) => string;
  execute: (
    id: string,
    args: any,
    signal?: AbortSignal,
    onUpdate?: any,
  ) => Promise<any>;
};
export type Context = {
  actor: string;
  executionMode?: ChatExecutionMode;
  role: string;
  mode: string;
  runId: string;
  taskId?: string;
  subtaskId?: string;
  chatId?: string;
  messageId?: string;
  /** Модель хода — пишется в учёт вызовов вместе с провайдером. */
  model?: string | null;
  authorize?: (name: string) => boolean;
  /** Isolated discussion guard: never abort or block the work slot. */
  onErrorLoop?: () => void;
};
export type RequestRecord = {
  actor: string;
  id: string;
  scope: string;
  hash: string;
  operation: string;
  state: string;
  result?: any;
};
export interface RequestStore {
  get(actor: string, id: string): RequestRecord | undefined;
  begin(r: RequestRecord): boolean;
  finish(actor: string, id: string, state: string, result: any): void;
}
export function memoryRequestStore(): RequestStore {
  const records = new Map<string, RequestRecord>();
  const key = (a: string, id: string) => JSON.stringify([a, id]);
  return {
    get: (a, id) => records.get(key(a, id)),
    begin: (r) => {
      if (records.has(key(r.actor, r.id))) return false;
      records.set(key(r.actor, r.id), r);
      return true;
    },
    finish: (a, id, state, result) => {
      Object.assign(records.get(key(a, id))!, { state, result });
    },
  };
}
const READ = new Set([
  "taskflow_routines", "taskflow_routine_read", "taskflow_routine_runs", "taskflow_routine_preview",
  "taskflow_team_read",
  "taskflow_plan_read",
  "taskflow_children",
  "taskflow_runtime",
  "taskflow_status",
  "taskflow_agents",
  "taskflow_project_tasks",
  "taskflow_my_stats",
  "taskflow_task_summary",
  "taskflow_recall",
  "taskflow_weather",
  "taskflow_my_tasks",
  "taskflow_task_daily",
  "taskflow_calendar_events",
  "taskflow_task",
  "taskflow_rules",
  "taskflow_projects",
  "taskflow_docs",
  "taskflow_doc_read",
  "taskflow_kb_search",
  "taskflow_library",
  "taskflow_chat_read",
  "taskflow_checklist_state",
  "taskflow_topic_read",
  "web_search",
  "web_get",
  "ocr",
  "youtube",
  "local_model",
]);
const CHAT_CONTEXT = new Set([
  "taskflow_chat_attach_file", "taskflow_chat_share_material",
  "taskflow_slot_restart",
  "taskflow_work_start",
  "taskflow_review_result",
  "taskflow_review_code",
  "taskflow_ask_user_question",
]);
const TASK_CONTEXT = new Set([
  "taskflow_topic_send",
  "taskflow_topic_reply",
  "taskflow_slot_snapshot",
]);
export function isReadOperation(name: string) {
  return (
    [
      "taskflow_hosts",
      "taskflow_host_read",
      "taskflow_host_ls",
      "taskflow_host_grep",
      "taskflow_host_find",
    ].includes(name) ||
    READ.has(name) ||
    /^things_(today|inbox|upcoming|anytime|someday|list|search|get|projects|areas)$/.test(name) ||
    /^todoist_(get|list|filter|export)_/.test(name) ||
    name.startsWith("mcp__infra__")
  );
}
export function operationRestriction(
  name: string,
  c: Context,
): { code: string; message: string } | undefined {
  if (c.authorize && !c.authorize(name))
    return {
      code: "FORBIDDEN",
      message: "Эта операция не разрешена роли " + c.role,
    };
  if (c.mode === "plan" && !isReadOperation(name))
    return {
      code: "MODE_RESTRICTED",
      message: "Для изменения нужен режим Работа",
    };
  // Обсуждение работающей карточки — ТОЛЬКО чтение (контракт архитектора
  // f3ada2e0, §5.2). Это ЯВНО ПОМЕЧЕННЫЙ новый режим «task_discussion»:
  // обычный чат в режиме «discussion» (владелец 20.10.2026) — работа по
  // задаче без ограничений, его политика здесь не меняется.
  if (c.mode === "task_discussion" && (!isReadOperation(name) || name.startsWith("mcp__infra__")))
    return {
      code: "MODE_RESTRICTED",
      message: "Обсуждение карточки — только чтение: запись недоступна",
    };
  if (c.executionMode === "chat" && CARD_WORK_OPERATIONS.has(name))
    return {code:"EXECUTION_MODE_RESTRICTED", message:"Выбран режим «В чате»: выполни поручение здесь без карточки. Только владелец может выбрать «По карточке» или явно поручить «Оформить как карточку»."};
  if (CHAT_CONTEXT.has(name) && (!c.chatId || !c.messageId))
    return {
      code: "CONTEXT_REQUIRED",
      message: "Нужно исходное сообщение в чате",
    };
  if (TASK_CONTEXT.has(name) && !c.taskId)
    return { code: "CONTEXT_REQUIRED", message: "Нужна текущая задача" };
}
function stable(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stable(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const response = (payload: any, extra: any[] = []) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }, ...extra],
  details: { operation: payload.operation, request_id: payload.request_id },
});

/** Что именно не сошлось в аргументах — без присланных значений: в учёт
 *  вызовов уходит только путь поля и ожидаемый тип. */
type AuditDetail = {
  field: string | null;
  expected: string | null;
  kind: string | null;
};

/** Хранилище на время одного вызова: параллельные вызовы не путают друг
 *  друга, у каждого своё «что не сошлось». */
const auditStorage = new AsyncLocalStorage<AuditDetail>();

/** Длинные «похожие на ключ» куски вырезаем: в учёт не должны попасть
 *  токены и значения, которые роль случайно приложила к вызову. */
const ПОХОЖЕ_НА_КЛЮЧ = /[A-Za-z0-9+/=_-]{32,}/g;

function safeAuditMessage(
  code: string,
  message: string,
  detail: AuditDetail,
): string {
  if (code === "INVALID_ARGUMENTS") {
    // Текст отказа про аргументы содержит присланные значения — в учёт он
    // не идёт. Остаются путь поля и ожидаемый тип.
    if (detail.field)
      return (
        "не сошлась схема аргументов: " +
        detail.field +
        (detail.expected ? " (ожидается " + detail.expected + ")" : "")
      );
    return "не сошлась схема аргументов";
  }
  return String(message ?? "")
    .replace(ПОХОЖЕ_НА_КЛЮЧ, "<…>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Записать вызов в учёт (toolAuditStore.ts). Ответ шлюза при этом не
 *  меняется: учёт — побочный эффект, его сбой не должен ломать вызов. */
function recordCall(
  context: Context,
  p: any,
  out: any,
  detail: AuditDetail,
): void {
  try {
    const text = out?.content?.[0]?.text;
    const payload = typeof text === "string" ? JSON.parse(text) : null;
    const ok = payload?.ok !== false;
    const errorCode = ok ? null : (payload?.error?.code ?? null);
    // Починка формы вызова: сервер сам привёл аргументы к схеме и выполнил
    // операцию. Отдельный исход: в счётчике ошибок это не ошибка, но видно,
    // сколько вызовов модель оформила не по форме.
    const repaired =
      ok && payload?.data?.repaired ? payload.data.repaired : null;
    // Тренер ошибок дописывает в отказ своё сообщение (остановка и готовый
    // вызов). Роль видела именно его — значит, и в журнале оно должно быть.
    const coach =
      typeof payload?.error?.coach?.message === "string"
        ? payload.error.coach.message.replace(/\s+/g, " ").trim().slice(0, 400)
        : null;
    const baseMessage = ok
      ? null
      : safeAuditMessage(
          errorCode ?? "",
          payload?.error?.message ?? "",
          detail,
        );
    recordToolAudit({
      role: context.role,
      model: context.model ?? null,
      mode: context.mode ?? null,
      runId: context.runId ?? null,
      taskId: context.taskId ?? null,
      subtaskId: context.subtaskId ?? null,
      action: typeof p?.action === "string" ? p.action : null,
      tool: "taskflow",
      operation: typeof p?.operation === "string" ? p.operation : null,
      outcome: repaired ? "repaired" : ok ? "ok" : "error",
      errorCode,
      errorMessage: repaired
        ? "аргументы приведены к схеме: " +
          (repaired.changes ?? []).join("; ")
        : baseMessage && coach
          ? baseMessage + " Тренер: " + coach
          : baseMessage,
      errorField: repaired ? repaired.field ?? null : detail.field,
      errorExpected: detail.expected,
      requestId: payload?.request_id ?? p?.request_id ?? null,
    });
  } catch (error) {
    console.warn("[tool-audit] вызов не записан:", error);
  }
}
export /** Что делать дальше после ошибки. Требование владельца 19.10.2026: отказ
 *  без следующего шага бесполезен — агент или человек должен знать, куда идти.
 *  Подсказка приходит вместе с кодом в каждом отказе. */
const ПОДСКАЗКИ: Record<string, string> = {
  ACTION_CONFLICT:
    'Для поиска используй {"action":"discover","query":"название или смысл операции"} без operation и arguments. Если операция уже выбрана, получи схему: {"action":"describe","operation":"имя_операции"}. Затем явно выполни её: {"action":"invoke","operation":"имя_операции","version":1,"arguments":{}}. Подставь настоящее имя и параметры из схемы; для изменения добавь уникальный request_id. Сервер не меняет action за тебя; тот же конфликтный вызов не повторяй.',
  INVALID_ARGUMENTS:
    "1) вызови describe для этой операции и сверь arguments с inputSchema; 2) для изменения обязателен request_id длиной 1..200 — он принимается и на верхнем уровне вызова, и внутри arguments; 3) если в describe нет нужного поля — операции нет в этом наборе, найди её через discover.",
  FORBIDDEN:
    "Операция не разрешена роли. 1) вызови discover по этой операции — там поле available и restriction; 2) попроси владельца или оркестратора расширить права роли; 3) обходных путей нет: молчаливый отказ хуже слов.",
  MODE_RESTRICTED:
    "Режим не тот. 1) plan — только чтение, для изменения нужен режим Работа или Обсуждение; 2) проверь, какой режим у текущего хода.",
  CONTEXT_REQUIRED:
    "Не хватает контекста. 1) передай task_id — без него операции над задачей не положены; 2) вызови из того чата, где есть сообщение, чтобы в контексте были chat_id и message_id; 3) в чате без задачи сначала уточни у владельца, что делать.",
  UNKNOWN_OPERATION:
    "Операция не найдена. 1) discover — поиск по смыслу задачи, а не по точному имени; 2) describe — точная схема и версия; 3) старое имя может быть совместимым обращением — попробуй найти его в discover.",
  VERSION_MISMATCH:
    "Версия не та. Поддерживается version: 1 — получи describe и повтори с version 1.",
  CONFLICT:
    "Запрос с таким request_id уже в работе или использован с другими аргументами. 1) состояние — операция requests.status с этим request_id; 2) если аргументы другие — возьми новый request_id; 3) повтор того же действия с тем же request_id не запускает его заново.",
  REJECTED:
    "Сервер отклонил вызов по правилу — действия не было. 1) в message написано правило и что исправить: выполни именно это (другие аргументы, другой порядок шагов, другой инструмент); 2) тот же вызов без изменений не повторяй — ответ будет тем же; 3) исправленный вызов отправляй с новым request_id; 4) если message прямо говорит ждать или что решение за владельцем — заверши ход и сообщи об этом, не перебирай.",
  OPERATION_FAILED:
    "Операция не выполнилась. 1) проверь состояние через requests.status; 2) если это внешний сервис или машина — сообщи владельцу: нужен код, текст и время; 3) не повторяй вслепую то же самое, сначала выясни причину.",
  DUPLICATE_OPERATION:
    "Один и тот же ход уже выполняется. Дождись текущего; второй запуск того же хода не нужен.",
};
/**
 * Форма вызова — самая частая причина отказов ролей: за неделю 21.10.2026
 * 971 отказ из 2157 (45 %) — это та же операция в другой записи, а не другое
 * действие: массив приходит объектом `{"item": [...]}` или строкой JSON,
 * число — строкой "0", имя аргумента — синонимом (`task_id` вместо `id`,
 * `content` вместо `text`), параметры host-операции — плоско вместо
 * `arguments.arguments`. Отказ здесь стоит роли раунда и ~7,6 с модели, а
 * исправить его она не может: в схеме написано не то, что она прислала.
 * Поэтому разворачиваем до проверки схемы (владелец 21.10.2026, карточка
 * c8083c2a, раздел И1 отчёта docs/2026-10-21-agent-speed-budget.md).
 */
const ГРУППЫ_ИМЁН: string[][] = [
  ["id", "task_id"],
  ["text", "content"],
  ["machine", "host_id"],
];
const свойстваСхемы = (schema: any): Record<string, any> =>
  (schema?.properties as Record<string, any> | undefined) ?? {};
/** Тип значения по схеме: первый непустой вариант anyOf/oneOf. */
function типСхемы(schema: any): string | undefined {
  const choices = schema?.anyOf ?? schema?.oneOf;
  if (Array.isArray(choices)) {
    for (const variant of choices) {
      const type = типСхемы(variant);
      if (type && type !== "null") return type;
    }
    return undefined;
  }
  if (schema?.const !== undefined) return typeof schema.const;
  if (Array.isArray(schema?.enum) && schema.enum.length)
    return typeof schema.enum[0];
  return schema?.type;
}
/** Массив, присланный объектом-обёрткой или строкой JSON. */
function какМассив(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return value;
    }
    return value;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.item)) return object.item;
    if (Array.isArray(object.items)) return object.items;
    const arrays = Object.values(object).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0];
  }
  return value;
}
const какОбъект = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return value;
};
/** Значение по типу схемы: только те приведения, которые не меняют смысла. */
function поТипуСхемы(schema: any, value: unknown, depth = 0): unknown {
  if (value === undefined || depth > 4) return value;
  const type = типСхемы(schema);
  if (type === "array") return какМассив(value);
  if (type === "number" || type === "integer") {
    if (typeof value === "string" && value.trim() !== "") {
      const number = Number(value.trim());
      if (Number.isFinite(number)) return type === "integer" ? Math.trunc(number) : number;
    }
    return value;
  }
  if (type === "boolean") {
    if (typeof value === "string" && /^(true|false)$/i.test(value.trim()))
      return value.trim().toLowerCase() === "true";
    return value;
  }
  if (type === "object") {
    const object = какОбъект(value);
    if (object !== value) return object;
    return нормализоватьАргументы(schema, value as Record<string, unknown>, depth + 1);
  }
  return value;
}
function нормализоватьАргументы(
  schema: any,
  raw: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || depth > 4) return raw;
  const properties = свойстваСхемы(schema);
  const args: Record<string, unknown> = { ...raw };
  // 1. Синоним имени: в схеме одно имя, в вызове — другое, и оно свободно.
  for (const group of ГРУППЫ_ИМЁН) {
    const declared = group.filter((name) => name in properties);
    const foreign = group.filter((name) => name in args && !(name in properties));
    if (declared.length === 1 && foreign.length === 1 && args[declared[0]] === undefined) {
      args[declared[0]] = args[foreign[0]];
      delete args[foreign[0]];
    }
  }
  // 2. Тип по схеме: массив из объекта/строки, число из строки, boolean из
  //    "true"/"false". Значение того же смысла, другая запись.
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property || value === undefined) continue;
    args[key] = поТипуСхемы(property, value, depth);
  }
  // 3. Плоский вызов вложенной операции (Mac): лишние ключи — внутрь arguments.
  const nested = properties.arguments;
  if (nested && типСхемы(nested) === "object") {
    const extra = Object.entries(args).filter(
      ([key, value]) => !(key in properties) && value !== undefined,
    );
    const already =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : undefined;
    if (extra.length && (!already || extra.every(([key]) => !(key in already)))) {
      const merged: Record<string, unknown> = { ...(already ?? {}) };
      for (const [key, value] of extra) {
        merged[key] = value;
        delete args[key];
      }
      args.arguments = нормализоватьАргументы(nested, merged, depth + 1);
    }
  }
  return args;
}
const ответнаяПодсказка = (code: string) =>
  ПОДСКАЗКИ[code] ??
  "Отказ нестандартный: 1) повтори discover/describe, чтобы сверить схему; 2) найди похожий случай в базе знаний (taskflow_kb_search); 3) не перебирай вручную — спроси архитектора или оркестратора, приложив код и текст ошибки.";

/** Где именно схема не сошлась — первые три места, человеческим текстом. */
export function местаОшибок(schema: any, args: unknown): string {
  try {
    const out = [...Errors(schema, args)]
      .slice(0, 3)
      .map((e: any) => `${e.instancePath || e.path || "/"}: ${e.message}`);
    return out.length ? " Ошибка в: " + out.join("; ") + "." : "";
  } catch {
    return "";
  }
}
/** Параметры положены не внутрь вложенного arguments (команды на маке):
 *  показываем, как должно быть, с теми же значениями. */
function образецВложенных(
  tool: Tool,
  args: Record<string, unknown>,
  наружные: Record<string, unknown>,
): string {
  const свойства = (tool.parameters as any)?.properties as
    Record<string, unknown> | undefined;
  if (!свойства || !("arguments" in свойства)) return "";
  const лишние = Object.fromEntries(
    Object.entries({ ...наружные, ...args }).filter(([k]) => !(k in свойства)),
  );
  if (!Object.keys(лишние).length) return "";
  const свои = Object.fromEntries(
    Object.entries(args).filter(([k]) => k in свойства && k !== "arguments"),
  );
  const образец = {
    action: "invoke",
    operation: tool.name,
    version: 1,
    request_id: "…",
    arguments: {
      ...свои,
      arguments: { ...((args.arguments as object) ?? {}), ...лишние },
    },
  };
  return ` Правильный вызов: ${JSON.stringify(образец)}. Параметры самой операции (${Object.keys(лишние).join(", ")}) кладутся внутрь arguments.arguments.`;
}
const secretField = (key: string) =>
  /password|token|secret|authorization|api.?key|credential/i.test(key);
function diagnosticValue(value: any, key = "", depth = 0): any {
  if (secretField(key)) return "<скрыто>";
  if (depth > 5) return "<…>";
  if (typeof value === "string")
    return value.length > 160 ? value.slice(0, 160) + "…" : value;
  if (Array.isArray(value))
    return value.slice(0, 5).map((v) => diagnosticValue(v, key, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 12)
        .map(([k, v]) => [k, diagnosticValue(v, k, depth + 1)]),
    );
  return value;
}
const diagnosticJson = (value: any) =>
  JSON.stringify(value, (key, value) =>
    secretField(key) ? "<скрыто>" : value,
  );
const valueType = (value: any) =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "массив"
      : typeof value === "object"
        ? "объект"
        : typeof value === "string"
          ? "строка"
          : typeof value === "number"
            ? "число"
            : typeof value === "boolean"
              ? "boolean"
              : "отсутствует";
const expectedType = (schema: any): string => {
  const choices = schema?.anyOf ?? schema?.oneOf;
  if (choices) return choices.map(expectedType).join(" или ");
  if (schema?.const !== undefined) return JSON.stringify(schema.const);
  if (schema?.enum)
    return schema.enum.map((v: any) => JSON.stringify(v)).join(" | ");
  return (
    (
      {
        array: "массив",
        object: "объект",
        string: "строка",
        number: "число",
        integer: "целое число",
        boolean: "boolean",
        null: "null",
      } as Record<string, string>
    )[schema?.type] ?? "значение по схеме"
  );
};
/** Несовпадение схемы — без значения: только путь поля, ожидаемый тип и
 *  вид ошибки. В учёт вызовов уходит именно это (значения не храним). */
type ArgProblem = { path: string; expected: string; kind: string };

/** Только объясняет и строит предложение исправления; исходный вызов не меняется. */
function argumentDiagnostics(
  schema: any,
  value: any,
  path = "arguments",
  issues: string[] = [],
  moves: string[] = [],
  problems: ArgProblem[] = [],
): {
  candidate: any;
  issues: string[];
  moves: string[];
  problems: ArgProblem[];
} {
  if (issues.length >= 8) return { candidate: value, issues, moves, problems };
  const key = path.split(".").at(-1) ?? "";
  const received = () =>
    valueType(value) + " " + JSON.stringify(diagnosticValue(value, key));
  const issue = (text: string, problem?: ArgProblem) => {
    issues.push(path + ": " + text);
    if (problem) problems.push(problem);
  };
  const choices = schema?.anyOf ?? schema?.oneOf;
  if (choices) {
    if (!choices.some((s: any) => Check(s, value)))
      issue(
        "допустимые значения/типы: " +
          expectedType(schema) +
          "; получен " +
          received() +
          ". Исправь " +
          path +
          ".",
        { path, expected: expectedType(schema), kind: "type" },
      );
    return { candidate: value, issues, moves, problems };
  }
  if (schema?.const !== undefined && value !== schema.const) {
    issue(
      "ожидается " + expectedType(schema) + "; получен " + received() + ".",
      { path, expected: expectedType(schema), kind: "value" },
    );
    return { candidate: value, issues, moves, problems };
  }
  if (schema?.enum && !schema.enum.includes(value)) {
    issue(
      "допустимые значения: " +
        expectedType(schema) +
        "; получен " +
        received() +
        ".",
      { path, expected: expectedType(schema), kind: "value" },
    );
    return { candidate: value, issues, moves, problems };
  }
  const wrong =
    schema?.type === "array"
      ? !Array.isArray(value)
      : schema?.type === "object"
        ? !value || typeof value !== "object" || Array.isArray(value)
        : schema?.type === "integer"
          ? !Number.isInteger(value)
          : schema?.type && schema.type !== "null"
            ? typeof value !== schema.type
            : schema?.type === "null"
              ? value !== null
              : false;
  if (wrong) {
    issue(
      "ожидается " + expectedType(schema) + "; получен " + received() + ".",
      { path, expected: expectedType(schema), kind: "type" },
    );
    if (
      schema.type === "array" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      Array.isArray(value.item)
    ) {
      moves.push(
        path +
          ".item → " +
          path +
          ". Убери объект-обёртку item, передай сам массив.",
      );
      return argumentDiagnostics(schema, value.item, path, issues, moves, problems);
    }
    return { candidate: value, issues, moves, problems };
  }
  if (schema?.type === "object") {
    let candidate = { ...value };
    const properties = schema.properties ?? {};
    // Лишний общий конверт, но не законный arguments у host.
    if (
      !("arguments" in properties) &&
      value.arguments &&
      typeof value.arguments === "object" &&
      !Array.isArray(value.arguments)
    ) {
      const inner = value.arguments;
      const names = Object.keys(inner);
      if (
        names.length &&
        names.every((k) => k in properties) &&
        names.every((k) => value[k] === undefined)
      ) {
        delete candidate.arguments;
        Object.assign(candidate, inner);
        moves.push(
          "Убери лишний уровень: " +
            names
              .map((k) => path + ".arguments." + k + " → " + path + "." + k)
              .join("; ") +
            ".",
        );
      }
    }
    for (const k of schema.required ?? [])
      if (candidate[k] === undefined) {
        issues.push(
          path +
            "." +
            k +
            ": поле отсутствует; ожидается " +
            expectedType(properties[k]) +
            ". Добавь " +
            path +
            "." +
            k +
            ".",
        );
        problems.push({
          path: path + "." + k,
          expected: expectedType(properties[k]),
          kind: "missing",
        });
      }
    for (const [k, child] of Object.entries(properties))
      if (candidate[k] !== undefined)
        candidate[k] = argumentDiagnostics(
          child,
          candidate[k],
          path + "." + k,
          issues,
          moves,
          problems,
        ).candidate;
    if (schema.additionalProperties === false)
      for (const k of Object.keys(candidate))
        if (!(k in properties))
          issues.push(
            path +
              "." +
              k +
              ": лишнее поле. Удали его; допустимы " +
              Object.keys(properties).join(", ") +
              ".",
          );
    return { candidate, issues, moves, problems };
  }
  if (schema?.type === "array")
    return {
      candidate: value.map(
        (v: any, i: number) =>
          argumentDiagnostics(
            schema.items,
            v,
            path + "[" + i + "]",
            issues,
            moves,
            problems,
          ).candidate,
      ),
      issues,
      moves,
      problems,
    };
  if (!Check(schema, value))
    issue(
      "ожидается " +
        expectedType(schema) +
        "; получен " +
        received() +
        "." +
        местаОшибок(schema, value),
      { path, expected: expectedType(schema), kind: "value" },
    );
  return { candidate: value, issues, moves, problems };
}
type TemplateField = {
  path: string;
  type: string;
  required: boolean;
  description?: string;
  example?: any;
};
/** Пример формы, не реальные данные и не команда к автоматическому исполнению. */
function templateValue(
  schema: any,
  path: string,
  required: boolean,
  fields: TemplateField[],
  depth = 0,
): any {
  if (depth > 8) return "<заполни по inputSchema>";
  if (schema?.default !== undefined) return structuredClone(schema.default);
  const branches = schema?.anyOf ?? schema?.oneOf;
  if (branches) {
    const base = { ...schema };
    delete base.anyOf;
    delete base.oneOf;
    const selected = {
      ...base,
      ...branches[0],
      properties: { ...base.properties, ...branches[0]?.properties },
      required: [
        ...new Set([
          ...(base.required ?? []),
          ...(branches[0]?.required ?? []),
        ]),
      ],
    };
    const value = templateValue(selected, path, required, fields, depth + 1);
    return value;
  }
  const field: TemplateField = {
    path,
    type: expectedType(schema),
    required,
    description: schema?.description,
  };
  if (path) fields.push(field);
  let example: any;
  if (schema?.const !== undefined) example = schema.const;
  else if (schema?.enum?.length) example = schema.enum[0];
  else if (schema?.type === "object" || schema?.properties) {
    example = {};
    const requiredKeys = new Set(schema.required ?? []);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const value = templateValue(
        child,
        path ? path + "." + key : key,
        requiredKeys.has(key),
        fields,
        depth + 1,
      );
      if (requiredKeys.has(key)) example[key] = value;
    }
  } else if (schema?.type === "array") {
    example =
      schema.maxItems === 0
        ? []
        : [templateValue(schema.items, path + "[0]", true, fields, depth + 1)];
  } else if (schema?.type === "integer" || schema?.type === "number")
    example =
      schema.minimum ??
      (typeof schema.exclusiveMinimum === "number"
        ? schema.exclusiveMinimum + 1
        : 0);
  else if (schema?.type === "boolean") example = false;
  else if (schema?.type === "null") example = null;
  else example = "<значение для " + path + ">";
  field.example = example;
  return example;
}
function invocationTemplate(operation: string, schema: any, write: boolean) {
  const fields: TemplateField[] = [];
  const args = templateValue(schema, "arguments", true, fields);
  return {
    invokeTemplate: { operation, arguments: args },
    templateFields: fields.filter((f) => f.path !== "arguments"),
    templateInstructions:
      "Это шаблон формы, а не готовые данные: замени все строки <…> и примерные числа/значения своими данными. Числа оставляй числами, массивы — массивами [...], объекты — объектами {...}; не оборачивай массив в item. В invokeTemplate включены обязательные поля; необязательные перечислены в templateFields с required=false и example. Для anyOf/oneOf показан первый вариант: другие допустимые варианты смотри в inputSchema. Параметры операции находятся внутри arguments; второй arguments нужен только если он прямо объявлен в inputSchema этой операции. " +
      (write
        ? "action, version и request_id сервер подставит сам; содержимое шаблона само по себе не разрешает действие."
        : "action, version и request_id писать не нужно."),
  };
}
const СЛУЖЕБНЫЕ = new Set([
  "action",
  "operation",
  "version",
  "arguments",
  "request_id",
  "query",
  "offset",
  "limit",
]);

export const UNIVERSAL_INSTRUCTION =
  "Серверные возможности доступны через один инструмент taskflow. Любая роль может работать с Mac через host: discover taskflow_hosts, затем taskflow_host_read/bash/edit/write/grep/find/ls. Назначение машины этапу и утверждение плана для доступа к host не нужны. При одном проекте машина и проект выбираются автоматически; для другого проекта на машине (например, iOS-репозитория из веб-карточки) передай project_id из taskflow_hosts. Рабочая копия создаётся в песочнице проекта. Сборка, тесты и симулятор — через host bash (долгим командам — timeout в секундах); прямой ssh не используется. Найди действие через discover (по названию или смыслу), получи точные параметры через describe, затем вызови с operation и arguments (action, version и request_id сервер подставит сам; при осознанном повторе того же действия передай прежний request_id). Состояние запроса: requests.status. Старые имена в истории — совместимые обращения к тем же операциям. Отказ объясняет права, режим или недостающий контекст; не объявляй возможность отсутствующую без поиска. Каждый отказ несёт поле hint — что делать дальше: читай его и выполняй по шагам, а не перебирай вызовы вслепую.";
const CALL_CHEATSHEET = `
Шпаргалка: печатай вызов инструмента taskflow как JSON-объект. Пиши только operation и arguments — остальное сервер подставит сам.
1. Поиск: {"query":"сводка по задачам"}.
2. Схема: {"action":"describe","operation":"taskflow_task_summary"}.
3. Выполнение: {"operation":"taskflow_task_summary","arguments":{"query":"Сводка по всем задачам"}}.
В describe смотри inputSchema и templateFields. Не отправляй строки <…> и примерные числа как реальные данные.
Все параметры операции — в arguments. Для сводки нужен arguments.query, а не query снаружи и не arguments.arguments.query.
Второй arguments допустим только когда он явно есть в inputSchema (например, host). Массив передавай как [...], без {"item":[...]}.
request_id и version писать не нужно. Свой request_id передавай только при осознанном повторе того же действия. Ошибка означает, что нужно исправить указанный путь и повторить исправленный вызов, а не копировать прежний.
`;
/** Параметры вызова в том виде, в каком их понял шлюз: без action вызов с
 *  operation — это invoke, без operation — discover; для invoke шлюз сам
 *  проставляет версию 1, пустые arguments и request_id. Правило одно и для
 *  шлюза, и для учёта — иначе в журнал попал бы не тот вызов, который роль
 *  на самом деле сделала. */
function normalizeParams(raw: any, context: Context, id: string): any {
  const p = raw && typeof raw === "object" ? { ...raw } : raw;
  if (p && p.action === undefined)
    p.action = p.operation !== undefined ? "invoke" : "discover";
  if (p && p.action === "invoke") {
    // Версия операции — не то, что роль должна помнить: любая присланная
    // версия означает ту же операцию (174 отказа за неделю — version: 2).
    p.version = 1;
    if (p.arguments === undefined) p.arguments = {};
    // `request_id: null` — это «не задан», а не неверный ключ (53 отказа
    // за неделю): подставляем ключ хода так же, как при отсутствии поля.
    if (p.request_id === null) delete (p as any).request_id;
    if ((p.arguments as any)?.request_id === null)
      delete (p.arguments as any).request_id;
    if (
      p.request_id === undefined &&
      (p.arguments as any)?.request_id === undefined
    )
      p.request_id = (context.runId || "run") + ":" + id;
  }
  return p;
}
export function createUniversalTaskflow(
  tools: Tool[],
  context: Context,
  store: RequestStore = memoryRequestStore(),
): Tool {
  const registry = new Map<string, Tool>();
  for (const tool of tools) {
    if (registry.has(tool.name))
      throw new Error("Duplicate operation: " + tool.name);
    registry.set(tool.name, tool);
  }
  const scope = stable({
    taskId: context.taskId ?? null,
    subtaskId: context.subtaskId ?? null,
    chatId: context.chatId ?? null,
  });
  // Шлюз: сама операция. Поверх неё в конце функции — две обёртки: тренер
  // ошибок (внутренняя) и учёт вызовов (внешняя).
  const api: Tool = {
    name: "taskflow",
    description: UNIVERSAL_INSTRUCTION + CALL_CHEATSHEET,
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([
          Type.Literal("discover"),
          Type.Literal("describe"),
          Type.Literal("invoke"),
        ]),
      ),
      query: Type.Optional(Type.String()),
      operation: Type.Optional(Type.String()),
      version: Type.Optional(Type.Integer()),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Any())),
      request_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    execute: async (id, raw, signal, onUpdate) => {
      // Владелец 20.10.2026: модель пишет только operation и arguments. Без action
      // вызов с operation — invoke, без operation — discover; version по умолчанию 1;
      // request_id для изменения — из номера хода и вызова (явный по-прежнему главнее).
      const p = normalizeParams(raw, context, id);
      const fail = (
        code: string,
        message: string,
        hint = ответнаяПодсказка(code),
        extra?: { field?: string | null; expected?: string | null; kind?: string | null },
      ) => {
        const current = auditStorage.getStore();
        if (current && extra) {
          current.field = extra.field ?? null;
          current.expected = extra.expected ?? null;
          current.kind = extra.kind ?? null;
        }
        return response({
          ok: false,
          operation: p?.operation,
          request_id: p?.request_id ?? (p?.arguments as any)?.request_id,
          error: { code, message, hint },
        });
      };
      if (!p || !["discover", "describe", "invoke"].includes(p.action))
        return fail(
          "INVALID_ARGUMENTS",
          "action: discover, describe или invoke",
          ответнаяПодсказка("INVALID_ARGUMENTS"),
          {
            field: "action",
            expected: "discover | describe | invoke",
            kind: "value",
          },
        );
      const denied = (name: string) => operationRestriction(name, context);
      if (p.action === "discover") {
        // Не выдавать общий каталог за успешный вызов выбранной операции.
        // Автоматически превращать поиск в invoke нельзя: это может выполнить запись.
        if (p.operation !== undefined || p.arguments !== undefined)
          return fail(
            "ACTION_CONFLICT",
            'Указан action: "discover" вместе с operation или arguments. discover только ищет операции; указанная операция не выполнена. Для схемы нужен action: "describe", для выполнения — action: "invoke".',
          );
        if (
          (p.offset !== undefined &&
            (!Number.isInteger(p.offset) || p.offset < 0)) ||
          (p.limit !== undefined &&
            (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 20))
        )
          return fail("INVALID_ARGUMENTS", "offset >= 0; limit 1..20");
        const words = String(p.query ?? "")
          .toLowerCase()
          .split(/[\s._]+/)
          .filter(Boolean);
        const matches = [...registry.values()]
          .filter((t) => !(context.executionMode === "chat" && CARD_WORK_OPERATIONS.has(t.name)))
          .map((t) => ({
            tool: t,
            score: words.reduce(
              (n, w) =>
                n +
                ((t.name + " " + t.description).toLowerCase().includes(w)
                  ? 1
                  : 0),
              0,
            ),
          }))
          .filter((t) => !words.length || t.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score || a.tool.name.localeCompare(b.tool.name),
          );
        const offset = p.offset ?? 0,
          limit = p.limit ?? 10;
        return response({
          ok: true,
          data: {
            operations: matches
              .slice(offset, offset + limit)
              .map(({ tool: t }) => ({
                operation: t.name,
                version: 1,
                description: t.description,
                available: !denied(t.name),
                restriction: denied(t.name),
              })),
            closed: matches.slice(offset, offset + limit).filter(({tool:t}) => Boolean(denied(t.name))).length,
            total: matches.length,
            next_offset:
              offset + limit < matches.length ? offset + limit : null,
            hint: "available:false означает ограничение роли или контекста. Для запроса инструмента вызови taskflow_tool_request с именем и причиной. Если ничего не найдено, повтори короче или запроси каталог без query. Статус запроса: operation requests.status, arguments {request_id}.",
          },
        });
      }
      if (
        p.operation === "requests.status" ||
        p.operation === "requests.reconcile"
      ) {
        if (p.action === "describe") {
          const schema = {
            type: "object",
            properties: {
              request_id: {
                type: "string",
                description: "Ключ ранее отправленного запроса",
              },
            },
            required: ["request_id"],
          };
          return response({
            ok: true,
            data: {
              operation: p.operation,
              version: 1,
              inputSchema: schema,
              ...invocationTemplate(p.operation, schema, false),
            },
          });
        }
        const record = store.get(context.actor, p.arguments?.request_id);
        if (!record || record.scope !== scope)
          return fail(
            "UNKNOWN_REQUEST",
            "Запрос не найден в текущем контексте",
          );
        const restriction = denied(record.operation);
        if (restriction) return fail(restriction.code, restriction.message);
        return response({
          ok: true,
          data: {
            state: record.state,
            result: record.result,
            reconciliation:
              p.operation === "requests.reconcile"
                ? "Автоматическая сверка для этого адаптера не поддерживается; повтор не выполнен"
                : undefined,
          },
        });
      }
      const tool = registry.get(p.operation);
      if (!tool)
        return fail(
          "UNKNOWN_OPERATION",
          "Операция не найдена. Используй discover.",
        );
      const restriction = denied(tool.name);
      if (p.action === "describe") {
        // request_id объявляем в схеме явно: без него рантайм агента не передаёт
        // поле, которого нет в inputSchema операции (см. выше про host-операции).
        const параметры: Record<string, unknown> = {
          ...(tool.parameters as any),
        };
        const свойства = {
          ...((параметры.properties as Record<string, unknown> | undefined) ??
            {}),
        };
        if (!свойства.request_id)
          свойства.request_id = {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description:
              "Уникальный идентификатор запроса; для операций изменения обязателен",
          };
        return response({
          ok: true,
          data: {
            operation: tool.name,
            version: 1,
            description: tool.description,
            inputSchema: { ...параметры, properties: свойства },
            ...invocationTemplate(
              tool.name,
              tool.parameters,
              !isReadOperation(tool.name),
            ),
            effects: isReadOperation(tool.name) ? "read" : "write",
            available: !restriction,
            restriction,
          },
        });
      }
      if (restriction) return fail(restriction.code, restriction.message);
      if (signal?.aborted) return fail("CANCELLED", "Вызов отменён до исполнения; операция не выполнялась.");
      const write = !isReadOperation(tool.name);
      // request_id приходит и внутри arguments. Рантайм агента вырезает поля, которых
      // нет в схеме операции, а в схемах host-операций (`roleHostAccess.ts`) его нет —
      // из-за этого запись на удалённую машину падала с «нужен request_id» при любом
      // вызове (19.10.2026). Поле служебное: из аргументов операции убираем, чтобы
      // проверка схемы его не считала лишним.
      const { request_id: изАргументов, ...присланные } = {
        ...(p.arguments ?? {}),
      } as Record<string, unknown>;
      let args = нормализоватьАргументы(tool.parameters, присланные);
      /** Что привели к схеме автоматически. Инцидент 24.10.2026 (карточка
       *  252c400e): роль 55 раз подряд повторяла сломанный вызов
       *  taskflow_work_plan, хотя сервер уже знал, как его починить, — но
       *  отказывал и ждал повтора от модели. null — починки не было. */
      let починка: { changes: string[]; field: string | null } | null = null;
      const наружные = Object.fromEntries(
        Object.entries(p).filter(([k]) => !СЛУЖЕБНЫЕ.has(k)),
      );
      const requestId =
        typeof p.request_id === "string" && p.request_id
          ? p.request_id
          : typeof изАргументов === "string"
            ? изАргументов
            : undefined;
      if (!Check(tool.parameters, args)) {
        const properties = (tool.parameters as any)?.properties ?? {};
        const moved = Object.keys(properties).filter(
          (k) =>
            ![
              "action",
              "operation",
              "version",
              "arguments",
              "request_id",
            ].includes(k) &&
            p[k] !== undefined &&
            args[k] === undefined,
        );
        const proposed = {
          ...(args as Record<string, unknown>),
          ...Object.fromEntries(moved.map((k) => [k, p[k]])),
        };
        const diagnosis = argumentDiagnostics(tool.parameters, proposed);
        const moves = moved.map((k) => k + " → arguments." + k);
        let hint =
          (moves.length
            ? "Параметры находятся на верхнем уровне вызова. Перенеси " +
              moves.join("; ") +
              ". "
            : "") + diagnosis.moves.join(" ");
        const specific =
          tool.invalidArgsHint?.(args) ||
          образецВложенных(tool, args, наружные);
        if (Check(tool.parameters, diagnosis.candidate)) {
          // Починка найдена и проходит схему: выполняем с исправленными
          // аргументами. Раньше здесь был отказ с готовым примером — роль
          // должна была повторить вызов сама, и 24.10.2026 повторяла его
          // 55 раз подряд (карточка 252c400e).
          args = diagnosis.candidate as Record<string, unknown>;
          починка = {
            changes: [...moves, ...diagnosis.moves],
            field: diagnosis.problems[0]?.path ?? null,
          };
        } else {
          hint +=
            " " +
            diagnosis.issues.join(" ") +
            (specific ? " " + specific : "") +
            " Получи полную схему: " +
            JSON.stringify({ action: "describe", operation: tool.name }) +
            ". Исправь указанные поля и повтори invoke. Операция ещё не выполнялась.";
          const detail = diagnosis.issues.length
            ? diagnosis.issues.join(" ")
            : "Неверное размещение параметров.";
          const firstProblem = diagnosis.problems[0];
          return fail(
            "INVALID_ARGUMENTS",
            detail + " " + hint,
            hint,
            {
              field: firstProblem?.path ?? null,
              expected: firstProblem?.expected ?? null,
              kind: firstProblem?.kind ?? null,
            },
          );
        }
      }
      if (
        write &&
        (typeof requestId !== "string" ||
          !requestId.trim() ||
          requestId.length > 200)
      ) {
        const hint =
          'Добавь на верхнем уровне request_id — уникальную непустую строку длиной 1..200, например "' +
          tool.name.replace(/^taskflow_/, "") +
          "-" +
          Date.now().toString(36) +
          '". Сохрани action, operation, version и arguments; повтори с этим ключом. Операция ещё не выполнялась.';
        return fail(
          "INVALID_ARGUMENTS",
          "Для изменения нужен request_id длиной 1..200 — придумай новый уникальный для этого действия.",
          hint,
          { field: "request_id", expected: "строка 1..200", kind: "missing" },
        );
      }
      const hash = crypto
        .createHash("sha256")
        .update(
          stable({ operation: tool.name, version: p.version, arguments: args }),
        )
        .digest("hex");
      if (write) {
        const current = store.get(context.actor, requestId!);
        if (current) {
          if (current.scope !== scope || current.hash !== hash)
            return fail(
              "CONFLICT",
              "Этот request_id уже использован с другим контекстом или аргументами. Для нового действия нужен новый request_id — повтори вызов с другим ключом; старый ключ годится только для повтора ровно того же действия.",
            );
          return (
            current.result ??
            response({
              ok: true,
              operation: tool.name,
              request_id: requestId,
              data: { state: current.state },
            })
          );
        }
        if (
          !store.begin({
            actor: context.actor,
            id: requestId!,
            scope,
            hash,
            operation: tool.name,
            state: "running",
          })
        )
          return fail("CONFLICT", "Запрос уже принят; проверь requests.status");
      }
      try {
        const result = await tool.execute(id, args, signal, onUpdate);
        if (result?.isError)
          throw new Error("Адаптер вернул ошибку; проверь результат операции");
        const resultContent = result?.content ?? [];
        const out = response(
          {
            ok: true,
            operation: tool.name,
            version: 1,
            request_id: requestId,
            data: {
              state: "succeeded",
              content: resultContent,
              ...(починка
                ? {
                    repaired: {
                      changes: починка.changes,
                      note: "Аргументы приведены к схеме, вызов выполнен. Повторять не нужно.",
                    },
                  }
                : {}),
            },
          },
          resultContent.filter((c: any) => c.type !== "text"),
        );
        if (write) store.finish(context.actor, requestId!, "succeeded", out);
        return out;
      } catch (error) {
        // A transport error can happen after a side effect. Never repeat it automatically.
        // Отказ по правилу (ToolError, 4xx) — действия не было, исход известен.
        const status = (error as { status?: number }).status;
        const rejected =
          (error as Error)?.name === "ToolError" &&
          (status === undefined || status < 500);
        const out = fail(
          rejected ? "REJECTED" : "OPERATION_FAILED",
          String((error as Error).message),
        );
        // requestId, а не p.request_id: он мог прийти внутри arguments, и тогда
        // запись оставалась running, а успешный вызов отдавался роли как сбой (19.10.2026).
        if (write)
          store.finish(
            context.actor,
            requestId!,
            rejected ? "rejected" : "unknown_outcome",
            out,
          );
        return out;
      }
    },
  };
  // Тренер ошибок — обёртка внутренняя: три неверных вызова одной операции
  // подряд → стоп хода (роль прервана, шаг в blocked, владелец уведомлён)
  // и готовый вызов в ответе. Счётчик ошибок живёт в ней, и обёртка учёта
  // его не трогает.
  const coached = withMistakeCoach(api, registry, context);
  // Учёт вызовов — обёртка внешняя: ответ шлюза уходит роли как есть, а сам
  // вызов — в журнал. Снаружи — чтобы в журнал попало ровно то, что увидела
  // роль, включая сообщение тренера об остановке.
  const inner = coached.execute;
  const tool: Tool = {
    ...coached,
    execute: async (id, raw, signal, onUpdate) => {
      // В журнал идёт фактический вызов — тот, который понял шлюз: правило
      // про action одно и то же для шлюза и для учёта.
      const p = normalizeParams(raw, context, id);
      const detail: AuditDetail = { field: null, expected: null, kind: null };
      const out = await auditStorage.run(detail, () =>
        inner(id, raw, signal, onUpdate),
      );
      recordCall(context, p, out, detail);
      return out;
    },
  };
  return tool;
}

export { MISTAKE_LIMIT };
const ОШИБКИ_ВЫЗОВА = new Set(["INVALID_ARGUMENTS", "VERSION_MISMATCH", "ACTION_CONFLICT", "UNKNOWN_OPERATION"]);
/** Владелец 20.10.2026: «если три раза неправильно вызвал инструмент — прилетает
 *  и говорит: дурью маешься, вот так надо». Счёт ведётся на операцию внутри
 *  одного инструмента (один заход роли); успешный вызов обнуляет счёт.
 *
 *  Правка 24.10.2026 (карточка 252c400e): одной подсказки оказалось мало —
 *  роль получила «СТОП» 55 раз подряд и продолжила крутить тот же неверный
 *  вызов, пока слот не завис на три часа. Теперь третье неверное вызов подряд —
 *  это стоп хода: запуск прерывается, попытка закрывается с
 *  outcome='error_loop', шаг уходит в blocked, владелец получает уведомление.
 *  Правило владельца от 24.10.2026: «после трёх неверных — блок». */
function withMistakeCoach(api: Tool, registry: Map<string, Tool>, context: Context): Tool {
  const подряд = new Map<string, number>();
  return {
    ...api,
    execute: async (id, p, signal, onUpdate) => {
      const out = await api.execute(id, p, signal, onUpdate);
      let env: any;
      try {
        env = JSON.parse(out?.content?.[0]?.text ?? "");
      } catch {
        return out;
      }
      const key = String(p?.operation ?? "(без operation)");
      if (env?.ok) {
        подряд.delete(key);
        return out;
      }
      if (!ОШИБКИ_ВЫЗОВА.has(env?.error?.code)) return out;
      const n = (подряд.get(key) ?? 0) + 1;
      подряд.set(key, n);
      if (n < MISTAKE_LIMIT) return out;
      const tool = registry.get(key);
      const form = tool
        ? invocationTemplate(tool.name, tool.parameters, !isReadOperation(tool.name))
        : null;
      // Стоп хода. Счётчик живёт в памяти процесса — этого достаточно:
      // вместе с ним умирает и сам ход (in-process run), а его ошибки
      // остаются в журнале вызовов, где их видно и сторож, и владелец.
      const stop = context.mode === "task_discussion"
        ? (context.onErrorLoop?.(), {stopped: true, blocked: false})
        : await stopRoleOnErrorLoop({
        taskId: context.taskId,
        subtaskId: context.subtaskId,
        role: context.role,
        operation: key,
        attempts: n,
        reason: String(env?.error?.message ?? "повторяется одна и та же ошибка").slice(0, 300),
      });
      env.error.coach = {
        attempts: n,
        stopped: stop.stopped || stop.blocked,
        message:
          `СТОП. Это ${n}-й неверный вызов ${key} подряд — ты повторяешь одну и ту же ошибку. ` +
          "Не отправляй тот же вызов снова. " +
          (form
            ? "Возьми форму ниже, подставь свои значения в каждое поле и пришли ровно её: только operation и arguments."
            : "Такой операции нет: сначала найди нужную через {\"query\":\"что ищешь\"}, затем describe.") +
          (stop.blocked
            ? " Ход остановлен: роль прервана, шаг переведён в blocked, владельцу отправлено уведомление. Продолжить можно только после решения владельца."
            : ""),
        ...(form ? { call: form.invokeTemplate, fields: form.templateFields } : {}),
        // Что роль прислала на самом деле, с типами. Урок владельца
        // 20.10.2026: «не повторять вызов, а чинить структуру по подсказке» —
        // подсказка без фактических значений структуру не чинит.
        received: diagnosticValue(p?.arguments ?? p),
      };
      return { ...out, content: [{ type: "text", text: JSON.stringify(env) }, ...out.content.slice(1)] };
    },
  };
}
