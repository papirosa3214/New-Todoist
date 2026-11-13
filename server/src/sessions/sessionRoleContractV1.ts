// ═══ КОПИЯ ДЛЯ СЕССИЙ (владелец 13.11.2026: «скопировать из того файлика в этот»).
// Исходник у ролей — server/src/lib/roleContractV1.ts. Правки сессий — сюда, ролей — туда.
import {compactChatReportMaterials} from "../lib/chatReportMaterials.js";
// Готовая разметка таблиц, графиков и схем — кладётся сервером в блоки
// (`server_html`), см. chatTemplates.ts. Клиент, который вид знает, продолжает
// рисовать нативно; поле серверное, от модели оно не принимается.
import {attachServerHtml, blocksFromMarkdown} from "../lib/chatTemplates.js";
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
import { validateWidgetBlock } from "../lib/widgetContract.js";

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
  link: "`title`, `url`: кликабельная ссылка. Внешний адрес — http(s); заметка в приложении на телефоне — `note://<id заметки>`. Клиент сам рисует иконку хоста и короткую подпись (`o/r#12`), длинный адрес прятать не надо. Пути к файлам оформляй полным путём со строкой через двоеточие — `Sources/…/File.swift:42`",
  html: "`title`, `html`: интерактив в окне чата — самодостаточная страница HTML/CSS/JS",
  widget: "`widget`: объект виджета (`metrics`, `progress`, `checklist`, `card`, `chart` и др.); сервер проверяет его по каталогу виджетов",
};
export function roleBlockLines(): string {
  return Object.keys(STRUCTURED_BLOCK_FIELDS).map((type) => "- `" + type + "` — " + (ROLE_BLOCK_GUIDE[type] ?? "")).join("\n");
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/**
 * Адрес в блоке link: внешний http(s) ИЛИ внутренняя ссылка на заметку
 * приложения `note://<id>` (владелец 23.10.2026: «ссылку правильную давай
 * на материал... чтобы по падении мог сразу прочитать» — с телефона тап по
 * ссылке открывает заметку в приложении, а не веб-страницу). Схема та же, что
 * у `taskflow_chat_share_material`: клиент уже умеет её открывать
 * (`ChatMaterialDestination` в iOS).
 */
const LINK_URL_PATTERN = /^(?:https?:\/\/\S+|note:\/\/[A-Za-z0-9_-]+)$/;
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
    case "link": stringField("title", 300); if (!isText(value.url, 2048) || !LINK_URL_PATTERN.test(value.url)) errors.push(path + ".url: ожидается http(s)-адрес без пробелов или note://<id заметки>"); break;
    case "html": stringField("title", 300); stringField("html", 60000); if (isText(value.html) && value.html.includes("```")) errors.push(path + ".html: ``` внутри"); break;
    case "widget": for (const problem of validateWidgetBlock(value.widget, path + ".widget")) errors.push(problem.path + ": " + problem.message); break;
  }
  return errors;
}

export function validateStructuredRoleContractV1(value: unknown): StructuredRoleContractValidation {
  if (!isObject(value)) return { valid: false, errors: ["конверт должен быть объектом"], envelope: null };
  const errors: string[] = [];
  // `needs_human` — необязательное поле (решение владельца 21.10.2026): без него
  // «решение владельца не нужно», ровно как читает iOS-клиент
  // (`decodeIfPresent(Bool.self, forKey: .needsHuman) ?? false`). Раньше поле было
  // обязательным, и роль, его забывшая, отдавала владельцу сырой JSON вместо
  // блоков (21.10.2026: ответ роли в чате). Значение, если есть, — только boolean.
  const requiredKeys = STRUCTURED_REQUIRED_KEYS;
  const allowedKeys = STRUCTURED_ALLOWED_KEYS;
  for (const key of requiredKeys) if (!(key in value)) errors.push(key + ": обязательное поле отсутствует");
  for (const key of Object.keys(value)) if (!allowedKeys.includes(key)) errors.push(key + ": неизвестное поле");
  if (value.schema_version !== 1) errors.push("schema_version: поддерживается только 1");
  if (typeof value.ok !== "boolean") errors.push("ok: ожидается boolean");
  if (!Array.isArray(value.output) || value.output.length < 1 || value.output.length > 200) errors.push("output: ожидается 1..200 блоков");
  else value.output.forEach((block, index) => errors.push(...structuredBlockErrors(block, "output[" + index + "]")));
  if (!Array.isArray(value.artifacts) || value.artifacts.length > 8 || value.artifacts.some((item) => !isMaterial(item))) errors.push("artifacts: ожидается список до 8 материалов");
  if (value.plan_artifact !== null && (!isObject(value.plan_artifact) || !isText(value.plan_artifact.key, 128) || !isText(value.plan_artifact.type, 128) || value.plan_artifact.format !== "json" || !isText(value.plan_artifact.summary) || !isObject(value.plan_artifact.payload) || !Array.isArray(value.plan_artifact.evidence) || value.plan_artifact.evidence.length > 8 || value.plan_artifact.evidence.some((item) => !isMaterial(item)))) errors.push("plan_artifact: некорректный машинный артефакт");
  if (value.error !== null && (!isObject(value.error) || !["validation_error", "tool_error", "blocked", "other"].includes(String(value.error.code)) || !isText(value.error.message) || typeof value.error.retryable !== "boolean")) errors.push("error: некорректная ошибка");
  if (value.next_hint !== null && !isText(value.next_hint)) errors.push("next_hint: ожидается строка или null");
  if (value.needs_human !== undefined && typeof value.needs_human !== "boolean") errors.push("needs_human: ожидается boolean");
  if (errors.length) return { valid: false, errors, envelope: null };
  // В нормализованном конверте поле всегда есть: отсутствие = «решение не нужно».
  return {
    valid: true,
    errors: [],
    envelope: { ...(value as unknown as StructuredRoleEnvelopeV1), needs_human: value.needs_human === true },
  };
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

const STRUCTURED_REQUIRED_KEYS = ["schema_version", "ok", "output", "artifacts", "plan_artifact", "error", "next_hint"];
const STRUCTURED_ALLOWED_KEYS = [...STRUCTURED_REQUIRED_KEYS, "needs_human"];
const LEGACY_MARK = /ok\s*:\s*(true|false)/;
const LEGACY_KEY = /^(artifacts|error|next_hint|needs_human):/;
const BACKTICK_KEY = /^`((?:ok|output|artifacts|error|next_hint|needs_human):.*)`\s*$/;

/** Конверт, вклиненный в произвольный текст: ответ роли часто приходит как
 *  «пояснение + JSON». Раньше такой ответ не распознавался, и владелец видел
 *  сырой JSON. Здесь ищем первый сбалансированный JSON-объект, который сам
 *  проходит проверку конверта, и вырезаем его вместе с обвязкой. */
function extractEmbeddedEnvelope(text: string): { candidate: unknown; prefix: string; suffix: string } | null {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        const body = text.slice(start, i + 1);
        const candidate = asV1Candidate(body);
        if (candidate) return { candidate, prefix: text.slice(0, start), suffix: text.slice(i + 1) };
        break;
      }
    }
  }
  return null;
}

/** Кандидат в JSON-конверт: старый строковый output или целевой массив блоков. Один `ok`
 *  без `output` — не конверт (например, пример JSON в обычном ответе). */
/** Объект JSON с лишними закрывающими скобками в конце (владелец 27.10.2026:
 *  модель приписала «}]}» к верному конверту — ответ ушёл сырым JSON).
 *  Отбрасываем хвост, только если он состоит из одних `}`/`]` и пробелов. */
/** Убрать запятую перед `}` или `]` вне строк — частая ошибка модели в
 *  конверте (27.10.2026: ответ Помощника пришёл владельцу сырым JSON). */
function stripTrailingCommas(text: string): string {
  let out = "", inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
    } else if (ch === "\"") inString = true;
    else if (ch === "," && /^\s*[\]}]/.test(text.slice(i + 1))) continue;
    out += ch;
  }
  return out;
}

function parseObjectLenient(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // ниже — разбор с починкой
  }
  const trimmed = stripTrailingCommas(raw);
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    let depth = 0, inString = false, escaped = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          if (!/^[\s\]}]*$/.test(trimmed.slice(i + 1))) break;
          return JSON.parse(trimmed.slice(0, i + 1));
        }
      }
    }
    throw error;
  }
}

function asV1Candidate(body: string): unknown | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = parseObjectLenient(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    if (!("ok" in obj) || !("output" in obj)) return null;
    if (typeof obj.output !== "string" && !Array.isArray(obj.output)) return null;
    return value;
  } catch {
    return null;
  }
}

// Имена из кода, пути и файлы — в обратных кавычках, что бы ни написала роль
// (владелец 11.11.2026: «чтобы от роли не зависело, сервер сам вставлял»).
// Без кавычек `note_accesses` шло курсивом, путь — голым текстом без значка.
// Уже размеченное (код, ссылки, адреса) не трогаем.
const CODE_TOKEN = new RegExp([
  String.raw`(?<![\w/~.\-])(?:~|\.{1,2})?\/[\w.\-]+(?:\/[\w.\-]+)*\/?(?![\w/])`,
  String.raw`(?<![\w/.\-])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+(?![\w/])`,
  String.raw`(?<![\w/.\-])[\w\-]+(?:\.[\w\-]+)*\.(?:ts|tsx|js|mjs|cjs|jsx|swift|py|md|json|sh|yml|yaml|sql|db|txt|log|html|css|toml|plist|kt|go|rs)(?![\w/])`,
].join("|"), "g");
const PROTECTED = /(```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>|https?:\/\/\S+|[a-z]+:\/\/\S+)/g;

export function codeIdentifiers(text: string): string {
  return text.split(PROTECTED).map((part, index) => index % 2 === 1 ? part
    : part.replace(CODE_TOKEN, (token) => "`" + token + "`")).join("");
}

function materialLine(item: any): string {
  const title = String(item?.title ?? "").replace(/[\[\]]/g, "").trim();
  const ref = String(item?.ref ?? "").trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const href = uuid.test(ref) ? "note://" + ref : /^(note|task|taskflow|https?):\/\//i.test(ref) ? ref : "";
  if (href) return "- [" + (title || href) + "](" + href + ")";
  return "- " + codeIdentifiers(title || ref);
}

export function structuredOutputText(blocks: Record<string, unknown>[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case "text": return codeIdentifiers(String(block.text ?? ""));
      case "heading": return "#".repeat(Number(block.level ?? 2)) + " " + String(block.text ?? "");
      case "list": return (Array.isArray(block.items) ? block.items : []).map((item) => "- " + codeIdentifiers(String(item))).join("\n");
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
        // Разделы отчёта — те же блоки, что и обычный output: собираем их тем же
        // рендером. Раньше здесь бралось только `text|label|title` верхнего
        // уровня, и владелец видел заголовки без содержимого: пункты `list`,
        // ограничения и статусы проверок пропадали (жалоба 10.11.2026).
        const sections = block.sections as Record<string, any> | undefined;
        if (!sections) return "";
        const parts: string[] = [];
        const pushSection = (title: string, rendered: string) => { if (rendered) parts.push("## " + title + "\n" + rendered); };
        const renderBlocks = (value: unknown) => Array.isArray(value) ? structuredOutputText(value.filter(isObject)) : "";
        pushSection("Результат", renderBlocks(sections.result));
        pushSection("Что сделано", renderBlocks(sections.work));
        const checks = Array.isArray(sections.checks) ? sections.checks.filter(isObject) : [];
        pushSection("Проверки", checks.map((check: any) => "- " + codeIdentifiers(String(check.label ?? "")) + (check.status ? " — " + String(check.status) : "")).join("\n"));
        pushSection("Ограничения", renderBlocks(sections.limitations));
        const materials = Array.isArray(sections.materials) ? sections.materials.filter(isObject) : [];
        pushSection("Материалы", materials.map(materialLine).join("\n"));
        return parts.join("\n\n");
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
 * Показ ответа с кривыми блоками (владелец 21.10.2026): один блок без типа
 * ронял весь конверт, и владелец видел сырой JSON вместо заголовка и текста.
 * Здесь кривые блоки `output` отбрасываются по одному, остальное проверяется
 * заново. Только для показа: претензии остаются в `errors`, а проверка
 * формата при отправке смотрит на сам валидатор и по-прежнему возвращает
 * роли кривой ответ.
 */
function salvageStructured(original: Record<string, unknown>): StructuredRoleEnvelopeV1 | null {
  let candidate = original;
  const output = candidate.output;
  if (!Array.isArray(output)) return null;
  // Своё поле верхнего уровня (владелец 27.10.2026: Помощница дописала
  // `report`) не повод выбросить весь конверт: отбрасываем лишнее и
  // проверяем снова.
  const known = Object.fromEntries(Object.entries(candidate).filter(([key]) => STRUCTURED_ALLOWED_KEYS.includes(key)));
  if (Object.keys(known).length !== Object.keys(candidate).length) {
    const checked = validateStructuredRoleContractV1(known);
    if (checked.valid && checked.envelope) return checked.envelope;
    candidate = known;
  }
  const blocks = output.filter((block) => validateStructuredRoleContractV1({ ...candidate, output: [block] }).valid);
  if (!blocks.length || blocks.length === output.length) return null;
  const checked = validateStructuredRoleContractV1({ ...candidate, output: blocks });
  return checked.valid ? checked.envelope : null;
}

/** Внутренний маркер: сервер не смог извлечь содержимое. Владельцу он не отображается;
 *  обычный маршрут отправляет роль на однократное исправление. */
const BROKEN_CONTRACT_NOTE = "";

/** Из битого JSON-конверта вытащить текст `output` (или `error`), чтобы владелец
 *  видел содержимое, а не сырой объект с ключами. null — текста нет. */
function brokenEnvelopeText(value: unknown): string | null {
  if (!isObject(value)) return null;
  const output = value.output;
  if (typeof output === "string") {
    const text = output.trim();
    if (text) return text;
  } else if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const block of output) {
      if (!isObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text);
      else if (block.type === "heading" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "list" && Array.isArray(block.items)) {
        const items = (block.items as unknown[]).filter((x): x is string => typeof x === "string").map((x) => "• " + x);
        if (items.length) parts.push(items.join("\n"));
      } else if (block.type === "command" && typeof block.command === "string") {
        parts.push((block.title ? String(block.title) + "\n" : "") + block.command);
      } else if (block.type === "link" && typeof block.url === "string") {
        parts.push(String(block.title ?? block.url));
      }
    }
    const joined = parts.filter(Boolean).join("\n\n");
    if (joined) return joined;
  }
  const error = value.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isObject(error) && typeof error.message === "string" && error.message.trim()) return error.message.trim();
  return null;
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
        const salvaged = salvageStructured(candidate);
        if (!salvaged) {
          const text = brokenEnvelopeText(candidate);
          replaced = true;
          return text ?? BROKEN_CONTRACT_NOTE;
        }
        replaced = true;
        structuredEnvelope ??= salvaged;
        return structuredOutputText(salvaged.output);
      }
      replaced = true;
      structuredEnvelope ??= checked.envelope;
      return structuredOutputText(checked.envelope.output);
    }
    const checked = validateRoleContractV1(candidate);
    warnings.push(...checked.warnings);
    if (!checked.valid || !checked.envelope) {
      errors.push(...checked.errors);
      // Битый конверт: исходный текст не переписываем, претензия уходит в errors.
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
      const salvaged = salvageStructured(bare);
      if (salvaged) {
        return { format: "v1", text: structuredOutputText(salvaged.output), envelope: null, structuredEnvelope: salvaged, errors: checked.errors, warnings: [] };
      }
      return { format: "v1", text: brokenEnvelopeText(bare) ?? BROKEN_CONTRACT_NOTE, envelope: null, structuredEnvelope: null, errors: checked.errors, warnings: [] };
    }
    const checked = validateRoleContractV1(bare);
    if (checked.valid && checked.envelope) {
      return { format: "v1", text: checked.envelope.output, envelope: checked.envelope, structuredEnvelope: null, errors: [], warnings: checked.warnings };
    }
    return { format: "v1", text: brokenEnvelopeText(bare) ?? BROKEN_CONTRACT_NOTE, envelope: null, structuredEnvelope: null, errors: checked.errors, warnings: checked.warnings };
  }

  const embedded = extractEmbeddedEnvelope(text);
  if (embedded) {
    const value = embedded.candidate as Record<string, unknown>;
    const before = embedded.prefix.trim();
    const after = embedded.suffix.trim();
    if (value.schema_version !== undefined) {
      const checked = validateStructuredRoleContractV1(value);
      if (checked.valid && checked.envelope) {
        const blocks = [...checked.envelope.output];
        if (before) blocks.unshift({ type: "text", text: before });
        if (after) blocks.push({ type: "text", text: after });
        return { format: "v1", text: structuredOutputText(blocks), envelope: null, structuredEnvelope: { ...checked.envelope, output: blocks }, errors: [], warnings: [] };
      }
      const salvaged = salvageStructured(value);
      if (salvaged) {
        const blocks = [...salvaged.output];
        if (before) blocks.unshift({ type: "text", text: before });
        if (after) blocks.push({ type: "text", text: after });
        return { format: "v1", text: structuredOutputText(blocks), envelope: null, structuredEnvelope: { ...salvaged, output: blocks }, errors: checked.errors, warnings: [] };
      }
      // Битый конверт внутри текста: текст не переписываем, претензию отдаём в errors.
      return { format: "v1", text, envelope: null, structuredEnvelope: null, errors: checked.errors, warnings: [] };
    }
    const checkedLegacy = validateRoleContractV1(value);
    if (checkedLegacy.valid && checkedLegacy.envelope) {
      return { format: "v1", text: checkedLegacy.envelope.output, envelope: checkedLegacy.envelope, structuredEnvelope: null, errors: [], warnings: checkedLegacy.warnings };
    }
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
  // Весь массив блоков потоком (владелец 06.11.2026: ответ в конверте
  // «прилетает за раз»). Готовый блок — целиком, как в сохранённом ответе
  // (таблица, виджет, код встают на своё место); недописанный текст или
  // заголовок — по мере поступления; недописанный блок другого вида ждёт.
  const parts: string[] = [];
  let i = cursor + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i += 1;
    if (text[i] !== "{") break;
    const close = matchingBrace(text, i);
    if (close < 0) {
      const partial = text.slice(i);
      const type = /"type"\s*:\s*"(text|heading)"/.exec(partial);
      const field = /"text"\s*:\s*"/.exec(partial);
      if (type && field) {
        const prefix = decodeJSONStringPrefix(text, i + field.index + field[0].length - 1);
        if (prefix) {
          const level = Number(/"level"\s*:\s*(\d)/.exec(partial)?.[1] ?? 2);
          parts.push(type[1] === "heading" ? "#".repeat(level) + " " + prefix : prefix);
        }
      }
      break;
    }
    try {
      const block = JSON.parse(text.slice(i, close + 1));
      const rendered = structuredOutputText([block]);
      if (rendered) parts.push(rendered);
    } catch {
      break;
    }
    i = close + 1;
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** Закрывающая скобка объекта с учётом строк; -1 — объект не дописан. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
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

/** Стеклянное замечание роли: сервер обернул брак формы, контракт не ослаблен. */
export const ROLE_REPLY_GLASS_REMARK =
  "Стекло: финальный ответ не был JSON-конвертом v1. Сервер обернул текст в output[]; в следующий ход верни один JSON-объект.";

export function isJsonParseFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /is not valid JSON|Unexpected token|JSON\.parse/i.test(message);
}

/** Если ход упал на JSON.parse markdown — вернуть текст для normalizeRoleReplyV1, иначе null. */
export function salvageMarkdownFromJsonParseFailure(error: unknown, partialText = ""): string | null {
  if (!isJsonParseFailure(error)) return null;
  const partial = partialText.trim();
  if (partial && !/^\s*[{[]/.test(partial)) return partial;
  const message = error instanceof Error ? error.message : String(error ?? "");
  // Node: Unexpected token '#', "## Результ"... is not valid JSON
  const snippet = /Unexpected token [^,]*, "([\s\S]*?)"(?:\.\.\.)?\s*is not valid JSON/.exec(message);
  const recovered = snippet?.[1]?.trim() ?? "";
  if (recovered && !recovered.startsWith("{") && !recovered.startsWith("[")) {
    return partial || recovered;
  }
  return partial || null;
}

/**
 * Исправимая ошибка финального ответа: роль получает один адресный повтор,
 * прежде чем сервер покажет владельцу безопасно нормализованный fallback.
 */
export function shouldRetryRoleReply(normalized: NormalizedRoleReplyV1): boolean {
  // Сервер сам строит канонический конверт, когда смог извлечь смысл ответа.
  // Повтор роли нужен только при пустом результате: ему не место в чате владельца.
  const hasRecoverableContent = normalized.displayText.trim().length > 0;
  return normalized.normalizedByServer && !hasRecoverableContent;
}

export function roleReplyCorrectionPrompt(errors: string[]): string {
  const exact = errors.length ? errors : ["Ответ не прошёл проверку JSON-контракта v1"];
  return [
    "Исправь только формат предыдущего финального ответа и верни его заново. Не повторяй работу и не вызывай инструменты.",
    "Ошибки валидации:",
    ...exact.slice(0, 8).map((error) => `- ${error}`),
    "Верни один JSON-объект без Markdown и пояснений в форме:",
    '{"schema_version":1,"ok":true,"output":[{"type":"text","text":"Краткий результат"}],"artifacts":[],"plan_artifact":null,"error":null,"next_hint":null,"needs_human":false}',
    "Сохрани факты, ссылки, материалы и доступные действия из предыдущего ответа; исправь только поля и блоки, названные выше.",
  ].join("\n");
}

export function exhaustedRoleReplyFallback(normalized: NormalizedRoleReplyV1): NormalizedRoleReplyV1 {
  const detail = normalized.displayText.trim();
  const text = detail && detail !== BROKEN_CONTRACT_NOTE
    ? detail
    : "Роль завершила работу, но после одной попытки не смогла оформить ответ в поддерживаемом формате.";
  const envelope: StructuredRoleEnvelopeV1 = {
    schema_version: 1,
    ok: false,
    output: [{ type: "text", text }],
    artifacts: [],
    plan_artifact: null,
    error: {
      code: "invalid_role_reply",
      message: "Ответ роли не прошёл проверку формата после автоматической попытки исправления.",
      retryable: true,
    },
    next_hint: "Можно попросить роль повторить ответ.",
    needs_human: false,
  };
  return { ...normalized, envelope, displayText: text };
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
    // Разметку таблиц/графиков/схем собирает сервер: блок остаётся с данными,
    // рядом ложится `server_html`. Так новый вид блока не требует пересборки
    // приложения, а клиент, который вид знает, продолжает рисовать нативно.
    const envelope = attachServerHtml(compactChatReportMaterials(parsed.structuredEnvelope).envelope);
    return {
      envelope,
      displayText: structuredOutputText(parsed.structuredEnvelope.output),
      // Спасённый конверт (кривые блоки отброшены) — тоже правка сервера:
      // претензии уходят в журнал, а не теряются.
      normalizedByServer: parsed.errors.length > 0,
      validationErrors: parsed.errors,
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
  // Сырой конверт владельцу не показываем ни при каких условиях (владелец
  // 27.10.2026): что удалось вынуть из полей text — показываем, иначе пометка.
  const rawEnvelope = /^\s*(?:```[a-z0-9]*\s*)?\{\s*"schema_version"/i.test(text);
  const preservedText = rawEnvelope
    ? partialStructuredText(text) ?? BROKEN_CONTRACT_NOTE
    : text.trim() || "Ответ не содержит текста.";
  // Разметка в свободном ответе роли становится блоками: заголовки, списки,
  // таблицы, чекбоксы, эмодзи-статусы, команды и ссылки. Иначе владелец видит
  // один сплошной текст — без кнопки «Запустить» и без таблицы.
  const envelope: StructuredRoleEnvelopeV1 = attachServerHtml({
      schema_version: 1,
      ok: true,
      output: blocksFromMarkdown(preservedText),
      artifacts: [],
      plan_artifact: null,
      error: null,
      next_hint: null,
      needs_human: false,
    });
  if (!validationErrors.includes(ROLE_REPLY_GLASS_REMARK)) validationErrors.push(ROLE_REPLY_GLASS_REMARK);
  return { envelope, displayText: preservedText, normalizedByServer: true, validationErrors };
}
