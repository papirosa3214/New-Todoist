// ═══════════ Markdown → TipTap JSON ═══════════
//
// 26.08.2026. Обратный конвертер к tiptapToMarkdown: нужен, чтобы АГЕНТЫ
// могли писать документацию проекта. Агент говорит на markdown, а заметки
// хранятся деревом TipTap — без этой конвертации агент не может создать
// заметку, читаемую в приложении.
//
// ═══ Почему не парсер markdown из npm ═══
//
// Полноценные (remark/marked) тянут зависимости и всё равно требуют слоя
// перевода в узлы TipTap. Здесь поддержано ровно то подмножество, которое
// умеет обратный конвертер и рисует редактор: заголовки, списки (включая
// нумерованные и чек-боксы), цитаты, блоки кода, горизонтальная черта,
// таблицы GFM, инлайн-разметка. Всё, что сложнее, кладётся абзацем как
// есть — текст не теряется, просто не размечается.
//
// Таблицы добавлены 08.09.2026: до этого каждая строка «| a | b |» ложилась
// отдельным абзацем, и в заметке вместо сетки были палки.
//
// ═══ Симметрия ═══
//
// tiptapToMarkdown ↔ markdownToTiptap должны переживать круг: то, что
// экспортировали, можно импортировать обратно без потерь. Тесты на это
// лежат рядом с клиентской версией конвертера.

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

/** Инлайн-разметка: **жирный**, *курсив*, `код`, ==маркер==, [ссылка](url). */
function parseInline(src: string): Node[] {
  const out: Node[] = [];
  // Порядок важен: код первым — внутри него разметка не действует.
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(==[^=]+==)|(\*[^*]+\*)|(_[^_]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)]+\))/;
  let rest = src;

  while (rest.length > 0) {
    const m = re.exec(rest);
    if (!m || m.index === undefined) {
      if (rest) out.push({ type: "text", text: unescapeMd(rest) });
      break;
    }
    if (m.index > 0) {
      out.push({ type: "text", text: unescapeMd(rest.slice(0, m.index)) });
    }
    const tok = m[0];

    if (tok.startsWith("`")) {
      // Внутри инлайн-кода экранирование markdown не действует.
      out.push({
        type: "text",
        text: tok.slice(1, -1),
        marks: [{ type: "code" }],
      });
    } else if (tok.startsWith("**")) {
      out.push({
        type: "text",
        text: unescapeMd(tok.slice(2, -2)),
        marks: [{ type: "bold" }],
      });
    } else if (tok.startsWith("==")) {
      out.push({
        type: "text",
        text: unescapeMd(tok.slice(2, -2)),
        marks: [{ type: "highlight" }],
      });
    } else if (tok.startsWith("~~")) {
      out.push({
        type: "text",
        text: unescapeMd(tok.slice(2, -2)),
        marks: [{ type: "strike" }],
      });
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      out.push({
        type: "text",
        text: unescapeMd(tok.slice(1, -1)),
        marks: [{ type: "italic" }],
      });
    } else {
      // [текст](ссылка)
      const cut = tok.indexOf("](");
      const label = tok.slice(1, cut);
      const href = tok.slice(cut + 2, -1);
      out.push({
        type: "text",
        text: unescapeMd(label),
        marks: [{ type: "link", attrs: { href } }],
      });
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out.length > 0 ? out : [];
}

/** Снимает экранирование, которое ставил tiptapToMarkdown.
 *
 *  Набор шире, чем в escapeMd, намеренно: файлы, выгруженные ДО 26.08.2026,
 *  несут экранированные точки и дефисы, и читать их надо по-старому. */
function unescapeMd(s: string): string {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!>~=])/g, "$1");
}

/** Абзац (или пустой абзац, если текста нет). */
function paragraph(text: string): Node {
  const content = parseInline(text);
  return content.length > 0
    ? { type: "paragraph", content }
    : { type: "paragraph" };
}

export function markdownToTiptap(md: string): string {
  const lines = (md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const content: Node[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Пустая строка — разделитель блоков, отдельного узла не даёт.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Блок кода ```lang
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // закрывающий забор
      content.push({
        type: "codeBlock",
        attrs: { language: lang },
        content: body.length ? [{ type: "text", text: body.join("\n") }] : [],
      });
      continue;
    }

    // Горизонтальная черта
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      content.push({ type: "horizontalRule" });
      i++;
      continue;
    }

    // Заголовок
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      content.push({
        type: "heading",
        attrs: { level: h[1].length },
        content: parseInline(h[2]),
      });
      i++;
      continue;
    }

    // Цитата — собираем подряд идущие строки
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      content.push({
        type: "blockquote",
        content: body.filter((l) => l.trim()).map((l) => paragraph(l)),
      });
      continue;
    }

    // Таблица GFM: строка-шапка, следом строка-разделитель.
    if (isTableRow(line) && isTableDivider(lines[i + 1] ?? "")) {
      const [node, next] = parseTable(lines, i);
      content.push(node);
      i = next;
      continue;
    }

    // Списки (маркированный / нумерованный / чек-лист), с вложенностью
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const [node, next] = parseList(lines, i);
      content.push(node);
      i = next;
      continue;
    }

    // Обычный абзац
    content.push(paragraph(line));
    i++;
  }

  return JSON.stringify({
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  });
}

/**
 * Разбирает список, начиная со строки `start`.
 *
 * Вложенность считается по отступу: любая строка с отступом больше
 * текущего уходит в подсписок последнего пункта. Возвращает узел и номер
 * первой строки ПОСЛЕ списка.
 */
function parseList(lines: string[], start: number): [Node, number] {
  const first = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[start]);
  if (!first) return [paragraph(lines[start]), start + 1];

  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  // Чек-лист — маркированный список, у которого пункты начинаются с [ ]/[x].
  const isTask = /^\[[ xX]\]\s/.test(first[3]);

  const items: Node[] = [];
  let i = start;

  while (i < lines.length) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
    if (!m) break;
    const curIndent = m[1].length;
    if (curIndent < indent) break; // список закончился
    if (curIndent > indent) {
      // Вложенный список — прицепляем к последнему пункту.
      const [child, next] = parseList(lines, i);
      const last = items[items.length - 1];
      if (last) (last.content ??= []).push(child);
      i = next;
      continue;
    }

    let text = m[3];
    const itemNode: Node = { type: isTask ? "taskItem" : "listItem" };
    if (isTask) {
      const done = /^\[[xX]\]\s/.test(text);
      itemNode.attrs = { checked: done };
      text = text.replace(/^\[[ xX]\]\s*/, "");
    }
    itemNode.content = [paragraph(text)];
    items.push(itemNode);
    i++;
  }

  const type = isTask ? "taskList" : ordered ? "orderedList" : "bulletList";
  const node: Node = { type, content: items };
  // Нумерация может начинаться не с единицы — сохраняем.
  if (ordered) {
    const startNum = parseInt(first[2], 10);
    if (startNum !== 1) node.attrs = { start: startNum };
  }
  return [node, i];
}

/** Строка таблицы: «| a | b |». Обе крайние палки обязательны — так
 *  строка отличается от абзаца, где палка встречается как обычный знак. */
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

/** Разделитель под шапкой: «|---|:--:|». Без него блок таблицей не
 *  считается — это и есть признак, по которому GFM отличает её от текста. */
function isTableDivider(line: string): boolean {
  return /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
}

/** Ячейки строки. Палка внутри текста экранируется («\|») и здесь
 *  возвращается обратно — иначе ячейка разъезжается на две. */
function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (body[i] === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += body[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** Ячейка таблицы. attrs — те же, что ставит редактор: без них ProseMirror
 *  достраивает их сам, но документ из API и документ из редактора должны
 *  выглядеть одинаково. */
function tableCell(type: "tableHeader" | "tableCell", text: string): Node {
  const inline = parseInline(text);
  return {
    type,
    attrs: { colspan: 1, rowspan: 1, colwidth: null },
    content: [
      inline.length > 0
        ? { type: "paragraph", content: inline }
        : { type: "paragraph" },
    ],
  };
}

/**
 * Разбирает таблицу, начиная со строки шапки `start`.
 *
 * Возвращает узел и номер первой строки ПОСЛЕ таблицы. Строки короче
 * шапки дополняются пустыми ячейками: ProseMirror принимает только
 * прямоугольную таблицу и на рваной падает.
 */
function parseTable(lines: string[], start: number): [Node, number] {
  const header = splitRow(lines[start]);
  const width = header.length;
  const rows: Node[] = [
    {
      type: "tableRow",
      content: header.map((c) => tableCell("tableHeader", c)),
    },
  ];

  let i = start + 2; // пропускаем шапку и разделитель
  while (
    i < lines.length &&
    isTableRow(lines[i]) &&
    !isTableDivider(lines[i])
  ) {
    const cells = splitRow(lines[i]);
    while (cells.length < width) cells.push("");
    rows.push({
      type: "tableRow",
      content: cells.slice(0, width).map((c) => tableCell("tableCell", c)),
    });
    i++;
  }

  return [{ type: "table", content: rows }, i];
}

/** Первая значимая строка — ею подписывается заметка в списке. */
export function deriveTitleFromMarkdown(md: string): string {
  // Содержимое блока кода пропускаем ЦЕЛИКОМ, а не только строку-забор:
  // иначе заголовком заметки становилась первая строка кода.
  let inFence = false;
  for (const raw of (md ?? "").split("\n")) {
    if (/^```/.test(raw.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = raw
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .trim();
    if (line && !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      return unescapeMd(line).slice(0, 120);
    }
  }
  return "";
}
