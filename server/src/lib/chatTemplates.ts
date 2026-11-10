/**
 * Серверные шаблоны блоков чата: модель присылает ДАННЫЕ, сервер отдаёт
 * готовый HTML (таблица, график, схема).
 *
 * Зачем. Сегодня `table`/`chart`/`diagram` рисует клиент (`ChatWidgetView`,
 * Swift Charts), поэтому каждый новый вид блока — правка Swift, пересборка и
 * установка приложения. Здесь сервер подставляет числа в свой шаблон и кладёт
 * результат в блок полем `server_html`; клиент, который вид знает, продолжает
 * рисовать нативно, а незнакомый или тяжёлый — показывает как HTML.
 *
 * Границы (важно):
 *   - шаблон рендерит только `table`, `chart`, `diagram`; остальные типы
 *     возвращают null и не меняются;
 *   - `server_html` кладёт ИСКЛЮЧИТЕЛЬНО сервер: в `STRUCTURED_BLOCK_FIELDS`
 *     поле не входит, поэтому ответ модели с `server_html` по-прежнему не
 *     проходит валидатор («поле не разрешено»). Роль не может протащить свой
 *     HTML в обход проверки;
 *   - разметка самодостаточна: ни скриптов, ни внешних картинок и шрифтов,
 *     стили — в собственном `<style>` с префиксом `tfh-`, светлая и тёмная тема
 *     через `prefers-color-scheme`. Переносить стили клиента сюда нельзя:
 *     блок должен выглядеть одинаково и в чате iOS, и в браузере;
 *   - весь текст модели экранируется и попадает ТОЛЬКО в текстовые узлы.
 *     Ни одно значение не вставляется в атрибут, поэтому подстановка разметки
 *     через данные невозможна даже без CSP;
 *   - объём ограничен `SERVER_HTML_MAX` (тот же предел, что у блока `html` в
 *     контракте). Не влезло — поля нет, клиент рисует нативно.
 *
 * Версия шаблонов входит в разметку (`data-tpl`), чтобы по сохранённому
 * сообщению было видно, каким шаблоном оно нарисовано.
 */

/** Версия набора шаблонов: меняется, когда меняется вид разметки. */
export const CHAT_TEMPLATES_VERSION = 1;

/** Предел готовой разметки одного блока — как у блока `html` в контракте. */
export const SERVER_HTML_MAX = 60000;

/** Поле, которым сервер помечает блок. Модель его прислать не может. */
export const SERVER_HTML_FIELD = "server_html";

/** Состояния схемы: те же цвета, что в приложении (DESIGN.md §2). */
const STATE_COLOR: Record<string, string> = {
  done: "#15937E",
  in_progress: "#35B8A3",
  blocked: "#FF9A14",
  failed: "#C0392B",
  queued: "#6E7681",
  skipped: "#A6A6A6",
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Экранирование текста модели. Применяется к любому значению без исключений. */
function esc(value: unknown, max = 1000): string {
  return String(value ?? "").slice(0, max).replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** Число из данных модели: всё, что не конечное число, читается как 0. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rows(value: unknown, max: number): unknown[][] {
  return Array.isArray(value) ? value.slice(0, max).map((row) => (Array.isArray(row) ? row : [])) : [];
}

/** Общая обвязка блока: заголовок, стили, версия шаблона. */
function frame(kind: string, title: string, unit: string, body: string): string {
  const unitHtml = unit ? `<span class="tfh-unit">${unit}</span>` : "";
  return `<div class="tfh tfh-${kind}" data-tpl="${CHAT_TEMPLATES_VERSION}">` +
    `<div class="tfh-head"><span class="tfh-title">${title}</span>${unitHtml}</div>` +
    `${body}</div>${STYLE}`;
}

/**
 * Стили шаблонов. Один общий кусок на любой блок: префикс `tfh-` не даёт
 * зацепить стили клиента, `currentColor` и `prefers-color-scheme` — работать в
 * светлой и тёмной теме без отдельных наборов цветов.
 */
const STYLE = `<style>
.tfh{font:14px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
color:inherit;border:1px solid rgba(128,128,128,.28);border-radius:12px;padding:10px;margin:0 0 8px}
.tfh-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px}
.tfh-title{font-size:12.5px;font-weight:600}
.tfh-unit{font-size:11px;opacity:.55}
.tfh table{border-collapse:collapse;width:100%;font-size:12.5px}
.tfh th{text-align:left;font-weight:500;font-size:11.5px;opacity:.6;
border-bottom:1px solid rgba(128,128,128,.35);padding:3px 10px 5px 0;white-space:nowrap}
.tfh td{padding:4px 10px 4px 0;border-bottom:.5px solid rgba(128,128,128,.22)}
.tfh tr:last-child td{border-bottom:0}
.tfh svg{display:block;width:100%;height:auto}
.tfh .tfh-ax{font-size:8px;fill:currentColor;fill-opacity:.45}
.tfh .tfh-val{font-size:9px;font-weight:700;fill:#15937E}
.tfh .tfh-node{font-size:10.5px;font-weight:600}
</style>`;

// ── Таблица ───────────────────────────────────────────────────────────────
export function renderTableHtml(block: Record<string, unknown>): string | null {
  const columns = Array.isArray(block.columns) ? block.columns.slice(0, 12) : [];
  if (!columns.length) return null;
  const data = rows(block.rows, 100);
  const head = columns.map((column) => `<th>${esc(column, 200)}</th>`).join("");
  const body = data.map((row) => "<tr>" +
    columns.map((_, index) => `<td>${esc(row[index], 500)}</td>`).join("") + "</tr>").join("");
  return frame("table", esc(block.title ?? "Таблица"), "",
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
}

// ── График ────────────────────────────────────────────────────────────────
const CHART_W = 320;
const CHART_H = 132;
const CHART_PAD_L = 26;
const CHART_PAD_B = 22;
const CHART_PAD_T = 14;

interface Point { label: string; value: number }

function points(block: Record<string, unknown>): Point[] {
  const raw = Array.isArray(block.points) ? block.points.slice(0, 500) : [];
  return raw.filter(isObject).map((point) => ({
    label: String(point.label ?? "").slice(0, 64),
    value: num(point.value),
  }));
}

/** Сетка и подписи оси значений — общие для обоих видов графика. */
function grid(max: number): { svg: string; plotHeight: number } {
  const plotHeight = CHART_H - CHART_PAD_T - CHART_PAD_B;
  const parts: string[] = [];
  for (let step = 0; step < 4; step += 1) {
    const y = CHART_PAD_T + (plotHeight * step) / 3;
    const value = Math.round((max * (3 - step)) / 3);
    parts.push(`<line x1="${CHART_PAD_L}" y1="${y.toFixed(1)}" x2="${CHART_W - 4}" y2="${y.toFixed(1)}"` +
      ` stroke="currentColor" stroke-opacity=".12" stroke-width="1"/>`);
    parts.push(`<text x="${CHART_PAD_L - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="tfh-ax">${value}</text>`);
  }
  return { svg: parts.join(""), plotHeight };
}

export function renderChartHtml(block: Record<string, unknown>): string | null {
  const data = points(block);
  if (!data.length) return null;
  const max = Math.max(...data.map((point) => point.value), 0) || 1;
  const { svg: gridSvg, plotHeight } = grid(max);
  const step = (CHART_W - CHART_PAD_L - 6) / data.length;
  const parts: string[] = [];

  if (block.kind === "line") {
    // Линия: точки + ломаная. Ноль значений рисуем на базовой линии, а не в воздухе.
    const coords = data.map((point, index) => {
      const x = CHART_PAD_L + step * (index + 0.5);
      const y = CHART_PAD_T + plotHeight - (plotHeight * point.value) / max;
      return { x, y, point };
    });
    parts.push(`<polyline points="${coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ")}"` +
      ` fill="none" stroke="#35B8A3" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    for (const coord of coords) {
      parts.push(`<circle cx="${coord.x.toFixed(1)}" cy="${coord.y.toFixed(1)}" r="2.6" fill="#15937E"/>`);
      parts.push(`<text x="${coord.x.toFixed(1)}" y="${(coord.y - 6).toFixed(1)}" text-anchor="middle"` +
        ` class="tfh-val">${coord.point.value}</text>`);
      parts.push(`<text x="${coord.x.toFixed(1)}" y="${CHART_H - CHART_PAD_B + 14}" text-anchor="middle"` +
        ` class="tfh-ax">${esc(coord.point.label, 64)}</text>`);
    }
  } else {
    const width = step * 0.52;
    for (const [index, point] of data.entries()) {
      const height = (plotHeight * point.value) / max;
      const x = CHART_PAD_L + step * index + (step - width) / 2;
      const y = CHART_H - CHART_PAD_B - height;
      const opacity = (0.55 + (0.45 * point.value) / max).toFixed(2);
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}"` +
        ` height="${height.toFixed(1)}" rx="3" fill="#35B8A3" fill-opacity="${opacity}"/>`);
      parts.push(`<text x="${(x + width / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle"` +
        ` class="tfh-val">${point.value}</text>`);
      parts.push(`<text x="${(x + width / 2).toFixed(1)}" y="${CHART_H - CHART_PAD_B + 14}" text-anchor="middle"` +
        ` class="tfh-ax">${esc(point.label, 64)}</text>`);
    }
  }

  return frame("chart", esc(block.title ?? "График"), esc(block.unit, 40),
    `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img">${gridSvg}${parts.join("")}</svg>`);
}

// ── Схема ─────────────────────────────────────────────────────────────────
function items(block: Record<string, unknown>): { label: string; state: string }[] {
  const raw = Array.isArray(block.items) ? block.items.slice(0, 100) : [];
  return raw.filter(isObject).map((item) => ({
    label: String(item.label ?? "").slice(0, 64),
    state: String(item.state ?? "queued"),
  }));
}

function color(state: string): string {
  return STATE_COLOR[state] ?? STATE_COLOR.queued!;
}

/** Цепочка: узлы в ряд, стрелки между ними. */
function chainSvg(data: { label: string; state: string }[]): string {
  const width = 340;
  const gap = 12;
  const node = (width - gap * (data.length - 1)) / data.length;
  const parts: string[] = [];
  for (const [index, item] of data.entries()) {
    const x = index * (node + gap);
    const fill = color(item.state);
    parts.push(`<rect x="${x.toFixed(1)}" y="14" width="${node.toFixed(1)}" height="30" rx="8"` +
      ` fill="${fill}" fill-opacity=".16" stroke="${fill}" stroke-opacity=".5"/>`);
    parts.push(`<text x="${(x + node / 2).toFixed(1)}" y="33" text-anchor="middle" class="tfh-node"` +
      ` fill="${fill}">${esc(item.label, 64)}</text>`);
    if (index < data.length - 1) {
      const from = x + node + 2;
      parts.push(`<path d="M${from.toFixed(1)} 29 h${gap - 5}" stroke="currentColor" stroke-opacity=".35"` +
        ` stroke-width="1.5" stroke-linecap="round"/>`);
      parts.push(`<path d="M${(from + gap - 6).toFixed(1)} 29 l-3 -2.6 v5.2 z" fill="currentColor" fill-opacity=".35"/>`);
    }
  }
  return `<svg viewBox="0 0 ${width} 62" role="img">${parts.join("")}</svg>`;
}

/** Лестница: узлы столбцом, слева номер шага. */
function ladderSvg(data: { label: string; state: string }[]): string {
  const rowHeight = 26;
  const height = data.length * rowHeight + 4;
  const parts: string[] = [];
  for (const [index, item] of data.entries()) {
    const y = 2 + index * rowHeight;
    const fill = color(item.state);
    parts.push(`<rect x="0" y="${y}" width="8" height="${rowHeight - 6}" rx="4" fill="${fill}" fill-opacity=".85"/>`);
    parts.push(`<text x="18" y="${y + 14}" class="tfh-node" fill="${fill}">${index + 1}. ${esc(item.label, 64)}</text>`);
  }
  return `<svg viewBox="0 0 340 ${height}" role="img">${parts.join("")}</svg>`;
}

/** Время: узлы на линии, подписи под ней. */
function timelineSvg(data: { label: string; state: string }[]): string {
  const width = 340;
  const step = width / Math.max(data.length, 1);
  const parts: string[] = [
    `<line x1="0" y1="26" x2="${width}" y2="26" stroke="currentColor" stroke-opacity=".2" stroke-width="1"/>`,
  ];
  for (const [index, item] of data.entries()) {
    const x = step * index + step / 2;
    const fill = color(item.state);
    parts.push(`<circle cx="${x.toFixed(1)}" cy="26" r="5" fill="${fill}"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="48" text-anchor="middle" class="tfh-node"` +
      ` fill="${fill}">${esc(item.label, 64)}</text>`);
  }
  return `<svg viewBox="0 0 ${width} 56" role="img">${parts.join("")}</svg>`;
}

export function renderDiagramHtml(block: Record<string, unknown>): string | null {
  const data = items(block);
  if (!data.length) return null;
  const kind = String(block.kind ?? "chain");
  const svg = kind === "ladder" ? ladderSvg(data) : kind === "timeline" ? timelineSvg(data) : chainSvg(data);
  return frame("diagram", esc(block.title ?? "Схема"), "", svg);
}

// ── Публичный вход ────────────────────────────────────────────────────────

/**
 * Разложить свободный ответ роли в блоки конверта.
 *
 * Зачем. Роль часто пишет обычный markdown вместо JSON-конверта, и тогда
 * владелец получал один блок `text` целиком: заголовки, таблицы и команды
 * внутри одного абзаца, кнопки «Запустить» нет, таблица не таблица. Здесь
 * детерминированный разбор без модели и без догадок: что в тексте лежит
 * разметкой — становится блоком, всё остальное остаётся текстом.
 *
 * Границы, которые важно не переступить:
 *   - ничего не выдумываем: блок появляется только из явной разметки
 *     (заголовок `#`, список `-`/`1.`, таблица с разделителем, чекбокс,
 *     эмодзи статуса в начале строки, ссылка отдельной строкой, фенс кода);
 *   - смысл строк не угадываем: «ждёт ответа» останется текстом, пока роль
 *     не напишет его чекбоксом или эмодзи;
 *   - порядок строк сохраняется, исходный текст не теряется: всё, что не
 *     стало блоком, остаётся текстовыми блоками в том же порядке;
 *   - пределы контракта соблюдаются при сборке (заголовок ≤1000, колонок ≤12,
 *     строк таблицы ≤100, команда ≤8000 и без ```, ссылка http(s) или note://),
 *     поэтому такой конверт проходит валидатор, а не падает на нём.
 */
export function blocksFromMarkdown(text: string): Record<string, unknown>[] {
  const source = text.replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const blocks: Record<string, unknown>[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    const joined = paragraph.join("\n").trim();
    paragraph = [];
    if (!joined) return;
    // Длинный текст режем по пределу блока, а не отбрасываем.
    for (let at = 0; at < joined.length; at += 60000) {
      blocks.push({ type: "text", text: joined.slice(at, at + 60000) });
    }
  };

  const STATUS_EMOJI: [string, string][] = [
    ["✅", "passed"], ["☑️", "passed"], ["✔️", "passed"],
    ["❌", "failed"], ["⛔", "failed"],
    ["⚠️", "blocked"], ["🚫", "blocked"],
    ["⏳", "in_progress"], ["🔄", "in_progress"],
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();

    if (!trimmed) { flush(); continue; }

    // Фенс кода: bash и оболочки — команда с кнопкой, остальное — текст как есть.
    const fence = /^```([\w+-]*)\s*$/.exec(trimmed);
    if (fence) {
      flush();
      const body: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length && !/^```/.test(lines[cursor]!.trim())) {
        body.push(lines[cursor]!);
        cursor += 1;
      }
      const code = body.join("\n").trim();
      const lang = (fence[1] ?? "").toLowerCase();
      if (code && ["bash", "sh", "shell", "zsh", "console"].includes(lang) && code.length <= 8000 && !code.includes("```")) {
        blocks.push({ type: "command", command: code });
      } else if (code) {
        // Чужой код не переписываем в команду: он остаётся текстом с фенсом.
        blocks.push({ type: "text", text: "```" + (lang ? lang + "\n" : "\n") + code + "\n```" });
      }
      index = cursor;
      continue;
    }

    // Заголовок 1–3 уровня.
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ type: "heading", text: heading[2]!.slice(0, 1000), level: heading[1]!.length });
      continue;
    }

    // Таблица: строка с `|` и следующая за ней — разделитель из дефисов.
    if (trimmed.includes("|") && index + 1 < lines.length && /^[\s|:-]*-[\s|:-]*$/.test(lines[index + 1]!.trim())) {
      const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      const columns = cells(trimmed).slice(0, 12);
      const rows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor]!.includes("|") && lines[cursor]!.trim() && rows.length < 100) {
        rows.push(cells(lines[cursor]!).slice(0, columns.length));
        cursor += 1;
      }
      flush();
      blocks.push({ type: "table", columns, rows });
      index = cursor - 1;
      continue;
    }

    // Список и чекбоксы.
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const items: string[] = [];
      let cursor = index;
      while (cursor < lines.length) {
        const current = lines[cursor]!.trim();
        const match = ordered ? /^\d+[.)]\s+(.*)$/.exec(current) : /^[-*•]\s+(.*)$/.exec(current);
        if (!match) break;
        const body = match[1]!;
        const checkbox = /^\[([ xX])\]\s*(.*)$/.exec(body);
        if (checkbox) {
          // Чекбокс — не пункт списка, а проверка: так его и показываем.
          blocks.push({
            type: "status",
            code: checkbox[1]!.trim() ? "passed" : "skipped",
            title: checkbox[2]!.slice(0, 1000),
          });
        } else if (items.length < 200) {
          items.push(body.slice(0, 1000));
        }
        cursor += 1;
      }
      if (items.length) blocks.push({ type: "list", items, ordered });
      index = cursor - 1;
      continue;
    }

    // Эмодзи статуса в начале строки.
    const emoji = STATUS_EMOJI.find(([symbol]) => trimmed.startsWith(symbol));
    if (emoji) {
      flush();
      const rest = trimmed.slice(emoji[0].length).trim();
      if (rest) blocks.push({ type: "status", code: emoji[1], title: rest.slice(0, 1000) });
      continue;
    }

    // Ссылка отдельной строкой — блоком, с ярлычком на клиенте.
    const link = /^\[([^\]]{1,300})\]\((https?:\/\/\S+|note:\/\/[\w-]+)\)$/.exec(trimmed);
    if (link) {
      flush();
      blocks.push({ type: "link", title: link[1]!, url: link[2]! });
      continue;
    }
    const bare = /^(https?:\/\/\S+|note:\/\/[\w-]+)$/.exec(trimmed);
    if (bare) {
      flush();
      blocks.push({ type: "link", title: bare[1]!.replace(/^https?:\/\//, "").slice(0, 300), url: bare[1]!.slice(0, 2048) });
      continue;
    }

    paragraph.push(line);
  }
  flush();

  // Контракт разрешает не больше 200 блоков: остаток склеиваем в один текст,
  // а не выбрасываем — ответ роли не должен терять содержимое.
  if (blocks.length > 200) {
    const head = blocks.slice(0, 199);
    const tail = blocks.slice(199).map((block) => String((block as any).text ?? (block as any).title ?? "")).join("\n").trim();
    if (tail) head.push({ type: "text", text: tail.slice(0, 60000) });
    return head;
  }
  return blocks.length ? blocks : [{ type: "text", text: source.trim().slice(0, 60000) }];
}

/**
 * Готовая разметка одного блока или null. null означает «сервер этот вид не
 * рисует» либо «не влезло в предел» — в обоих случаях клиент рисует нативно,
 * как раньше, и ничего не теряется.
 */
export function renderBlockHtml(block: unknown): string | null {
  if (!isObject(block)) return null;
  let html: string | null = null;
  switch (block.type) {
    case "table": html = renderTableHtml(block); break;
    case "chart": html = renderChartHtml(block); break;
    case "diagram": html = renderDiagramHtml(block); break;
    default: return null;
  }
  if (!html) return null;
  // Меряем байтами UTF-8, как считает предел поле `html` в контракте.
  return Buffer.byteLength(html, "utf8") > SERVER_HTML_MAX ? null : html;
}

/**
 * Разложить готовую разметку по блокам конверта. Только дополняет: сами блоки
 * не меняются, порядок сохраняется, у блока без шаблона поля просто нет.
 * Идемпотентно — повторный вызов даёт тот же результат.
 */
export function attachServerHtml<T extends { output: unknown }>(envelope: T): T {
  if (!Array.isArray(envelope.output)) return envelope;
  const output = envelope.output.map((block) => {
    const html = renderBlockHtml(block);
    return html && isObject(block) ? { ...block, [SERVER_HTML_FIELD]: html } : block;
  });
  return { ...envelope, output } as T;
}
