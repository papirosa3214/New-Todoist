// Telegram: длинный ответ частями и rich-сообщения (этапы 5 и 6 плана
// note://a2475482-36b7-4a3e-8645-70acb5cd0e37).
//
// Числа — только из документации, не «на глаз»:
//  • текст сообщения у `sendMessage` — 1–4096 символов после разбора entities
//    (https://core.telegram.org/bots/api#sendmessage, поле `text`);
//  • нарезка финального ответа идёт по 4000 символам — это 4096 минус запас
//    на префикс «(10/10) » и закрывающее ограждение кода, чтобы часть не
//    выбилась за лимит после разбора entities. Ровно поэтому ответ в 12 000
//    символов — три части (критерий приёмки 7), а не четыре;
//  • пауза между частями — 400 мс (диапазон 300–500 мс из плана этапа 5).
//    Отдельного документированного лимита «частота sendMessage в один чат» в
//    Bot API нет: превышение приходит ответом 429 с `retry_after`, и его уже
//    соблюдает retry-политика outbox (settleTelegramDelivery).
//  • `sendRichMessage` появился в Bot API 10.1 и проверен вживую 06.11.2026
//    (шаг facts_qa): форма `rich_message: {html: ...}` доставляется, шапка
//    таблицы разбирается как заголовок; блочная форма `cells` отвечает
//    400 «Can't find field cells». Поэтому конвертер отдаёт html.
import type { StructuredRoleEnvelopeV1 } from "./roleContractV1.js";

/** Лимит `sendMessage.text` — 1–4096 (Bot API). */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Рабочий размер части финального ответа.
 *
 * Задача этапа называла 3800, но при 3800 ответ в 12 000 символов даёт
 * четыре части, а критерий приёмки 7 требует три. 4000 — это 4096 минус
 * запас 96 символов на префикс «(10/10) » (8) и на закрывающее ограждение
 * кода, которое дописывается в конец части (4). Черновик (`STREAM_MAX`)
 * остаётся 3800: там в одном сообщении едет весь ответ, а не часть. */
export const TELEGRAM_PART_LIMIT = 4000;
/** Потолок частей одного ответа: 10 частей × 4000 = ~40 000 символов.
 *  Bot API ограничивает длину сообщения (4096), но не число сообщений;
 *  ответ длиннее — уже ошибка ответа, а не транспортная задача. */
export const TELEGRAM_MAX_PARTS = 10;
/** Пауза между частями одной доставки, мс (диапазон 300–500 из плана). */
export const TELEGRAM_PART_PAUSE_MS = 400;

/** Rich-сообщения включаются флагом `TASKFLOW_TELEGRAM_RICH`; выключены —
 *  прежний текст (критерий приёмки 8 карточки). */
export function telegramRichEnabled(): boolean {
  const value = String(process.env.TASKFLOW_TELEGRAM_RICH ?? "").trim().toLowerCase();
  return !["0", "off", "false", "no"].includes(value);
}

/**
 * Ограждения кода на границе частей: каждая часть приходит закрытой.
 *
 * Если разрез попал внутрь блока кода, часть начинается с открывающего и
 * заканчивается закрывающим ```` ``` ```` — иначе Telegram покажет остаток
 * ответа сырым текстом, а незакрытый блок «съест» все следующие части.
 */
function balanceFences(parts: string[]): string[] {
  let open = 0;
  return parts.map((part) => {
    const fences = (part.match(/^```/gm) ?? []).length;
    let body = open === 1 ? "```\n" + part : part;
    const parity = (fences + open) % 2;
    if (parity === 1) body += "\n```";
    open = (open + fences) % 2;
    return body;
  });
}

function cutByBoundaries(text: string, limit: number): string[] {
  const chunks: string[] = [];
  // Число частей считается один раз от целого текста: пересчёт «по остатку»
  // копит недоборы на границах и рождает лишнюю часть-огрызок.
  const count = Math.max(1, Math.ceil(text.length / limit));
  let rest = text;
  while (rest.length > limit) {
    const remaining = Math.max(1, count - chunks.length);
    const target = Math.min(limit, Math.ceil(rest.length / remaining));
    // Ближайшая граница не дальше цели: абзац → строка → слово. Окна «не
    // дальше 200 символов» нет — оно и съедало запас, из-за которого ответ в
    // 12 000 символов выходил в четыре части вместо трёх.
    const paragraph = rest.lastIndexOf("\n\n", target);
    const line = rest.lastIndexOf("\n", target);
    const word = rest.lastIndexOf(" ", target);
    let cut = Math.max(paragraph, line, word);
    let skip = cut === paragraph ? 2 : 1;
    // Граница слишком далеко назад — режем жёстко, иначе часть выйдет короче половины.
    if (cut < target / 2) { cut = target; skip = 0; }
    const body = rest.slice(0, cut);
    if (body.trim()) chunks.push(body.trimEnd());
    rest = rest.slice(cut + skip);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

/**
 * `splitTelegramText` — ответ на части «(i/n) » с номером только при n>1.
 *
 * Нумерация считается до отправки, поэтому `n` известно заранее: сначала
 * нарезка под полный лимит, затем пересчёт ширины префикса «(n/n) » и
 * повторная нарезка, если частей стало больше. Цикл ограничен: ширина
 * префикса почти не меняется от подрезки.
 */
export function splitTelegramText(text: string, limit = TELEGRAM_PART_LIMIT): string[] {
  const source = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!source) return [];
  if (source.length <= limit) return [source];
  // Префикс «(10/10) » — 8 символов, дальше он не растёт; часть вместе с
  // префиксом обязана влезть в 4096 (лимит `sendMessage.text`).
  const reserve = `(${TELEGRAM_MAX_PARTS}/${TELEGRAM_MAX_PARTS}) `.length;
  const bodyLimit = Math.max(200, TELEGRAM_TEXT_LIMIT - reserve);
  const parts = balanceFences(cutByBoundaries(source, Math.min(limit + reserve, bodyLimit)));
  if (parts.length < 2) return parts;
  // Префикс номера не должен попасть внутрь ограждения кода: он встаёт
  // отдельной строкой сверху, а блок начинается со следующей.
  return parts.map((part, index) => {
    const label = `(${index + 1}/${parts.length})`;
    return part.startsWith("```") ? `${label}\n${part}` : `${label} ${part}`;
  });
}

/**
 * Таблицы Markdown → моноширинный блок: так `|`-таблица не превращается в
 * кашу из палок, когда rich-режим выключен (DoD этапа 6).
 */
export function normalizeTelegramTables(text: string): string {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let table: string[] = [];
  const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
  const isDivider = (line: string) => /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
  const flush = () => {
    if (!table.length) return;
    const rows = table.filter((line) => !isDivider(line)).map((line) => {
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      return cells;
    });
    const width = Math.max(...rows.map((row) => row.length));
    const sizes = Array.from({ length: width }, (_unused, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
    const formatted = rows.map((row) => row.map((cell, column) => cell.padEnd(sizes[column])).join("  ").trimEnd());
    out.push("```", ...formatted, "```");
    table = [];
  };
  for (const line of lines) {
    if (isRow(line) || (table.length && isDivider(line))) { table.push(line); continue; }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n");
}

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const REPORT_SECTION_TITLES: Record<string, string> = {
  result: "Результат",
  work: "Что сделано",
  checks: "Проверки",
  limitations: "Ограничения",
  materials: "Материалы",
};

function tableHtml(block: Record<string, unknown>): string {
  const columns = Array.isArray(block.columns) ? block.columns : [];
  const rows = Array.isArray(block.rows) ? block.rows : [];
  const line = (cells: unknown[], header: boolean) =>
    "<tr>" + cells.map((cell) => `<td>${header ? "<b>" : ""}${escapeHtml(cell)}${header ? "</b>" : ""}</td>`).join("") + "</tr>";
  if (!columns.length) return rows.map((row) => escapeHtml(Array.isArray(row) ? row.join(" — ") : row)).join("<br>");
  return [
    block.title ? `<b>${escapeHtml(block.title)}</b><br>` : "",
    "<table>",
    line(columns, true),
    ...rows.map((row) => line(Array.isArray(row) ? row : [], false)),
    "</table>",
  ].filter(Boolean).join("");
}

function blocksHtml(blocks: Array<Record<string, unknown>>): string {
  const chunks: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    switch (String(block.type ?? "")) {
      case "text": chunks.push(escapeHtml(block.text)); break;
      case "heading": chunks.push(`<b>${escapeHtml(block.text)}</b>`); break;
      case "list": {
        const items = Array.isArray(block.items) ? block.items : [];
        chunks.push(items.map((item) => `• ${escapeHtml(item)}`).join("<br>"));
        break;
      }
      case "table": chunks.push(tableHtml(block)); break;
      case "status": chunks.push(`<b>${escapeHtml(block.title)}</b>${block.text ? ": " + escapeHtml(block.text) : ""}`); break;
      case "progress": chunks.push(`${escapeHtml(block.title)}: ${escapeHtml(block.current)} из ${escapeHtml(block.total)}`); break;
      case "link": chunks.push(`${escapeHtml(block.title)}: ${escapeHtml(block.url)}`); break;
      case "command": chunks.push(`<b>${escapeHtml(block.title ?? "Команда")}</b><br><code>${escapeHtml(block.command)}</code>`); break;
      case "report": {
        const sections = block.sections && typeof block.sections === "object" ? block.sections as Record<string, unknown> : null;
        if (!sections) break;
        for (const key of Object.keys(REPORT_SECTION_TITLES)) {
          const value = sections[key];
          if (!Array.isArray(value) || !value.length) continue;
          const inner = value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
          // `checks` в отчёте — пары «что проверили → результат», а не блоки.
          const rows = value.filter((item) => item && typeof item === "object" && !(item as Record<string, unknown>).type);
          chunks.push(`<b>${REPORT_SECTION_TITLES[key]}</b>`);
          if (inner.length) chunks.push(blocksHtml(inner));
          if (rows.length) chunks.push(rows.map((row) => escapeHtml((row as Record<string, unknown>).label) + " — " + escapeHtml((row as Record<string, unknown>).status)).join("<br>"));
          if (!inner.length && !rows.length) chunks.push(value.map((item) => escapeHtml(item)).join("<br>"));
        }
        break;
      }
      default: break;
    }
  }
  return chunks.filter((chunk) => chunk !== "").join("<br><br>");
}

/** Текст конверта без разметки — основа plain-варианта и отката. */
export function envelopePlainText(envelope: StructuredRoleEnvelopeV1 | null): string {
  if (!envelope) return "";
  const blocks = Array.isArray(envelope.output) ? envelope.output.filter((block): block is Record<string, unknown> => block !== null && typeof block === "object") : [];
  return blocks.map((block) => {
    switch (String(block.type ?? "")) {
      case "text": return String(block.text ?? "");
      case "heading": return String(block.text ?? "");
      case "list": return (Array.isArray(block.items) ? block.items : []).map((item) => "• " + String(item)).join("\n");
      case "table": {
        const columns = Array.isArray(block.columns) ? block.columns.map(String) : [];
        const rows = Array.isArray(block.rows) ? block.rows : [];
        if (!columns.length) return rows.map((row) => Array.isArray(row) ? row.join(" | ") : String(row)).join("\n");
        return [block.title ? String(block.title) : "", "| " + columns.join(" | ") + " |", "|" + columns.map(() => " --- |").join(""),
          ...rows.map((row) => "| " + (Array.isArray(row) ? row.map((cell) => String(cell ?? "")).join(" | ") : "") + " |")].filter(Boolean).join("\n");
      }
      case "status": return String(block.title ?? "") + (block.text ? ": " + String(block.text) : "");
      case "progress": return `${String(block.title ?? "")}: ${String(block.current ?? "")} из ${String(block.total ?? "")}`;
      case "link": return `[${String(block.title ?? block.url ?? "")}](${String(block.url ?? "")})`;
      case "report": {
        const sections = block.sections && typeof block.sections === "object" ? block.sections as Record<string, unknown> : null;
        if (!sections) return "";
        return Object.keys(REPORT_SECTION_TITLES).flatMap((key) => {
          const value = sections[key];
          if (!Array.isArray(value) || !value.length) return [];
          const lines = value.map((item) => item && typeof item === "object"
            ? (item as Record<string, unknown>).label ? `${String((item as Record<string, unknown>).label)} — ${String((item as Record<string, unknown>).status ?? "")}` : envelopePlainTextBlock(item as Record<string, unknown>)
            : String(item));
          return [`${REPORT_SECTION_TITLES[key]}:`, ...lines];
        }).filter(Boolean).join("\n");
      }
      default: return "";
    }
  }).filter(Boolean).join("\n\n");
}

function envelopePlainTextBlock(block: Record<string, unknown>): string {
  const text = block.text ?? block.title ?? block.label;
  if (text !== undefined) return String(text);
  const items = block.items;
  return Array.isArray(items) ? items.map(String).join(", ") : "";
}

/**
 * `telegramRichHtml` — html для `sendRichMessage` из конверта ответа роли.
 * `null` означает «rich не нужен»: флаг выключен, конверта нет или разметки
 * в нём нет вовсе — тогда уходит прежний текст.
 */
export function telegramRichHtml(envelope: StructuredRoleEnvelopeV1 | null, limit = TELEGRAM_PART_LIMIT): string | null {
  if (!telegramRichEnabled() || !envelope) return null;
  const blocks = Array.isArray(envelope.output) ? envelope.output.filter((block): block is Record<string, unknown> => block !== null && typeof block === "object") : [];
  const richTypes = new Set(["table", "report", "heading", "list"]);
  if (!blocks.some((block) => richTypes.has(String(block.type ?? "")))) return null;
  const html = blocksHtml(blocks).trim();
  if (!html) return null;
  // Длинный rich-ответ не режем: части считаются по plain-тексту, а rich-путь
  // уходит одним сообщением (одно намерение — один delivery_id).
  if (html.length > limit) return null;
  return html;
}
