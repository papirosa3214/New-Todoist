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
//   - поля result / report_markdown / artifact / evidence не меняются: контракт
//     сдачи остаётся прежним, конверт — дополнительный вход;
//   - iOS-репозиторий не трогаем: сервер отдаёт конверт в сообщении чата
//     полем `role_envelope` и показывает владельцу текст `output`, а рисование
//     конверта на клиенте — следующая карточка (клиент просто игнорирует
//     незнакомое поле, старые ответы приходят без него вовсе).
import { parse as parseYaml } from "yaml";

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

/** Откуда взят конверт в ответе роли. `plain` — конверта нет, текст обычный. */
export type RoleAnswerFormat = "v1" | "legacy" | "plain";

export interface ParsedRoleAnswer {
  format: RoleAnswerFormat;
  /** Текст для показа владельцу: у конверта — только `output`. */
  text: string;
  envelope: RoleEnvelopeV1 | null;
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

/** Кандидат в JSON-конверт: объект с `ok` и строкой `output`. Один `ok`
 *  без `output` — не конверт (например, пример JSON в обычном ответе). */
function asV1Candidate(body: string): unknown | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    if (!("ok" in obj) || !("output" in obj)) return null;
    if (typeof obj.output !== "string") return null;
    return value;
  } catch {
    return null;
  }
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
  const plain: ParsedRoleAnswer = { format: "plain", text, envelope: null, errors: [], warnings: [] };
  if (!text || !ENVELOPE_MARK.test(text)) return plain;

  const errors: string[] = [];
  const warnings: string[] = [];
  let envelope: RoleEnvelopeV1 | null = null;
  let replaced = false;
  const fenced = text.replace(JSON_FENCE, (whole, lang: string, body: string) => {
    if (lang && !/^(json|jsonc|json5)$/i.test(lang)) return whole;
    const candidate = asV1Candidate(body);
    if (candidate === null) return whole;
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
    return { format: "v1", text: replaced ? fenced : text, envelope, errors, warnings };
  }

  const bare = asV1Candidate(text.trim());
  if (bare !== null) {
    const checked = validateRoleContractV1(bare);
    if (checked.valid && checked.envelope) {
      return { format: "v1", text: checked.envelope.output, envelope: checked.envelope, errors: [], warnings: checked.warnings };
    }
    return { format: "v1", text, envelope: null, errors: checked.errors, warnings: checked.warnings };
  }

  const legacy = parseLegacy(text);
  if (legacy) {
    return {
      format: "legacy",
      text: legacy.text,
      envelope: legacyEnvelope(legacy.body, legacy.envelopeOutput),
      errors: [],
      warnings: [],
    };
  }
  return plain;
}

/** Текст для показа владельцу: конверт снят, обычный ответ не тронут. */
export function unwrapRoleEnvelopeText(text: string): string {
  return parseRoleContractV1(text).text;
}

/** Конверт для поля сообщения чата (`role_envelope`) либо null. */
export function roleEnvelopeField(text: unknown): RoleEnvelopeV1 | null {
  if (typeof text !== "string") return null;
  return parseRoleContractV1(text).envelope;
}

/** Набор правил одной строкой — для инструкции роли и документации. */
export const ROLE_CONTRACT_V1_RULE =
  `JSON-контракт роли v1 (${ROLE_CONTRACT_V1}): один объект с полями ok (да/нет), ` +
  `output (текст для владельца), artifacts (список ссылок), error (строка или null), ` +
  `next_hint (строка или null), needs_human (да/нет). Старый вид ok:/output: тоже принимается.`;