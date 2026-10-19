// Единый формат текста роли (карточка cea8d997, ветка сервера).
//
// Что это. Роли пишут в пяти местах приложения: чат, лента работы роли,
// комментарий карточки, результат шага, описание и итог задачи. Формат
// проверялся только в чате (routes/chats.ts → widgetNormalize), остальные
// точки принимали что угодно, и разнобой рисовался по-разному. Здесь один
// вход для текста роли: нормализация, автозамена очевидного и проверка по
// каталогу (lib/widgetContract.ts) с понятным отказом и образцом.
//
// Решение владельца от 20.10.2020 — вариант «Б»: очевидное сервер меняет сам,
// остальное возвращает роли с текстом ошибки и образцом правильного JSON.
// Молча портить ответ нельзя (так потерялся бы текст роли), и молча
// принимать неверный блок тоже нельзя (клиент нарисовал бы «виджет не
// разработан»).
//
// Что автозамена делает и чего не делает:
//   - таблица Markdown (| … |) → блок `table`;
//   - ряд строк «название: число» → блок `metrics`;
//   - ряд чисел по датам/категориям → блок `chart`.
// Тонкие случаи (выводы, сравнения по смыслу, числа вперемешку с текстом)
// остаются на модели — это принято владельцем, и автозамена их не трогает:
// она срабатывает только по признакам (разделитель таблицы, «число» в конце
// строки, подряд идущие строки одного вида).

import {
  ALL_WIDGET_TYPES,
  validateWidgetBlock,
  widgetExampleFence,
  type WidgetBlockProblem,
} from "./widgetContract.js";
import { normalizeWidgetBlocks } from "./widgetNormalize.js";

export interface RoleFormatProblem {
  /** Короткое объяснение: что не так. */
  message: string;
  /** Где в тексте роль это написала: block, table[1], metrics[2]. */
  path: string;
  /** Образец правильного блока ```widget — роль переписывает по нему. */
  sample: string;
}

export interface RoleFormatResult {
  /** Текст после автозамены (при проблемах не меняется). */
  text: string;
  /** Что сервер заменил сам: названия автозамен. */
  autoReplaced: string[];
  /** Претензии к блокам: битый JSON, неизвестный тип, лишние поля. */
  problems: RoleFormatProblem[];
  /** true — текст можно сохранять. */
  ok: boolean;
}

const WIDGET_BLOCK = /```widget[^\n]*\n([\s\S]*?)(?:\n```|$)/g;

/** Строка-шапка markdown-таблицы: | А | Б |. Разделитель: | --- | --- |. */
const TABLE_ROW = /^[ \t]*\|(.+)\|[ \t]*$/;
const TABLE_DIVIDER = /^[ \t]*\|[\s: -]*-[ \s|:-]*\|[ \t]*$/;
/** «Заголовок: 12», «Заголовок — 3,5», «Заголовок: 40 %». */
const LABEL_NUMBER = /^[-*\s]*([^\s:][^:]{1,60}?)\s*[:—–-]\s*(-?\d[\d\s.,]*)\s*(%|[а-яa-z]{0,12})?\s*$/i;
/**
 * Подпись для метрики: короткая фраза без сравнений и вставленных чисел.
 * «Задач», «Проверок», «Дефектов» — данные; «Работы больше недели»,
 * «Тесты из 27» — фраза, и такой ряд остаётся текстом (тонкие случаи
 * остаются на модели, это принято владельцем).
 */
const METRIC_LABEL = /^[\p{L}\d][\p{L}\d\s'’()\-]{0,40}$/u;
/** Метка, похожая на дату или категорию: 2026-10-14, 14.10, пн, Q4. */
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./]\d{1,2}([./]\d{2,4})?$|^пн|^вт|^ср|^чт|^пт|^сб|^вс|^q[1-4]$/i;

/** Разобрать число из строки: «3,5» → 3.5, «1 200» → 1200. */
function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Собрать блок ```widget с JSON, обёрнутый в исходный текст. */
function widgetBlock(block: Record<string, unknown>): string {
  return "```widget\n" + JSON.stringify(block, null, 2) + "\n```";
}

interface LineRange {
  start: number;
  end: number;
  lines: string[];
}

/** Найти подряд идущие строки, подходящие под тест. */
function findRuns(lines: string[], matches: (line: string) => boolean, minRun: number): LineRange[] {
  const runs: LineRange[] = [];
  let start = -1;
  for (let index = 0; index <= lines.length; index += 1) {
    const ok = index < lines.length && matches(lines[index]);
    if (ok && start < 0) start = index;
    if (!ok && start >= 0) {
      if (index - start >= minRun) runs.push({ start, end: index, lines: lines.slice(start, index) });
      start = -1;
    }
  }
  return runs;
}

function replaceRuns(
  text: string,
  runs: LineRange[],
  build: (lines: string[]) => string | null,
  autoReplaced: string[],
): string {
  if (!runs.length) return text;
  let result = "";
  let cursor = 0;
  for (const run of runs) {
    const block = build(run.lines);
    if (!block) continue;
    const start = offsetOfLine(text, run.start);
    const end = offsetOfLine(text, run.end);
    result += text.slice(cursor, start) + block;
    cursor = end;
    // Имя автозамены — тип блока: по нему видно в отчёте и в логе сторожа,
    // что именно сервер поменял сам.
    autoReplaced.push(/"type"\s*:\s*"([a-z_]+)"/.exec(block)?.[1] ?? "блок");
  }
  return result + text.slice(cursor);
}

function offsetOfLine(text: string, lineIndex: number): number {
  if (lineIndex <= 0) return 0;
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset;
}

/** Таблица Markdown → блок table. Берём только таблицы с заголовком и строками. */
function replaceTables(text: string, autoReplaced: string[]): string {
  const lines = text.split("\n");
  const runs: LineRange[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = TABLE_ROW.exec(lines[index]);
    const divider = index + 1 < lines.length ? TABLE_DIVIDER.exec(lines[index + 1]) : null;
    if (!header || !divider) {
      index += 1;
      continue;
    }
    const cells = (line: string): string[] | null => {
      const match = TABLE_ROW.exec(line);
      if (!match) return null;
      return match[1].split("|").map((cell) => cell.trim());
    };
    const columns = cells(lines[index]) ?? [];
    const body: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const row = cells(lines[cursor]);
      if (!row || row.length !== columns.length) break;
      body.push(row);
      cursor += 1;
    }
    if (columns.length >= 2 && body.length >= 1 && columns.every((cell) => cell.length > 0)) {
      runs.push({ start: index, end: cursor, lines: lines.slice(index, cursor) });
      index = cursor;
      continue;
    }
    index += 1;
  }
  return replaceRuns(
    text,
    runs,
    (runLines) => {
      const rowCells = (line: string): string[] =>
        (TABLE_ROW.exec(line)?.[1] ?? "").split("|").map((cell) => cell.trim());
      const columns = rowCells(runLines[0]);
      const rows = runLines.slice(2).map(rowCells);
      if (columns.length < 2 || rows.length < 1) return null;
      return widgetBlock({ type: "table", columns, rows });
    },
    autoReplaced,
  );
}

/** Разобрать строки «название: число». */
function labelNumberPair(line: string): { label: string; value: number } | null {
  const match = LABEL_NUMBER.exec(line.trim());
  if (!match) return null;
  const value = parseNumber(match[2]);
  if (value === null) return null;
  const label = match[1].replace(/^[-*\s]+/, "").trim();
  if (!label || !METRIC_LABEL.test(label)) return null;
  // Подпись с несколькими словами — только если это дата или категория;
  // иначе перед нами фраза, а не строка данных.
  if (/\s/.test(label) && !DATE_LIKE.test(label)) return null;
  return { label, value };
}

/** Ряд «название: число» → блок metrics. */
function replaceLabelNumbers(text: string, autoReplaced: string[]): string {
  const lines = text.split("\n");
  const runs = findRuns(lines, (line) => labelNumberPair(line) !== null, 3);
  return replaceRuns(
    text,
    runs,
    (runLines) => {
      const pairs = runLines.map(labelNumberPair).filter(Boolean) as { label: string; value: number }[];
      if (pairs.length < 3) return null;
      const byDate = pairs.every((pair) => DATE_LIKE.test(pair.label));
      if (byDate) return null; // это график, его заменяет шаг ниже
      const items = pairs.map((pair) => ({ label: pair.label, value: String(pair.value), delta: String(pair.value), trend: "flat" }));
      const first = runLines[0].trim();
      const heading = /^(?:[#*\s]+)?([^\s:][^:]{1,60}?)\s*[:—–-]\s*$/.exec(first);
      return widgetBlock({ type: "metrics", ...(heading ? { title: heading[1].trim() } : {}), items });
    },
    autoReplaced,
  );
}

/** Ряд чисел по датам или категориям → блок chart. */
function replaceNumberSeries(text: string, autoReplaced: string[]): string {
  const lines = text.split("\n");
  const runs = findRuns(lines, (line) => labelNumberPair(line) !== null, 3);
  return replaceRuns(
    text,
    runs,
    (runLines) => {
      const pairs = runLines.map(labelNumberPair).filter(Boolean) as { label: string; value: number }[];
      if (pairs.length < 3) return null;
      const labels = pairs.map((pair) => pair.label);
      const dated = labels.filter((label) => DATE_LIKE.test(label)).length;
      if (dated < pairs.length) return null;
      const kind = labels.every((label) => /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./]\d{1,2}/.test(label)) ? "line" : "bar";
      const heading = /^(?:[#*\s]+)?([^\s:][^:]{1,60}?)\s*[:—–-]\s*$/.exec(runLines[0].trim());
      return widgetBlock({
        type: "chart",
        ...(heading ? { title: heading[1].trim() } : {}),
        kind,
        points: labels.map((label, position) => ({ x: label, y: pairs[position].value })),
      });
    },
    autoReplaced,
  );
}

/** Проверить все ```widget-блоки текста по каталогу. */
export function checkRoleBlocks(text: string): RoleFormatProblem[] {
  const problems: RoleFormatProblem[] = [];
  const blocks = [...text.matchAll(WIDGET_BLOCK)];
  blocks.forEach((match, index) => {
    const raw = match[1].trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      problems.push({
        path: `widget[${index}]`,
        message: "битый JSON блока: " + (error instanceof Error ? error.message : String(error)),
        sample: widgetExampleFence("metrics"),
      });
      return;
    }
    const type = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? String((parsed as Record<string, unknown>).type ?? "")
      : "";
    const found: WidgetBlockProblem[] = validateWidgetBlock(parsed, `widget[${index}]`);
    for (const problem of found) {
      problems.push({
        path: problem.path,
        message: problem.message,
        sample: widgetExampleFence(type && found.length ? type : "table"),
      });
    }
  });
  return problems;
}

/** Кусок текста вне блока кода. Внутри ``` … ``` автозамена не ходит:
 *  роль вправе показать в ответе пример формата или чужую таблицу в коде —
 *  переписывать её значило бы портить цитату. */
const CODE_FENCE = /```[\s\S]*?(?:```|$)/g;

/**
 * Прогнать автозамены только по кускам вне блоков кода. Список сработавших
 * автозамен общий на все шаги: куски собираются заново, иначе второй шаг
 * потерял бы первый.
 */
function outsideCode(
  text: string,
  autoReplaced: string[],
  step: (part: string, into: string[]) => string,
): string {
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(CODE_FENCE)) {
    const start = match.index ?? 0;
    result += step(text.slice(cursor, start), autoReplaced) + match[0];
    cursor = start + match[0].length;
  }
  return result + step(text.slice(cursor), autoReplaced);
}

/**
 * Привести текст роли к формату: нормализация блоков, автозамена очевидного,
 * затем проверка по каталогу. Пустой problems — текст можно сохранять.
 * При проблемах возвращается исходный текст: автозамена не применяется
 * частично, чтобы роль не получила наполовину переписанный ответ.
 */
export function applyRoleFormat(text: string): RoleFormatResult {
  if (!text || !text.trim()) return { text: text ?? "", autoReplaced: [], problems: [], ok: true };
  const autoReplaced: string[] = [];
  let result = normalizeWidgetBlocks(text);
  result = outsideCode(result, autoReplaced, replaceTables);
  result = outsideCode(result, autoReplaced, replaceLabelNumbers);
  result = outsideCode(result, autoReplaced, replaceNumberSeries);
  const problems = checkRoleBlocks(result);
  return { text: problems.length ? text : result, autoReplaced, problems, ok: problems.length === 0 };
}

/**
 * Текст отказа для роли: что не так и образец правильного блока.
 * Роль читает это как текст ошибки инструмента и переписывает блок.
 */
export function roleFormatRefusal(result: RoleFormatResult): string {
  const lines = ["Формат блока не принят. Что не так:"];
  for (const problem of result.problems.slice(0, 3)) {
    lines.push(`- ${problem.path}: ${problem.message}`);
  }
  if (result.problems.length > 3) lines.push(`- и ещё ${result.problems.length - 3} замечаний.`);
  lines.push("", "Образец правильного блока:");
  lines.push(result.problems[0]?.sample || widgetExampleFence("metrics"));
  lines.push("", `Допустимые типы: ${ALL_WIDGET_TYPES.join(", ")}.`);
  return lines.join("\n");
}

/** Собрать блок из строк «название: число» — для тестов и сторожа. */
export function metricsBlock(pairs: { label: string; value: number }[], title?: string): string {
  return widgetBlock({
    type: "metrics",
    ...(title ? { title } : {}),
    items: pairs.map((pair) => ({ label: pair.label, value: String(pair.value), delta: String(pair.value), trend: "flat" })),
  });
}