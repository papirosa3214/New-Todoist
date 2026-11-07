// Ответ в чате готовыми блоками — клиент только рисует (26.10.2026).
//
// Раньше каждый клиент сам раскладывал текст ответа: iOS — ChatRichContent +
// MarkdownParser, веб — свои разборы. Теперь раскладывает сервер, один раз,
// тем же правилом, что было в iOS (ChatRichContent.splitUncached):
//   • doc — обычный текст, уже разобранный в документ TipTap (тот же формат,
//     что у заметок; iOS его декодирует в NoteBlock);
//   • table — таблица GitHub-вида, ячейки — строки TipTap;
//   • widget — блок ```widget / ```tf-widget (JSON карточки);
//   • structured_json — блок ```tf-json;
//   • html — блок ```html / ```artifact;
//   • pending / structured_json_streaming — такой блок ещё дописывается.
import { markdownToTiptap, parseInline, type Node } from "./markdownToTiptap.js";

import { componentOfWidget, componentsOfStructured, type AgentComponent } from "./agentComponents.js";

export type TableAlignment = "leading" | "center" | "trailing";
export type PendingKind = "widget" | "structured_json" | "html";

export type ChatBlock =
  | { type: "doc"; doc: Node; chars: number }
  | { type: "table"; header: Node[][]; align: TableAlignment[]; rows: Node[][][]; chars: number }
  | { type: "widget"; json: string; component?: AgentComponent }
  | { type: "structured_json"; json: string; components?: AgentComponent[] }
  | { type: "structured_json_streaming"; json: string }
  | { type: "html"; html: string }
  | { type: "pending"; kind: PendingKind };

const HTML = new Set(["html", "artifact"]);
const WIDGET = new Set(["widget", "tf-widget"]);
const STRUCTURED = new Set(["tf-json"]);

/** Ячейки строки таблицы: без крайних `|`, с учётом `\|`. */
export function tableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  let escaped = false;
  for (const ch of t) {
    if (escaped) {
      cur += ch;
      escaped = false;
    } else if (ch === "\\") escaped = true;
    else if (ch === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) return false;
  return t.startsWith("|") || tableCells(t).length > 1;
}

function separatorAlignments(line: string): TableAlignment[] | null {
  if (!line.includes("-")) return null;
  const out: TableAlignment[] = [];
  for (const part of tableCells(line)) {
    const p = part.replace(/ /g, "");
    if (!p || !/^[-:]+$/.test(p) || !p.includes("-")) return null;
    const left = p.startsWith(":");
    const right = p.endsWith(":");
    out.push(left && right ? "center" : right ? "trailing" : "leading");
  }
  return out.length ? out : null;
}

function docOf(markdown: string): ChatBlock {
  let doc: Node;
  try {
    doc = JSON.parse(markdownToTiptap(markdown)) as Node;
  } catch {
    doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: markdown }] }] };
  }
  // chars — сколько символов текста в куске: клиент проявляет хвост идущего
  // ответа по всему тексту, как раньше (ChatRichContent.characterCount).
  return { type: "doc", doc, chars: markdown.length + 1 };
}

/** Блок с исходным куском текста — для живого хода: клиент проявляет
 *  исходный текст по словам и рисует блок, обрезанный по открытой части. */
function parsedJSON(json: string): unknown {
  try { return JSON.parse(json); } catch { return null; }
}

export type SourcedChatBlock = ChatBlock & { source: string };

/** Разложить текст ответа на блоки. streaming — ответ ещё печатается. */
export function chatBlocks(text: string, streaming = false): ChatBlock[] {
  return sourcedChatBlocks(text, streaming).map(({ source: _source, ...block }) => block as ChatBlock);
}

/** То же, но у каждого блока — его исходный кусок текста. */
export function sourcedChatBlocks(text: string, streaming = false): SourcedChatBlock[] {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: SourcedChatBlock[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const joined = buffer.join("\n");
    if (joined.trim()) blocks.push({ ...docOf(joined), source: joined });
    buffer = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim().toLowerCase();
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith("```")) j++;
      const closed = j < lines.length;
      const body = lines.slice(i + 1, Math.min(j, lines.length)).join("\n");
      const special: PendingKind | null = HTML.has(lang)
        ? "html"
        : WIDGET.has(lang)
          ? "widget"
          : STRUCTURED.has(lang)
            ? "structured_json"
            : null;
      if (special) {
        flush();
        const source = lines.slice(i, closed ? j + 1 : lines.length).join("\n");
        if (!closed && streaming) {
          blocks.push(special === "structured_json" ? { type: "structured_json_streaming", json: body, source } : { type: "pending", kind: special, source });
        } else if (special === "html") blocks.push({ type: "html", html: body, source });
        else if (special === "widget") {
          const json = jsonWithTextBlocks(body);
          const component = componentOfWidget(parsedJSON(json));
          blocks.push({ type: "widget", json, ...(component ? { component } : {}), source });
        } else {
          const json = jsonWithTextBlocks(body);
          const components = componentsOfStructured(parsedJSON(json));
          blocks.push({ type: "structured_json", json, ...(components ? { components } : {}), source });
        }
        i = closed ? j + 1 : lines.length;
        continue;
      }
      // Обычный код — целиком в текст, таблицы внутри не ищем.
      const end = closed ? j : lines.length - 1;
      buffer.push(...lines.slice(i, end + 1));
      i = end + 1;
      continue;
    }

    if (i + 1 < lines.length && isTableRow(line)) {
      const align = separatorAlignments(lines[i + 1]);
      const header = tableCells(line);
      if (align && header.length === align.length) {
        flush();
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && isTableRow(lines[j])) {
          let row = tableCells(lines[j]);
          if (row.length < header.length) row = [...row, ...Array(header.length - row.length).fill("")];
          rows.push(row.slice(0, header.length));
          j++;
        }
        const chars = [...header, ...rows.flat()].reduce((n, c) => n + c.length, 0);
        blocks.push({ type: "table", header: header.map(parseInline), align, rows: rows.map((r) => r.map(parseInline)), chars, source: lines.slice(i, j).join("\n") });
        i = j;
        continue;
      }
    }

    buffer.push(line);
    i++;
  }
  flush();
  return blocks;
}

/** Кэш разложения готовых сообщений: лента отдаётся часто, текст не меняется. */
const cache = new Map<string, ChatBlock[]>();
const CACHE_LIMIT = 500;

export function chatBlocksCached(text: string): ChatBlock[] {
  const hit = cache.get(text);
  if (hit) return hit;
  const blocks = chatBlocks(text, false);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(text, blocks);
  return blocks;
}


/**
 * Добавить готовые блоки к размеченному тексту внутри JSON: у текстового
 * блока (`type: "text"`) — `text_blocks`, у названных полей верхнего уровня
 * (`fields`) — `<поле>_blocks`. Только те поля, что клиент рисует как
 * Markdown. Исходные поля не меняются. Возвращает новую копию.
 */
export function withTextBlocks<T>(value: T, fields: string[] = []): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return walkTextBlocks(value);
  const out = walkTextBlocks(value) as Record<string, unknown>;
  const src = value as Record<string, unknown>;
  for (const field of fields) {
    const v = src[field];
    if (typeof v === "string" && v.trim()) out[`${field}_blocks`] = chatBlocksCached(v);
  }
  return out as T;
}

/** Текстовые блоки (`type: "text"`) на любой глубине. */
function walkTextBlocks<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => walkTextBlocks(v)) as T;
  if (!value || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(src)) out[key] = walkTextBlocks(v);
  if (src.type === "text" && typeof src.text === "string" && src.text) out.text_blocks = chatBlocksCached(src.text);
  return out as T;
}

/** Та же разметка внутри JSON-строки (виджет — `body`, tf-json — текстовые блоки и `output`). */
export function jsonWithTextBlocks(json: string): string {
  try {
    return JSON.stringify(withTextBlocks(JSON.parse(json), ["body", "output"]));
  } catch {
    return json;
  }
}

/**
 * Текст роли для показа владельцу (перенос `AgentTextSanitizer` из iOS,
 * 26.10.2026): без служебного префикса «changes_requested:» и с понятным
 * названием вместо имени инструмента. Сырой текст не меняется — на префиксе
 * держится детект «вернуть на доработку».
 */
export function ownerText(text: string): string {
  let s = text;
  const at = s.indexOf("changes_requested:");
  if (at >= 0) s = s.slice(at + "changes_requested:".length).replace(/^[ \t]+|[ \t]+$/g, "");
  return s.split("taskflow_plan_request").join("команда добавить слот в план");
}

/** Готовые блоки текста роли для владельца; пустой текст — null. */
export function ownerBlocks(text: string | null | undefined): ChatBlock[] | null {
  return text && text.trim() ? chatBlocksCached(ownerText(text)) : null;
}

/** Комментарий задачи с готовыми блоками текста. */
export function commentWithBlocks<T extends { text?: unknown }>(comment: T): T & { text_blocks: ChatBlock[] | null } {
  return { ...comment, text_blocks: typeof comment.text === "string" && comment.text.trim() ? chatBlocksCached(comment.text) : null };
}

/** Рекомендация подготовки задачи: вопрос и результаты направлений — с блоками. */
export function preparationWithBlocks(result: any): any {
  if (!result || typeof result !== "object") return result;
  const out = withTextBlocks(result, ["question"]) as any;
  const proposal = result.card?.preparation;
  if (proposal && typeof proposal === "object") {
    const enriched = withTextBlocks(proposal, ["question"]) as any;
    if (Array.isArray(proposal.workstreams)) enriched.workstreams = proposal.workstreams.map((w: any) => withTextBlocks(w, ["result"]));
    out.card = { ...out.card, preparation: enriched };
  }
  return out;
}

/** Недельная сводка: приветствие и пункты списков — с готовыми блоками. */
export function weeklySummaryWithBlocks<T>(summary: T): T {
  if (!summary || typeof summary !== "object") return summary;
  const s = summary as Record<string, unknown>;
  const out: Record<string, unknown> = { ...s };
  if (typeof s.greeting === "string" && s.greeting.trim()) out.greeting_blocks = chatBlocksCached(s.greeting);
  for (const key of ["accomplishments", "missed_or_overdue", "next_week_focus"]) {
    const list = s[key];
    if (Array.isArray(list)) out[`${key}_blocks`] = list.map((item) => (typeof item === "string" ? chatBlocksCached(item) : []));
  }
  return out as T;
}

/** Reading and editing share server-prepared documents; clients never parse source text. */
export function taskTextWithBlocks<T extends { title?: unknown; description?: unknown }>(task: T) {
  const title = typeof task.title === "string" ? task.title : "";
  const description = typeof task.description === "string" ? task.description : "";
  return {
    ...task,
    title_document: JSON.parse(markdownToTiptap(title)),
    description_document: JSON.parse(markdownToTiptap(description)),
    description_blocks: chatBlocksCached(description),
  };
}
