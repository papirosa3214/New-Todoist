// Поиск по внутренней базе знаний TaskFlow: заметки и документация в самой
// базе трекера (user_notes). Внешних сервисов не касается.
import db from "../db.js";
import { tiptapToMarkdown } from "./tiptapToMarkdown.js";

type Indexed = { updatedAt: string | null; title: string; text: string; lowerTitle: string; lowerText: string };
const cache = new Map<string, Indexed>();
const STOP = new Set(["это", "как", "что", "для", "или", "при", "над", "под", "его", "она", "они", "там", "где", "когда", "если", "чтобы", "про", "the", "and", "for"]);

function indexed(row: { id: string; title: string; content: string; updated_at: string | null }): Indexed {
  const hit = cache.get(row.id);
  if (hit && hit.updatedAt === row.updated_at) return hit;
  let text = "";
  try { text = tiptapToMarkdown(row.content); } catch { text = String(row.content ?? ""); }
  const entry = { updatedAt: row.updated_at, title: row.title, text, lowerTitle: row.title.toLowerCase(), lowerText: text.toLowerCase() };
  cache.set(row.id, entry);
  return entry;
}
/** Основы слов запроса: первые пять букв — грубо, но падежи и числа сходятся. */
export function queryStems(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, 5)))];
}
function occurrences(text: string, stem: string, limit: number): number {
  let count = 0;
  for (let at = text.indexOf(stem); at !== -1 && count < limit; at = text.indexOf(stem, at + stem.length)) count++;
  return count;
}
/** Отрывок вокруг места, где основ запроса больше всего. */
function passage(entry: Indexed, stems: string[], size: number): string {
  let best = 0, bestScore = -1;
  for (const stem of stems) {
    for (let at = entry.lowerText.indexOf(stem), seen = 0; at !== -1 && seen < 20; at = entry.lowerText.indexOf(stem, at + stem.length), seen++) {
      const window = entry.lowerText.slice(Math.max(0, at - size / 3), at + size);
      const score = stems.filter((s) => window.includes(s)).length;
      if (score > bestScore) { bestScore = score; best = at; }
    }
  }
  const start = Math.max(0, best - Math.floor(size / 3));
  return (start > 0 ? "…" : "") + entry.text.slice(start, start + size).trim() + (start + size < entry.text.length ? "…" : "");
}

export function searchNotes(query: string, topK = 5, passageSize = 900) {
  const stems = queryStems(query);
  if (!stems.length) return [];
  const rows = db.prepare(`SELECT n.id,n.title,n.content,n.updated_at,f.name AS folder FROM user_notes n LEFT JOIN journal_folders f ON f.id=n.folder_id`).all() as
    Array<{ id: string; title: string; content: string; updated_at: string | null; folder: string | null }>;
  for (const id of cache.keys()) if (cache.size > rows.length + 50 && !rows.some((r) => r.id === id)) cache.delete(id);
  const entries = rows.map((row) => ({ row, entry: indexed(row) }));
  // Редкая основа важнее частой: «интеграция» есть везде, «гособлако» — в двух заметках.
  const weight = new Map(stems.map((stem) => {
    const df = entries.filter(({ entry }) => entry.lowerTitle.includes(stem) || entry.lowerText.includes(stem)).length;
    return [stem, df ? Math.log(1 + entries.length / df) : 0] as const;
  }));
  const need = Math.max(1, Math.ceil(stems.filter((s) => weight.get(s)).length / 2));
  return entries.map(({ row, entry }) => {
    let score = 0, matched = 0;
    for (const stem of stems) {
      const inTitle = entry.lowerTitle.includes(stem), inText = occurrences(entry.lowerText, stem, 5);
      if (inTitle || inText) matched++;
      score += (weight.get(stem) ?? 0) * ((inTitle ? 4 : 0) + inText);
    }
    return { row, entry, score, matched };
  }).filter((r) => r.matched >= need && r.score > 0)
    .sort((a, b) => b.matched - a.matched || b.score - a.score || String(b.row.updated_at ?? "").localeCompare(String(a.row.updated_at ?? "")))
    .slice(0, Math.max(1, Math.min(20, topK)))
    .map(({ row, entry }) => ({ id: row.id, title: row.title, folder: row.folder, updated_at: row.updated_at, text: passage(entry, stems, passageSize) }));
}
