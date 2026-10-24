// ═══════════ TipTap JSON → Markdown ═══════════
//
// 26.08.2026, по просьбе Максима: «JSON для работы, markdown на экспорт».
// Заметки хранятся деревом TipTap (узлы: абзацы, заголовки, списки,
// чек-боксы, выделения) — это внутренний формат редактора, наружу его
// отдавать бессмысленно. Здесь дерево разворачивается в markdown, который
// открывается в Obsidian и любом другом редакторе.
//
// Обратная конвертация (markdown → TipTap) НЕ делается намеренно: это
// полноценный парсер со своими краевыми случаями, а импорта никто не
// просил. Экспорт — дорога в одну сторону.
//
// Что во что превращается:
//   heading            → #, ##, ###…
//   paragraph          → строка
//   bulletList         → «- пункт»
//   orderedList        → «1. пункт» (нумерация сквозная внутри списка)
//   taskList           → «- [ ] » / «- [x] »
//   blockquote         → «> »
//   codeBlock          → ```язык … ```
//   table              → таблица GFM (первая строка — шапка)
//   horizontalRule     → «---»
//   bold/italic/strike → **…**, *…*, ~~…~~
//   code (инлайн)      → `…`
//   highlight          → ==…== (синтаксис Obsidian)
//   link               → [текст](url)
//   hardBreak          → перенос строки
// Неизвестные узлы не роняют экспорт: из них достаётся текст детей.

interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface TiptapNode {
  type?: string;
  text?: string;
  marks?: TiptapMark[];
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
}

/** Экранирует markdown-символы в тексте, чтобы «*звёздочки*» из заметки
 *  не превратились при экспорте в форматирование.
 *
 *  Экранируем ТОЛЬКО то, что действительно меняет смысл внутри строки:
 *  \\ ` * _ [ ] ~ =. Раньше в наборе были ещё . - + # ( ) { } !, и это
 *  было ошибкой (найдено 26.08.2026 круговым прогоном): точка в конце
 *  обычного предложения превращалась в «предложение\\.», а «5 - 3» — в
 *  «5 \\- 3». Эти символы значат что-то лишь В НАЧАЛЕ строки (маркер
 *  списка, заголовок, цитата), а там текст и так рождается из своего
 *  узла — абзац не может начаться с «- », если это не список. */
function escapeMd(text: string): string {
  // = вне набора: маркер — это ДВОЙНОЙ ==текст==, а одиночный знак
  // равенства в «5 = 15» ничего не значит и экранировать его незачем.
  // Пара == соберётся обратно из своих марок при следующем чтении.
  return text.replace(/([\\`*_[\]~])/g, "\\$1");
}

/** Применяет марки TipTap к куску текста. Порядок важен: код — самый
 *  внутренний (внутри него markdown не работает), ссылка — самая
 *  внешняя. */
function applyMarks(text: string, marks: TiptapMark[] | undefined): string {
  if (!marks || marks.length === 0) return escapeMd(text);

  const has = (t: string) => marks.some((m) => m.type === t);
  // Внутри инлайн-кода экранирование не нужно и вредно.
  let out = has("code") ? `\`${text}\`` : escapeMd(text);

  if (has("bold")) out = `**${out}**`;
  if (has("italic")) out = `*${out}*`;
  if (has("strike")) out = `~~${out}~~`;
  // ==выделение== — синтаксис Obsidian; в «чистом» markdown его нет, но
  // цель экспорта именно Obsidian, а прочие редакторы просто покажут ==.
  if (has("highlight")) out = `==${out}==`;

  const link = marks.find((m) => m.type === "link");
  if (link) {
    const href = String(link.attrs?.href ?? "");
    if (href) out = `[${out}](${href})`;
  }
  return out;
}

/** Собирает инлайн-содержимое узла в одну строку. */
function inlineToMd(nodes: TiptapNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((n) => {
      if (n.type === "hardBreak") return "\n";
      if (typeof n.text === "string") return applyMarks(n.text, n.marks);
      // Незнакомый инлайн-узел — достаём, что можно, из детей.
      return inlineToMd(n.content);
    })
    .join("");
}

/** Разворачивает список. `indent` — вложенность (списки бывают вложенными,
 *  тогда пункты отбиваются двумя пробелами на уровень). */
function listToMd(node: TiptapNode, indent: number): string[] {
  const lines: string[] = [];
  const pad = "  ".repeat(indent);
  const ordered = node.type === "orderedList";
  const startAt = Number(node.attrs?.start ?? 1);

  (node.content ?? []).forEach((item, i) => {
    let marker: string;
    if (node.type === "taskList") {
      marker = item.attrs?.checked ? "- [x] " : "- [ ] ";
    } else if (ordered) {
      marker = `${startAt + i}. `;
    } else {
      marker = "- ";
    }

    // Пункт списка содержит блоки (обычно один абзац, но бывает и
    // вложенный список).
    const blocks = item.content ?? [];
    let first = true;
    for (const block of blocks) {
      if (
        block.type === "bulletList" ||
        block.type === "orderedList" ||
        block.type === "taskList"
      ) {
        lines.push(...listToMd(block, indent + 1));
        continue;
      }
      const text = inlineToMd(block.content);
      if (first) {
        lines.push(`${pad}${marker}${text}`);
        first = false;
      } else {
        // Продолжение пункта — отступ под маркер.
        lines.push(`${pad}  ${text}`);
      }
    }
    // Пустой пункт списка всё равно должен занять строку.
    if (first) lines.push(`${pad}${marker}`);
  });
  return lines;
}

/** Содержимое ячейки — одной строкой: переноса внутри ячейки в
 *  markdown-таблице нет, поэтому блоки склеиваются пробелом. Палка
 *  экранируется, иначе текст ячейки разорвёт строку на лишние колонки. */
function cellToMd(cell: TiptapNode): string {
  return (cell.content ?? [])
    .flatMap(blockToMd)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/** Разворачивает таблицу. Первая строка всегда становится шапкой, даже
 *  если в документе она из обычных ячеек: markdown без строки-разделителя
 *  под шапкой таблицей не считается, и блок развалился бы в текст. */
function tableToMd(node: TiptapNode): string[] {
  const rows = node.content ?? [];
  if (rows.length === 0) return [];

  const width = Math.max(...rows.map((r) => (r.content ?? []).length));
  const line = (cells: string[]) => {
    const full = cells.slice();
    while (full.length < width) full.push("");
    return `| ${full.join(" | ")} |`;
  };

  const out = [line((rows[0].content ?? []).map(cellToMd))];
  out.push(`|${Array(width).fill("---").join("|")}|`);
  for (const row of rows.slice(1)) {
    out.push(line((row.content ?? []).map(cellToMd)));
  }
  return out;
}

/** Разворачивает блочный узел в строки markdown. */
function blockToMd(node: TiptapNode): string[] {
  switch (node.type) {
    case "heading": {
      const level = Math.min(Number(node.attrs?.level ?? 1), 6);
      return [`${"#".repeat(level)} ${inlineToMd(node.content)}`];
    }
    case "paragraph": {
      const text = inlineToMd(node.content);
      return [text];
    }
    case "bulletList":
    case "orderedList":
    case "taskList":
      return listToMd(node, 0);
    case "blockquote": {
      const inner = (node.content ?? []).flatMap(blockToMd);
      return inner.map((l) => (l ? `> ${l}` : ">"));
    }
    case "codeBlock": {
      const lang = String(node.attrs?.language ?? "");
      const code = (node.content ?? []).map((c) => c.text ?? "").join("");
      return ["```" + lang, ...code.split("\n"), "```"];
    }
    case "table":
      return tableToMd(node);
    case "horizontalRule":
      return ["---"];
    case "hardBreak":
      return [""];
    default: {
      // Неизвестный блок — не роняем экспорт, достаём текст детей.
      if (node.content) return (node.content ?? []).flatMap(blockToMd);
      if (typeof node.text === "string") return [escapeMd(node.text)];
      return [];
    }
  }
}

/**
 * Разворачивает документ TipTap в markdown.
 *
 * @param raw сериализованный JSON из базы (или уже разобранный объект).
 *            Битый JSON — не исключение, а обычное дело для старых
 *            записей, поэтому возвращается пустая строка, а не бросается
 *            ошибка.
 */
export function tiptapToMarkdown(raw: string | TiptapNode | null): string {
  if (!raw) return "";
  let doc: TiptapNode;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    try {
      doc = JSON.parse(trimmed) as TiptapNode;
    } catch {
      // Не JSON — вероятно, уже обычный текст. Отдаём как есть.
      return trimmed;
    }
  } else {
    doc = raw;
  }

  const blocks = doc.content ?? [];
  const chunks: string[] = [];
  for (const block of blocks) {
    const lines = blockToMd(block);
    chunks.push(lines.join("\n"));
  }
  // Блоки разделяются пустой строкой; лишние пустоты схлопываем, чтобы
  // не копить простыни переносов на пустых абзацах.
  return chunks
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Имя файла для выгрузки: без символов, запрещённых в файловых системах. */
export function safeFileName(title: string, fallback = "Заметка"): string {
  const base = (title || fallback).trim().replace(/[/\\?%*:|"<>]/g, "-");
  return `${base.slice(0, 80) || fallback}.md`;
}