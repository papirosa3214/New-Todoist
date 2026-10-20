// Проверка критерия карточки: «taskflow_kb_search по запросам … находит заметку первой».
//
// Скрипт повторяет ранжирование серверного поиска заметок (server/src/lib/noteSearch.ts)
// на живой базе TaskFlow в режиме только чтение и печатает позицию заданной
// заметки в выдаче по каждому контрольному запросу.
//
// Запуск:
//   node <путь>/kb-rank-check.mjs <id_заметки> "<запрос>" ["<запрос>"...]
//
// Вывод: позиция заметки (1-based) в выдаче и первые пять конкурентов.
import { createRequire } from "node:module";
// better-sqlite3 лежит в node_modules сервера TaskFlow — подключаем оттуда.
const require = createRequire("/home/maksim/Проекты/New-Todoist/server/package.json");
const Database = require("better-sqlite3");

const noteId = process.argv[2];
const queries = process.argv.slice(3);
if (!noteId || queries.length === 0) {
  console.error("использование: kb-rank-check.mjs <id_заметки> <запрос> [...]");
  process.exit(2);
}

const DB = process.env.TASKFLOW_DB ?? "/home/maksim/Проекты/New-Todoist/server/taskflow.db";
const db = new Database(DB, { readonly: true });

const STOP = new Set(["это","как","что","для","или","при","над","под","его","она","они","там","где","когда","если","чтобы","про","the","and","for"]);

function plainText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(plainText).join("");
  if (node.type === "text") return node.text ?? "";
  if (node.type === "paragraph" || node.type === "heading") return plainText(node.content) + "\n";
  if (node.type === "hardBreak") return "\n";
  return plainText(node.content);
}

function queryStems(query) {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, 5)))];
}
function occurrences(text, stem, limit) {
  let count = 0;
  for (let at = text.indexOf(stem); at !== -1 && count < limit; at = text.indexOf(stem, at + stem.length)) count++;
  return count;
}

const rows = db.prepare(`SELECT n.id, n.title, n.content, n.updated_at, f.name AS folder
  FROM user_notes n LEFT JOIN journal_folders f ON f.id = n.folder_id`).all();
const entries = rows.map((row) => ({
  row,
  title: row.title ?? "",
  text: plainText(JSON.parse(row.content)),
}));
for (const e of entries) {
  e.lowerTitle = e.title.toLowerCase();
  e.lowerText = e.text.toLowerCase();
}

let failed = 0;
for (const query of queries) {
  const stems = queryStems(query);
  const weight = new Map(stems.map((stem) => {
    const df = entries.filter((e) => e.lowerTitle.includes(stem) || e.lowerText.includes(stem)).length;
    return [stem, df ? Math.log(1 + entries.length / df) : 0];
  }));
  const need = Math.max(1, Math.ceil(stems.filter((s) => weight.get(s)).length / 2));
  const ranked = entries.map((e) => {
    let score = 0, matched = 0;
    for (const stem of stems) {
      const inTitle = e.lowerTitle.includes(stem);
      const inText = occurrences(e.lowerText, stem, 5);
      if (inTitle || inText) matched++;
      score += (weight.get(stem) ?? 0) * ((inTitle ? 4 : 0) + inText);
    }
    return { e, score, matched };
  }).filter((r) => r.matched >= need && r.score > 0)
    .sort((a, b) => b.matched - a.matched || b.score - a.score || String(b.e.row.updated_at ?? "").localeCompare(String(a.e.row.updated_at ?? "")));

  const pos = ranked.findIndex((r) => r.e.row.id === noteId) + 1;
  const target = entries.find((e) => e.row.id === noteId);
  const targetRow = ranked.find((r) => r.e.row.id === noteId);
  const detail = stems.map((st) => {
    const df = entries.filter((e) => e.lowerTitle.includes(st) || e.lowerText.includes(st)).length;
    const w = weight.get(st) ?? 0;
    const occ = target ? occurrences(target.lowerText, st, 99) : 0;
    const inTitle = target ? target.lowerTitle.includes(st) : false;
    return `${st}: df=${df} w=${w.toFixed(2)} в_названии=${inTitle} в_тексте=${occ}`;
  });
  console.log(`  заметка: matched=${targetRow?.matched ?? 0} score=${(targetRow?.score ?? 0).toFixed(2)}`);
  detail.forEach((d) => console.log(`    ${d}`));
  console.log(`\nЗапрос: «${query}»`);
  console.log(`  основы: ${stems.join(", ")} (нужно совпадений: ${need})`);
  console.log(`  заметка ${target?.title ?? noteId} → позиция ${pos > 0 ? pos : "не найдена в выдаче"} из ${ranked.length}`);
  ranked.slice(0, 5).forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.e.row.folder ?? "—"}] ${r.e.title.slice(0, 70)} (matched=${r.matched}, score=${r.score.toFixed(2)})`);
  });
  if (pos !== 1) failed++;
}
process.exit(failed > 0 ? 1 : 0);
