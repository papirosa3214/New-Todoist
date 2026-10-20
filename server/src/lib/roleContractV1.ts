// JSON-контракт роли v1 (карточка 237d6f34, 17.10.2026).
//
// Что это. Промпты ролей (scripts/role-prompts/*.md) и паспорта ролей
// требуют от роли единый внешний ответ — конверт из шести полей:
//   ok, output, artifacts, error, next_hint, needs_human.
// До сих пор сервер понимал только YAML-подобный вид этого конверта
// (`ok: true` / `output: | …`), снимал его с текста ответа регулярками и
// показывал владельцу только `output`. Роль, ответившая настоящим JSON
// (что в конверте буквально значит «JSON-контракт»), в чате отдавала владельцу
// сырой блок кода. Здесь один путь разбора вместо двух: JSON v1 и старый
// YAML-подобный вид, с проверкой полей и нормализованным конвертом для клиента.
//
// Границы (важно для владельца карточки):
//   - старый YAML-подобный путь НЕ убран: он разбирается теми же правилами, что
//     и раньше (runtime/chatLiveTurn.ts теперь зовёт этот модуль);
//   - схема одна: JSON-конверт v1. `report_markdown` при сдаче шага — не вторая
//     схема, а текстовая форма блока `report` (`sections`: result, work, checks,
//     limitations, materials), потому что `taskflow_subtask_done` принимает строку.
//     Проверяет её validateRoleReport() — она требует те же пять разделов как
//     `## Заголовок`. При добавлении шестого раздела правьте оба места;
//   - iOS-репозиторий не трогаем: сервер отдаёт конверт в сообщении чата
//     полем `role_envelope` и показывает владельцу текст `output`, а рисование
//     конверта на клиенте — следующая карточка (клиент просто игнорирует
//     незнакомое поле, старые ответы приходят без него вовсе).
import { parse as parseYaml } from "yaml";
import { validateWidgetBlock } from "./widgetContract.js";

/** Имя контракта: попадает в конверт и в ответ сдачи, чтобы клиент и человек
 *  видели, какая версия правил применена. */
export const ROLE_CONTRACT_V1 = "role.v1" as const;

/** Поля контракта v1 в нормализованном виде. `artifacts` — всегда список
 *  строк (`null` и одна строка приводятся к нему), остальные — как есть. */
export interface RoleEnvelopeV1 {
  contract: typeof ROLE_CONTRACT_V1;
  ok: boolean;
  output: string;
  artifacts: string[];
  error: string | null;
  next_hint: string | null;
  needs_human: boolean;
}

/** Целевой контракт чата с закрытым набором типизированных блоков. */
export interface StructuredRoleEnvelopeV1 {
  schema_version: 1;
  ok: boolean;
  output: Record<string, unknown>[];
  artifacts: { kind: string; title: string; ref: string }[];
  plan_artifact: Record<string, unknown> | null;
  error: { code: string; message: string; retryable: boolean } | null;
  next_hint: string | null;
  needs_human: boolean;
}

export interface StructuredRoleContractValidation {
  valid: boolean;
  errors: string[];
  envelope: StructuredRoleEnvelopeV1 | null;
}

const STRUCTURED_BLOCK_FIELDS: Record<string, string[]> = {
  text: ["type", "text"], heading: ["type", "text", "level"],
  list: ["type", "items", "ordered"], table: ["type", "title", "columns", "rows"],
  status: ["type", "code", "title", "text"], progress: ["type", "title", "current", "total", "unit", "label"],
  chart: ["type", "title", "kind", "unit", "points"], diagram: ["type", "title", "kind", "items"],
  report: ["type", "report_kind", "sections"], handoff: ["type", "artifact_key", "summary"],
  // Владелец 20.10.2026: команда с кнопкой запуска, кликабельная ссылка и
  // виджет — тоже блоки JSON, а не Markdown внутри text.
  command: ["type", "command", "title"], link: ["type", "title", "url"], widget: ["type", "widget"],
  html: ["type", "title", "html"],
};
/** Описание блоков для инструкции ролей. Список собирается отсюда в общий
 *  шаблон (scripts/role-system-prompt.md, {{BLOCKS}}) — один источник со схемой
 *  выше; тест сверяет, что ключи совпадают (владелец 20.10.2026). */
export const ROLE_BLOCK_GUIDE: Record<string, string> = {
  text: "`text`",
  heading: "`text`, `level` 1–3",
  list: "`items`, необязательный `ordered`",
  table: "`columns`, `rows`, необязательный `title`",
  status: "`code` (`info|in_progress|passed|failed|blocked|skipped`), `title`, необязательный `text`",
  progress: "`title`, `current`, `total`, необязательные `unit`, `label`",
  chart: "`title`, `kind` (`bar`|`line`), `points` с `label` и числовым `value`, необязательный `unit`",
  diagram: "`title`, `kind` (`chain`|`ladder`|`timeline`), `items` с `label` и `state` из `queued|in_progress|done|blocked|failed|skipped`",
  report: "`report_kind` (`intermediate`|`final`), `sections`",
  handoff: "`artifact_key`, `summary`",
  command: "`command`, необязательный `title`: команда для запуска на .110; у владельца рядом кнопка «Запустить». Одна команда — один блок",
  link: "`title`, `url` (только http/https): кликабельная ссылка",
  html: "`title`, `html`: интерактив в окне чата — самодостаточная страница HTML/CSS/JS",
  widget: "`widget`: объект виджета (`metrics`, `progress`, `checklist`, `card`, `chart` и др.); сервер проверяет его по каталогу виджетов",
};
export function roleBlockLines(): string {
  return Object.keys(STRUCTURED_BLOCK_FIELDS).map((type) => "- `" + type + "` — " + (ROLE_BLOCK_GUIDE[type] ?? "")).join("\n");
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown, max = 4000): value is string =>
  typeof value === "string" && value.length <= max;
const isMaterial = (value: unknown): boolean => isObject(value) &&
  ["url", "document", "file", "change", "artifact", "log"].includes(String(value.kind)) &&
  isText(value.title, 1000) && isText(value.ref, 1024);

function structuredBlockErrors(value: unknown, path: string, report = false): string[] {
  if (!isObject(value)) return [path + ": ожидается объект"];
  const type = value.type;
  const fields = typeof type === "string" ? STRUCTURED_BLOCK_FIELDS[type] : undefined;
  if (!fields || (report && !["text", "heading", "list", "table", "status"].includes(String(type)))) return [path + ".type: неизвестный тип блока"];
  const errors = Object.keys(value).filter((key) => !fields.includes(key)).map((key) => path + "." + key + ": поле не разрешено");
  const stringField = (key: string, max = 4000) => { if (!isText(value[key], max)) errors.push(path + "." + key + ": ожидается строка"); };
  switch (type) {
    case "text": stringField("text", 65536); break;
    case "heading": stringField("text", 1000); if (!Number.isInteger(value.level) || Number(value.level) < 1 || Number(value.level) > 3) errors.push(path + ".level: ожидается 1..3"); break;
    case "list": if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 200 || !value.items.every((x) => isText(x))) errors.push(path + ".items: ожидается список строк"); if (value.ordered !== undefined && typeof value.ordered !== "boolean") errors.push(path + ".ordered: ожидается boolean"); break;
    case "table": if (value.title !== undefined) stringField("title", 1000); if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 12 || !value.columns.every((x) => isText(x, 200))) errors.push(path + ".columns: ожидаются названия колонок"); if (!Array.isArray(value.rows) || value.rows.length > 100 || value.rows.some((row) => !Array.isArray(row) || row.length !== (Array.isArray(value.columns) ? value.columns.length : -1) || !row.every((x) => isText(x)))) errors.push(path + ".rows: строки должны совпадать с columns"); break;
    case "status": stringField("title", 1000); if (!["info", "in_progress", "passed", "failed", "blocked", "skipped"].includes(String(value.code))) errors.push(path + ".code: неизвестный статус"); if (value.text !== undefined) stringField("text"); break;
    case "progress": stringField("title", 1000); if (typeof value.current !== "number" || value.current < 0 || typeof value.total !== "number" || value.total <= 0 || value.current > value.total) errors.push(path + ": некорректные current/total"); break;
    case "chart": stringField("title", 1000); if (!["bar", "line"].includes(String(value.kind)) || !Array.isArray(value.points) || !value.points.length || value.points.length > 500 || value.points.some((p) => !isObject(p) || !isText(p.label, 256) || typeof p.value !== "number")) errors.push(path + ": некорректные данные графика"); break;
    case "diagram": stringField("title", 1000); if (!["chain", "ladder", "timeline"].includes(String(value.kind)) || !Array.isArray(value.items) || !value.items.length || value.items.length > 100 || value.items.some((item) => !isObject(item) || !isText(item.label, 256) || !["queued", "in_progress", "done", "blocked", "failed", "skipped"].includes(String(item.state)))) errors.push(path + ": некорректная схема"); break;
    case "report": {
      if (!["intermediate", "final"].includes(String(value.report_kind)) || !isObject(value.sections)) { errors.push(path + ": некорректный отчёт"); break; }
      const sections = value.sections; const names = ["result", "work", "checks", "limitations", "materials"];
      if (names.some((key) => !(key in sections)) || Object.keys(sections).some((key) => !names.includes(key))) errors.push(path + ".sections: нужны пять согласованных разделов");
      for (const key of ["result", "work", "limitations"]) if (!Array.isArray(sections[key]) || sections[key].some((block) => structuredBlockErrors(block, path + "." + key, true).length)) errors.push(path + ".sections." + key + ": недопустимые блоки");
      if (!Array.isArray(sections.checks) || sections.checks.length > 200 || sections.checks.some((check) => !isObject(check) || !isText(check.label, 1000) || !["passed", "failed", "blocked", "skipped", "not_run"].includes(String(check.status)))) errors.push(path + ".sections.checks: некорректные проверки");
      if (!Array.isArray(sections.materials) || sections.materials.length > 8 || sections.materials.some((item) => !isMaterial(item))) errors.push(path + ".sections.materials: некорректные материалы");
      break;
    }
    case "handoff": stringField("artifact_key", 128); stringField("summary"); break;
    case "command": stringField("command", 8000); if (value.title !== undefined) stringField("title", 300); if (isText(value.command) && (!value.command.trim() || value.command.includes("```"))) errors.push(path + ".command: пустая команда или ``` внутри"); break;
    case "link": stringField("title", 300); if (!isText(value.url, 2048) || !/^https?:\/\/\S+$/.test(value.url)) errors.push(path + ".url: ожидается адрес http(s) без пробелов"); break;
    case "html": stringField("title", 300); stringField("html", 60000); if (isText(value.html) && value.html.includes("```")) errors.push(path + ".html: ``` внутри"); break;
    case "widget": for (const problem of validateWidgetBlock(value.widget, path + ".widget")) errors.push(problem.path + ": " + problem.message); break;
  }
  return errors;
}

export function validateStructuredRoleContractV1(value: unknown): StructuredRoleContractValidation {
  if (!isObject(value)) return { valid: false, errors: ["конверт должен быть объектом"], envelope: null };
  const errors: string[] = [];
  const keys = ["schema_version", "ok", "output", "artifacts", "plan_artifact", "error", "next_hint", "needs_human"];
  for (const key of keys) if (!(key in value)) errors.push(key + ": обязательное поле отсутствует");
  for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(key + ": неизвестное поле");
  if (value.schema_version !== 1) errors.push("schema_version: поддерживается только 1");
  if (typeof value.ok !== "boolean") errors.push("ok: ожидается boolean");
  if (!Array.isArray(value.output) || value.output.length < 1 || value.output.length > 200) errors.push("output: ожидается 1..200 блоков");
  else value.output.forEach((block, index) => errors.push(...structuredBlockErrors(block, "output[" + index + "]")));
  if (!Array.isArray(value.artifacts) || value.artifacts.length > 8 || value.artifacts.some((item) => !isMaterial(item))) errors.push("artifacts: ожидается список до 8 материалов");
  if (value.plan_artifact !== null && (!isObject(value.plan_artifact) || !isText(value.plan_artifact.key, 128) || !isText(value.plan_artifact.type, 128) || value.plan_artifact.format !== "json" || !isText(value.plan_artifact.summary) || !isObject(value.plan_artifact.payload) || !Array.isArray(value.plan_artifact.evidence) || value.plan_artifact.evidence.length > 8 || value.plan_artifact.evidence.some((item) => !isMaterial(item)))) errors.push("plan_artifact: некорректный машинный артефакт");
  if (value.error !== null && (!isObject(value.error) || !["validation_error", "tool_error", "blocked", "other"].includes(String(value.error.code)) || !isText(value.error.message) || typeof value.error.retryable !== "boolean")) errors.push("error: некорректная ошибка");
  if (value.next_hint !== null && !isText(value.next_hint)) errors.push("next_hint: ожидается строка или null");
  if (typeof value.needs_human !== "boolean") errors.push("needs_human: ожидается boolean");
  return errors.length ? { valid: false, errors, envelope: null } : { valid: true, errors: [], envelope: value as unknown as StructuredRoleEnvelopeV1 };
}

/** Откуда взят конверт в ответе роли. `plain` — конверта нет, текст обычный. */
export type RoleAnswerFormat = "v1" | "legacy" | "plain";

export interface ParsedRoleAnswer {
  format: RoleAnswerFormat;
  /** Текст для показа владельцу: у конверта — только `output`. */
  text: string;
  envelope: RoleEnvelopeV1 | null;
  structuredEnvelope: StructuredRoleEnvelopeV1 | null;
  errors: string[];
  warnings: string[];
}

export interface RoleContractValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  envelope: RoleEnvelopeV1 | null;
}

const ENVELOPE_KEYS = ["ok", "output", "artifacts", "error", "next_hint", "needs_human"] as const;

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = str(value).trim();
  return text ? text : null;
}

function artifactList(value: unknown): { list: string[]; error: string | null } {
  if (value === null || value === undefined) return { list: [], error: null };
  if (typeof value === "string") {
    const one = value.trim();
    return { list: one ? [one] : [], error: null };
  }
  if (Array.isArray(value)) {
    const list = value.map((item) => str(item).trim()).filter(Boolean);
    return { list, error: null };
  }
  return { list: [], error: "artifacts: строка или список строк, либо null" };
}

/**
 * Проверка конверта v1. Ничего не бросает: возвращает список претензий —
 * вызывающая сторона решает, отказать ли (сдача) или показать как есть (чат).
 *
 * Обязательны только `ok` (логическое) и непустой `output` (строка): без
 * текста владельцу нечего показать. Остальные поля необязательны и
 * приводятся к нормализованному виду. Неизвестные ключи — предупреждение,
 * а не ошибка: роль может прислать поле v2, и терять из-за него ответ нельзя.
 */
export function validateRoleContractV1(value: unknown): RoleContractValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      valid: false,
      errors: ["конверт v1 — объект с полями ok, output, artifacts, error, next_hint, needs_human"],
      warnings,
      envelope: null,
    };
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(ENVELOPE_KEYS as readonly string[]).includes(key) && key !== "contract") {
      warnings.push(`поле «${key}» не входит в контракт ${ROLE_CONTRACT_V1}`);
    }
  }
  if (obj.contract !== undefined && obj.contract !== ROLE_CONTRACT_V1) {
    errors.push(`contract: ожидается «${ROLE_CONTRACT_V1}»`);
  }
  if (typeof obj.ok !== "boolean") errors.push("ok: логическое значение (true или false)");
  if (typeof obj.output !== "string") errors.push("output: строка с текстом для владельца");
  else if (!obj.output.trim()) errors.push("output: пуст — владельцу нечего показать");
  if (obj.needs_human !== undefined && typeof obj.needs_human !== "boolean") {
    errors.push("needs_human: логическое значение (true или false)");
  }
  const artifacts = artifactList(obj.artifacts);
  if (artifacts.error) errors.push(artifacts.error);
  if (obj.error !== undefined && obj.error !== null && typeof obj.error !== "string") {
    errors.push("error: строка либо null");
  }
  if (obj.next_hint !== undefined && obj.next_hint !== null && typeof obj.next_hint !== "string") {
    errors.push("next_hint: строка либо null");
  }
  if (errors.length) return { valid: false, errors, warnings, envelope: null };
  return {
    valid: true,
    errors,
    warnings,
    envelope: {
      contract: ROLE_CONTRACT_V1,
      ok: obj.ok as boolean,
      output: (obj.output as string).trim(),
      artifacts: artifacts.list,
      error: optionalText(obj.error),
      next_hint: optionalText(obj.next_hint),
      needs_human: obj.needs_human === true,
    },
  };
}

/** Бросающая обёртка для пути сдачи: там ошибка контракта — отказ 400. */
export function normalizeRoleContractV1(value: unknown): RoleEnvelopeV1 {
  const checked = validateRoleContractV1(value);
  if (!checked.valid || !checked.envelope) {
    throw new Error(`contract_v1 не проходит валидатор: ${checked.errors.join("; ")}`);
  }
  return checked.envelope;
}

// ── Разбор ответа роли: JSON v1 и старый YAML-подобный вид ─────────────

const JSON_FENCE = /```[ \t]*([\w+-]*)[ \t]*\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/g;
/** Дешёвая проверка «в тексте вообще есть конверт»: без неё каждый ответ
 *  любого собеседника прогонялся бы через разбор JSON. */
const ENVELOPE_MARK = /"?ok"?\s*:/;
const LEGACY_MARK = /ok\s*:\s*(true|false)/;
const LEGACY_KEY = /^(artifacts|error|next_hint|needs_human):/;
const BACKTICK_KEY = /^`((?:ok|output|artifacts|error|next_hint|needs_human):.*)`\s*$/;

/** Кандидат в JSON-конверт: старый строковый output или целевой массив блоков. Один `ok`
 *  без `output` — не конверт (например, пример JSON в обычном ответе). */
function asV1Candidate(body: string): unknown | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    if (!("ok" in obj) || !("output" in obj)) return null;
    if (typeof obj.output !== "string" && !(obj.schema_version === 1 && Array.isArray(obj.output))) return null;
    return value;
  } catch {
    return null;
  }
}

export function structuredOutputText(blocks: Record<string, unknown>[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case "text": return String(block.text ?? "");
      case "heading": return "#".repeat(Number(block.level ?? 2)) + " " + String(block.text ?? "");
      case "list": return (Array.isArray(block.items) ? block.items : []).map((item) => "• " + String(item)).join("\n");
      case "table": {
        // Таблица Markdown: клиенты рисуют её как таблицу (сервер сам делает из неё виджет).
        const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
        const columns = Array.isArray(block.columns) ? block.columns : [];
        const rows = Array.isArray(block.rows) ? block.rows : [];
        if (!columns.length) return rows.map((row) => Array.isArray(row) ? row.join(" | ") : "").join("\n");
        return [block.title ? "**" + String(block.title) + "**" : "", "| " + columns.map(cell).join(" | ") + " |", "|" + columns.map(() => " --- |").join(""),
          ...rows.map((row) => "| " + (Array.isArray(row) ? row : []).map(cell).join(" | ") + " |")].filter(Boolean).join("\n");
      }
      case "status": return String(block.title ?? "") + (block.text ? ": " + String(block.text) : "");
      case "progress": return String(block.title ?? "") + ": " + String(block.current ?? "") + " из " + String(block.total ?? "");
      case "chart": return "```widget\n" + JSON.stringify({ type: "chart", title: String(block.title ?? ""), kind: block.kind, ...(block.unit !== undefined ? { unit: block.unit } : {}),
        points: (Array.isArray(block.points) ? block.points : []).map((p: any) => ({ x: String(p?.label ?? ""), y: Number(p?.value ?? 0) })) }) + "\n```";
      case "diagram": return String(block.title ?? "") + ": " + (Array.isArray(block.items) ? block.items.map((item: any) => String(item.label ?? "")).join(" → ") : "");
      case "report": {
        const sections = block.sections as Record<string, any> | undefined;
        if (!sections) return "";
        return ["result", "work", "checks", "limitations", "materials"].flatMap((key) => {
          const value = sections[key];
          return Array.isArray(value) ? value.map((item) => typeof item === "string" ? item : item.text ?? item.label ?? item.title ?? "") : [];
        }).filter(Boolean).join("\n");
      }
      case "handoff": return String(block.summary ?? "");
      case "command": return (block.title ? String(block.title) + "\n" : "") + "```bash\n" + String(block.command ?? "").trim() + "\n```";
      case "link": return "[" + String(block.title ?? block.url ?? "").replace(/[\[\]]/g, "") + "](" + String(block.url ?? "") + ")";
      case "html": return "```html\n" + String(block.html ?? "").trim() + "\n```";
      case "widget": return "```widget\n" + JSON.stringify(block.widget ?? {}) + "\n```";
      default: return "";
    }
  }).filter(Boolean).join("\n\n");
}

// ── Старый YAML-подобный конверт (01.10.2026) ────────────────────────────
// Поведение сохранено один в один: снятие обрамления кодом, поля в
// `кавычках`, блочный `output: |`, недописанный конверт живого хода.

function legacyOutput(body: string): string | null {
  const first = body.split("\n").find((line) => line.trim());
  if (!first || !/^ok\s*:\s*(true|false)\s*$/.test(first.trim())) return null;
  try {
    const doc = parseYaml(body) as unknown;
    if (doc && typeof doc === "object" && typeof (doc as { output?: unknown }).output === "string") {
      return ((doc as { output: string }).output).trim();
    }
  } catch {
    // Конверт ещё не дописан (живой ход) — ниже вынимаем output руками.
  }
  const lines = body.split("\n");
  const at = lines.findIndex((line) => /^output:/.test(line));
  if (at < 0) return "";
  const inline = lines[at].replace(/^output:\s*/, "");
  if (inline && !/^[|>][-+]?\s*$/.test(inline)) {
    return inline.replace(/^["']|["']$/g, "").trim();
  }
  // output идёт до следующего поля конверта: без обрамления кодом роль
  // пишет его и без отступа.
  const block: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (LEGACY_KEY.test(line)) break;
    block.push(line);
  }
  const indents = block.filter((line) => line.trim()).map((line) => line.match(/^\s*/)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return block.map((line) => line.slice(cut)).join("\n").trim();
}

function stripLegacyBackticks(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const match = line.match(BACKTICK_KEY);
      return match ? match[1] : line;
    })
    .join("\n");
}

/**
 * Старый вид целиком. Поведение 01.10.2026 сохранено: обрамление кодом
 * снимается с каждого блока-конверта, текст вокруг и обычные блоки кода
 * остаются; конверт без обрамления (иногда с полями в `кавычках`) даёт
 * только свой `output`. Возвращает null, когда конверта в ответе нет.
 */
function parseLegacy(text: string): { text: string; body: string; envelopeOutput: string } | null {
  let firstBody: string | null = null;
  let firstOutput: string | null = null;
  const fenced = text.replace(JSON_FENCE, (whole, _lang: string, body: string) => {
    const out = legacyOutput(body);
    if (out === null) return whole;
    if (firstBody === null) {
      firstBody = body;
      firstOutput = out;
    }
    return out;
  });
  if (firstBody !== null && firstOutput !== null) {
    return { text: fenced, body: firstBody, envelopeOutput: firstOutput };
  }
  const cleaned = stripLegacyBackticks(text);
  const lines = cleaned.split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first < 0 || !/^ok\s*:\s*(true|false)\s*$/.test(lines[first].trim())) return null;
  const body = lines.slice(first).join("\n");
  const output = legacyOutput(body);
  return output === null ? null : { text: output, body, envelopeOutput: output };
}

/** Конверт из разобранного YAML-объекта старого вида; поля не приводим к
 *  строгому валидатору — этот формат исторически терпимый. */
function legacyEnvelope(body: string, output: string): RoleEnvelopeV1 | null {
  let doc: Record<string, unknown> | null = null;
  try {
    const parsed = parseYaml(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  } catch {
    doc = null;
  }
  const okLine = body.match(/^ok\s*:\s*(true|false)\s*$/m);
  const artifacts = artifactList(doc?.artifacts);
  return {
    contract: ROLE_CONTRACT_V1,
    ok: doc?.ok === false ? false : okLine ? okLine[1] === "true" : true,
    output,
    artifacts: artifacts.list,
    error: optionalText(doc?.error),
    next_hint: optionalText(doc?.next_hint),
    needs_human: doc?.needs_human === true,
  };
}

/**
 * Разобрать ответ роли: сначала JSON-контракт v1, затем старый
 * YAML-подобный вид, иначе — обычный текст без изменений.
 *
 * Конверт в блоке кода снимается так же, как старый: текст вокруг и обычные
 * блоки кода остаются. Битый конверт НЕ выбрасывается: текст возвращается
 * как есть, а претензии кладутся в `errors` — пустой ответ владельцу хуже,
 * чем неразобранный.
 */
export function parseRoleContractV1(text: string): ParsedRoleAnswer {
  const plain: ParsedRoleAnswer = { format: "plain", text, envelope: null, structuredEnvelope: null, errors: [], warnings: [] };
  if (!text || !ENVELOPE_MARK.test(text)) return plain;

  const errors: string[] = [];
  const warnings: string[] = [];
  let envelope: RoleEnvelopeV1 | null = null;
  let structuredEnvelope: StructuredRoleEnvelopeV1 | null = null;
  let replaced = false;
  const fenced = text.replace(JSON_FENCE, (whole, lang: string, body: string) => {
    if (lang && !/^(json|jsonc|json5)$/i.test(lang)) return whole;
    const candidate = asV1Candidate(body);
    if (candidate === null) return whole;
    if (isObject(candidate) && candidate.schema_version !== undefined) {
      const checked = validateStructuredRoleContractV1(candidate);
      if (!checked.valid || !checked.envelope) {
        errors.push(...checked.errors);
        return whole;
      }
      replaced = true;
      structuredEnvelope ??= checked.envelope;
      return structuredOutputText(checked.envelope.output);
    }
    const checked = validateRoleContractV1(candidate);
    warnings.push(...checked.warnings);
    if (!checked.valid || !checked.envelope) {
      errors.push(...checked.errors);
      return whole;
    }
    replaced = true;
    envelope ??= checked.envelope;
    return checked.envelope.output;
  });
  if (replaced || errors.length) {
    return { format: "v1", text: replaced ? fenced : text, envelope, structuredEnvelope, errors, warnings };
  }

  const bare = asV1Candidate(text.trim());
  if (bare !== null) {
    if (isObject(bare) && bare.schema_version !== undefined) {
      const checked = validateStructuredRoleContractV1(bare);
      if (checked.valid && checked.envelope) {
        return { format: "v1", text: structuredOutputText(checked.envelope.output), envelope: null, structuredEnvelope: checked.envelope, errors: [], warnings: [] };
      }
      return { format: "v1", text, envelope: null, structuredEnvelope: null, errors: checked.errors, warnings: [] };
    }
    const checked = validateRoleContractV1(bare);
    if (checked.valid && checked.envelope) {
      return { format: "v1", text: checked.envelope.output, envelope: checked.envelope, structuredEnvelope: null, errors: [], warnings: checked.warnings };
    }
    return { format: "v1", text, envelope: null, structuredEnvelope: null, errors: checked.errors, warnings: checked.warnings };
  }

  const legacy = parseLegacy(text);
  if (legacy) {
    return {
      format: "legacy",
      text: legacy.text,
      envelope: legacyEnvelope(legacy.body, legacy.envelopeOutput),
      structuredEnvelope: null,
      errors: [],
      warnings: [],
    };
  }
  return plain;
}

function decodeJSONStringPrefix(text: string, quoteAt: number): string | null {
  if (text[quoteAt] !== '"') return null;
  let result = "";
  for (let i = quoteAt + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') return result;
    if (ch !== "\\") { result += ch; continue; }
    i += 1;
    if (i >= text.length) break;
    const escape = text[i];
    const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    if (escape in simple) { result += simple[escape]; continue; }
    if (escape === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
      result += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
      i += 4;
      continue;
    }
    break;
  }
  return result;
}

/** Во время JSON-потока показываем только текущий текстовый блок, не оболочку. */
function partialStructuredText(text: string): string | null {
  const output = /"output"\s*:\s*/.exec(text);
  if (!output) return null;
  let cursor = output.index + output[0].length;
  while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  if (text[cursor] === '"') return decodeJSONStringPrefix(text, cursor);
  if (text[cursor] !== "[") return null;
  const tail = text.slice(cursor);
  const type = /"type"\s*:\s*"text"/.exec(tail);
  if (!type) return null;
  const field = /"text"\s*:\s*"/.exec(tail.slice(type.index + type[0].length));
  if (!field) return null;
  const quoteAt = cursor + type.index + type[0].length + field.index + field[0].length - 1;
  return decodeJSONStringPrefix(text, quoteAt);
}

/** Текст для показа владельцу: конверт снят, обычный ответ не тронут. */
export function unwrapRoleEnvelopeText(text: string): string {
  const parsed = parseRoleContractV1(text);
  if (parsed.format === "plain") return partialStructuredText(text) ?? parsed.text;
  return parsed.text;
}

/** Конверт для поля сообщения чата (`role_envelope`) либо null. */
export function roleEnvelopeField(text: unknown): RoleEnvelopeV1 | StructuredRoleEnvelopeV1 | null {
  if (typeof text !== "string") return null;
  const parsed = parseRoleContractV1(text);
  return parsed.structuredEnvelope ?? parsed.envelope;
}

/** Набор правил одной строкой — для инструкции роли и документации. */
export const ROLE_CONTRACT_V1_RULE =
  `JSON-контракт роли v1 (${ROLE_CONTRACT_V1}): один объект с полями ok (да/нет), ` +
  `output (текст для владельца), artifacts (список ссылок), error (строка или null), ` +
  `next_hint (строка или null), needs_human (да/нет). Старый вид ok:/output: тоже принимается.`;

export interface NormalizedRoleReplyV1 {
  envelope: StructuredRoleEnvelopeV1;
  /** User-facing text derived from the normalized output blocks. */
  displayText: string;
  /** True when the server had to wrap an answer that was not valid JSON v1. */
  normalizedByServer: boolean;
  validationErrors: string[];
}

/**
 * Normalize a completed role reply to the closed chat v1 envelope. This is a
 * server-side boundary guarantee: it does not constrain how the provider
 * generated the original text. Invalid or plain-text replies are preserved
 * verbatim inside a text block, so validation never discards an answer.
 */
export function normalizeRoleReplyV1(text: string): NormalizedRoleReplyV1 {
  const parsed = parseRoleContractV1(text);
  if (parsed.structuredEnvelope) {
    return {
      envelope: parsed.structuredEnvelope,
      displayText: structuredOutputText(parsed.structuredEnvelope.output),
      normalizedByServer: false,
      validationErrors: [],
    };
  }

  if (parsed.envelope) {
    const legacy = parsed.envelope;
    const displayText = legacy.output || text.trim();
    const envelope: StructuredRoleEnvelopeV1 = {
      schema_version: 1,
      ok: legacy.ok,
      output: [{ type: "text", text: displayText }],
      artifacts: legacy.artifacts.map((ref, index) => ({ kind: "artifact", title: "Материал " + (index + 1), ref })),
      plan_artifact: null,
      error: legacy.error ? { code: "other", message: legacy.error, retryable: false } : null,
      next_hint: legacy.next_hint,
      needs_human: legacy.needs_human,
    };
    return { envelope, displayText, normalizedByServer: true, validationErrors: parsed.warnings };
  }

  const validationErrors = parsed.errors.length
    ? parsed.errors
    : parsed.format === "plain"
      ? ["Ответ не содержит JSON v1 конверт"]
      : ["Ответ не удалось разобрать как JSON v1"];
  const preservedText = text.trim() || "Ответ не содержит текста.";
  const envelope: StructuredRoleEnvelopeV1 = {
    schema_version: 1,
    ok: true,
    output: [{ type: "text", text: preservedText }],
    artifacts: [],
    plan_artifact: null,
    error: null,
    next_hint: null,
    needs_human: false,
  };
  return { envelope, displayText: preservedText, normalizedByServer: true, validationErrors };
}
