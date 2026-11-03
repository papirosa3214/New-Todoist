// Поиск по внутренней базе знаний TaskFlow: заметки и документация в самой
// базе трекера (user_notes). Внешних сервисов не касается.
//
// Основной путь (04.11.2026): FTS5 + BM25 по title/search_text
// (миграция 196_user_notes_fts). Fallback — прежний JS-скан по stems.
import db from "../db.js";
import { tiptapToMarkdown } from "./tiptapToMarkdown.js";
import { toFtsQuery } from "./ftsQuery.js";
import { noteSearchText } from "./noteSearchText.js";

export type NoteSearchHit = {
  id: string;
  title: string;
  folder: string | null;
  updated_at: string | null;
  text: string;
};

type Indexed = {
  updatedAt: string | null;
  title: string;
  text: string;
  lowerTitle: string;
  lowerText: string;
};
const cache = new Map<string, Indexed>();
const STOP = new Set([
  "это", "как", "что", "для", "или", "при", "над", "под", "его", "она", "они",
  "там", "где", "когда", "если", "чтобы", "про", "the", "and", "for",
]);

let ftsKnown: boolean | null = null;

function ftsReady(): boolean {
  if (ftsKnown != null) return ftsKnown;
  try {
    ftsKnown = Boolean(
      db
        .prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='user_notes_fts'",
        )
        .get(),
    );
  } catch {
    ftsKnown = false;
  }
  return ftsKnown;
}

function indexed(row: {
  id: string;
  title: string;
  content?: string | null;
  search_text?: string | null;
  updated_at: string | null;
}): Indexed {
  const hit = cache.get(row.id);
  if (hit && hit.updatedAt === row.updated_at) return hit;
  let text = String(row.search_text ?? "").trim();
  if (!text) {
    try {
      text = tiptapToMarkdown(String(row.content ?? ""));
    } catch {
      text = String(row.content ?? "");
    }
  }
  const entry = {
    updatedAt: row.updated_at,
    title: row.title,
    text,
    lowerTitle: row.title.toLowerCase(),
    lowerText: text.toLowerCase(),
  };
  cache.set(row.id, entry);
  return entry;
}

/** Основы слов запроса: первые пять букв — грубо, но падежи и числа сходятся. */
export function queryStems(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3 && !STOP.has(w))
        .map((w) => w.slice(0, 5)),
    ),
  ];
}

function occurrences(text: string, stem: string, limit: number): number {
  let count = 0;
  for (
    let at = text.indexOf(stem);
    at !== -1 && count < limit;
    at = text.indexOf(stem, at + stem.length)
  )
    count++;
  return count;
}

/** Отрывок вокруг места, где основ запроса больше всего. */
function passage(entry: Indexed, stems: string[], size: number): string {
  let best = 0,
    bestScore = -1;
  const needles = stems.length ? stems : queryStems(entry.title);
  for (const stem of needles) {
    for (
      let at = entry.lowerText.indexOf(stem), seen = 0;
      at !== -1 && seen < 20;
      at = entry.lowerText.indexOf(stem, at + stem.length), seen++
    ) {
      const window = entry.lowerText.slice(Math.max(0, at - size / 3), at + size);
      const score = needles.filter((s) => window.includes(s)).length;
      if (score > bestScore) {
        bestScore = score;
        best = at;
      }
    }
  }
  const start = Math.max(0, best - Math.floor(size / 3));
  return (
    (start > 0 ? "…" : "") +
    entry.text.slice(start, start + size).trim() +
    (start + size < entry.text.length ? "…" : "")
  );
}

function searchNotesFts(
  query: string,
  topK: number,
  passageSize: number,
): NoteSearchHit[] | null {
  if (!ftsReady()) return null;
  const match = toFtsQuery(query);
  if (!match) return null;
  const limit = Math.max(1, Math.min(20, topK));
  // bm25(fts, w_title, w_body): title важнее body (~старый title×4).
  // В SQLite FTS5 меньше rank = лучше.
  try {
    const rows = db
      .prepare(
        `SELECT n.id, n.title, n.content, n.search_text, n.updated_at,
                f.name AS folder,
                bm25(user_notes_fts, 4.0, 1.0) AS rank
           FROM user_notes_fts
           JOIN user_notes n ON n.rowid = user_notes_fts.rowid
           LEFT JOIN journal_folders f ON f.id = n.folder_id
          WHERE user_notes_fts MATCH ?
          ORDER BY rank
          LIMIT ?`,
      )
      .all(match, limit) as Array<{
      id: string;
      title: string;
      content: string;
      search_text: string | null;
      updated_at: string | null;
      folder: string | null;
      rank: number;
    }>;
    if (!rows.length) return [];
    const stems = queryStems(query);
    return rows.map((row) => {
      const entry = indexed(row);
      return {
        id: row.id,
        title: row.title,
        folder: row.folder,
        updated_at: row.updated_at,
        text: passage(entry, stems, passageSize),
      };
    });
  } catch {
    return null;
  }
}

function searchNotesLegacy(
  query: string,
  topK: number,
  passageSize: number,
): NoteSearchHit[] {
  const stems = queryStems(query);
  if (!stems.length) return [];
  const hasSearchText = (() => {
    try {
      return (
        db.prepare("PRAGMA table_info(user_notes)").all() as Array<{ name: string }>
      ).some((c) => c.name === "search_text");
    } catch {
      return false;
    }
  })();
  const sql = hasSearchText
    ? `SELECT n.id,n.title,n.content,n.search_text,n.updated_at,f.name AS folder
         FROM user_notes n LEFT JOIN journal_folders f ON f.id=n.folder_id`
    : `SELECT n.id,n.title,n.content,n.updated_at,f.name AS folder
         FROM user_notes n LEFT JOIN journal_folders f ON f.id=n.folder_id`;
  const rows = db.prepare(sql).all() as Array<{
    id: string;
    title: string;
    content: string;
    search_text?: string | null;
    updated_at: string | null;
    folder: string | null;
  }>;
  for (const id of cache.keys())
    if (cache.size > rows.length + 50 && !rows.some((r) => r.id === id))
      cache.delete(id);
  const entries = rows.map((row) => ({ row, entry: indexed(row) }));
  const weight = new Map(
    stems.map((stem) => {
      const df = entries.filter(
        ({ entry }) =>
          entry.lowerTitle.includes(stem) || entry.lowerText.includes(stem),
      ).length;
      return [stem, df ? Math.log(1 + entries.length / df) : 0] as const;
    }),
  );
  const need = Math.max(
    1,
    Math.ceil(stems.filter((s) => weight.get(s)).length / 2),
  );
  return entries
    .map(({ row, entry }) => {
      let score = 0,
        matched = 0;
      for (const stem of stems) {
        const inTitle = entry.lowerTitle.includes(stem),
          inText = occurrences(entry.lowerText, stem, 5);
        if (inTitle || inText) matched++;
        score += (weight.get(stem) ?? 0) * ((inTitle ? 4 : 0) + inText);
      }
      return { row, entry, score, matched };
    })
    .filter((r) => r.matched >= need && r.score > 0)
    .sort(
      (a, b) =>
        b.matched - a.matched ||
        b.score - a.score ||
        String(b.row.updated_at ?? "").localeCompare(
          String(a.row.updated_at ?? ""),
        ),
    )
    .slice(0, Math.max(1, Math.min(20, topK)))
    .map(({ row, entry }) => ({
      id: row.id,
      title: row.title,
      folder: row.folder,
      updated_at: row.updated_at,
      text: passage(entry, stems, passageSize),
    }));
}

export function searchNotes(
  query: string,
  topK = 5,
  passageSize = 900,
): NoteSearchHit[] {
  const fts = searchNotesFts(query, topK, passageSize);
  if (fts) return fts;
  return searchNotesLegacy(query, topK, passageSize);
}

/** Для write-path и миграций: пересчёт plain-текста. */
export { noteSearchText };
