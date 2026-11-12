// Разметка Markdown → HTML Telegram.
//
// Зачем: `sendMessage` без `parse_mode` отдаёт текст плоско — `**жирный**`,
// `` `код` `` и ```блок``` приезжают символами, таблица «палочками». Здесь
// markdown переводится в HTML Telegram Bot API (`parse_mode=HTML`), а при
// 400 «can't parse entities» вызывающий код откатывается на plain-текст.
//
// Что понимается:
//  • ``` fenced-блоки → <pre> (моноширинный, с кнопкой «копировать»)
//  • `код` → <code>, **жирный** → <b>, *курсив*/_курсив_ → <i>
//  • [текст](url) → <a href>
//  • `# Заголовок` → <b>Заголовок</b>
//  • `- пункт` → «• пункт» с отступом вложенности (&nbsp;)
//  • таблица `| a | b |` → выровненный моноширинный блок <pre>
//
// Ссылка на документацию: https://core.telegram.org/bots/api#formatting-options

const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

const escapeAttr = (value) => escapeHtml(value).replace(/"/g, "&quot;");

/** Инлайновая разметка одной строки. */
function inlineHtml(line) {
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let out = "";
  let last = 0;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    out += escapeHtml(line.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) out += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    else if (token.startsWith("**") || token.startsWith("__")) out += `<b>${escapeHtml(token.slice(2, -2))}</b>`;
    else if (token.startsWith("*")) out += `<i>${escapeHtml(token.slice(1, -1))}</</i>`;
    else if (token.startsWith("_")) out += `<i>${escapeHtml(token.slice(1, -1))}</i>`;
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      out += link ? `<a href="${escapeAttr(link[2])}">${escapeHtml(link[1])}</a>` : escapeHtml(token);
    }
    last = match.index + token.length;
  }
  out += escapeHtml(line.slice(last));
  return out;
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableDivider = (line) => /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
const tableCells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

/** Таблица → выровненный моноширинный блок: колонки сходятся по ширине. */
function tableHtml(rows) {
  const width = Math.max(...rows.map((row) => row.length));
  const sizes = Array.from({ length: width }, (_unused, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  const lines = rows.map((row) => row.map((cell, column) => cell.padEnd(sizes[column])).join("  ").trimEnd());
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

/**
 * `formatTelegramText` — текст ответа в HTML Telegram.
 * `changed` = false, если размечать нечего: тогда шлём исходный текст без
 * `parse_mode` (лишний HTML Telegram бы только сломал).
 */
export function formatTelegramText(text) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      const language = line.replace(/^\s*```/, "").trim();
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) { body.push(lines[index]); index += 1; }
      index += 1;
      const code = escapeHtml(body.join("\n"));
      out.push(`<pre>${language ? `<b>${escapeHtml(language)}</b>\n` : ""}${code}</pre>`);
      continue;
    }
    if (isTableRow(line) && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const rows = [];
      while (index < lines.length && isTableRow(lines[index])) { rows.push(tableCells(lines[index])); index += 1; }
      out.push(tableHtml(rows));
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) { out.push(`<b>${inlineHtml(heading[1].trim())}</b>`); index += 1; continue; }
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const indent = Math.floor(item[1].replace(/\t/g, "  ").length / 2);
      out.push(`${"&nbsp;".repeat(indent * 2)}• ${inlineHtml(item[2])}`);
      index += 1;
      continue;
    }
    out.push(inlineHtml(line));
    index += 1;
  }
  const html = out.join("\n");
  return { text: raw, html, changed: html !== raw };
}

/** HTML → текст (откат, если Telegram не разобрал разметку). */
export function stripHtml(html) {
  return String(html ?? "")
    // Блоки кода возвращаем ограждениями: у Telegram у блока есть кнопка
    // «копировать» — без ограждений команда на телефоне не берётся целиком.
    .replace(/<pre>([\s\S]*?)<\/pre>/g, (_all, body) => `\n\`\`\`\n${String(body).replace(/<[^>]+>/g, "")}\n\`\`\`\n`)
    .replace(/<\/?(?:b|i|code|pre|a|u|s|strike|spoiler|blockquote|tg-spoiler)(?:\s[^>]*)?>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&");
}
