#!/usr/bin/env -S npx tsx
// ═══════════ Мост «TaskFlow Library» ↔ .md-файлы ═══════════
//
// Зачем (01.11.2026). TaskFlow Library — виртуальные папки в SQLite
// (journal_folders с is_kb_root=1 + user_notes), а Obsidian читает только
// каталог с .md-файлами. Этот скрипт держит файловый слой поверх базы:
// заметки библиотеки лежат .md-файлами (отдельный волт обсидиана), правки
// из обсидиана возвращаются в базу, изменения из базы (заметки ролей) —
// в файлы.
//
// Порядок в прогоне: СНАЧАЛА импорт (файл → база), ПОТОМ экспорт
// (база → файл). Иначе гонка: роль записала заметку в базу, а человек
// правил тот же файл — кто-то из них затрёт другого.
//
// Что считается «правкой человека»: тело файла (всё после frontmatter)
// отличается от хэша, записанного в .sync-state.json при прошлом прогоне.
// Frontmatter обсидиан переписывает по-своему (порядок ключей, свои
// свойства) — поэтому в хэш входит только тело, а чужие ключи
// frontmatter при перезаписи сохраняются.
//
// Постоянную категорию заметки (kb_category) мост не перезаписывает при
// импорте: её проставляет Помощник владельца (lib/kbCategories.ts).
// Категория только выгружается в frontmatter.
//
// Удаление файла НЕ удаляет заметку из базы: обсидиан может не заметить
// удалённый файл, а потеря заметки необратима. Такие случаи — в отчёт.
//
// Запуск:
//   npx tsx scripts/kb-files-sync.ts            # полный прогон
//   npx tsx scripts/kb-files-sync.ts --dry-run  # без записи в базу и файлы
//
// Пути: база — server/taskflow.db, файлы — <репозиторий>/kb-files/.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { tiptapToMarkdown } from "../src/lib/tiptapToMarkdown.js";
import { markdownToTiptap, deriveTitleFromMarkdown } from "../src/lib/markdownToTiptap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const DB_PATH = path.join(REPO, "server", "taskflow.db");
/** Волт: только .md-файлы заметок. Всё служебное — рядом, в kb-state/,
 *  чтобы телефон (WebDAV) не перекачивал растущий лог при каждом прогоне. */
const KB_DIR = path.join(REPO, "kb-files");
const KB_STATE = path.join(REPO, "kb-state");
const STATE_PATH = path.join(KB_STATE, "sync-state.json");
const LOG_PATH = path.join(KB_STATE, "sync.log");
const BACKUP_DIR = path.join(KB_STATE, "backups");
/** Пути файлов, которые мост убрал как устаревшие копии (переименования).
 *  Зеркало на Mac читает этот список и не возвращает их обратно на сервер. */
const STALE_PATH = path.join(KB_STATE, "stale-files.txt");

/** Ключи frontmatter, которыми владеет мост. Остальные — чужие, их не трогаем. */
const MANAGED_KEYS = new Set([
  "id",
  "title",
  "category",
  "source_task",
  "folder",
  "created",
  "updated",
]);

interface FolderRow {
  id: number;
  parent_id: number | null;
  name: string;
  is_kb_root: number;
}

interface NoteRow {
  id: string;
  title: string;
  content: string;
  folder_id: number | null;
  kb_category: string | null;
  kb_source_task_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface State {
  version: number;
  /** id заметки → { hash тела файла, путь относительно kb-files } */
  imported: Record<string, { hash: string; path: string }>;
}

const dryRun = process.argv.includes("--dry-run");

const logLines: string[] = [];
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logLines.push(line);
  console.log(msg);
}

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

// ── frontmatter ───────────────────────────────────────────────────────────

/** YAML-значение: JSON-строка — валидный YAML flow-scalar. */
function yamlValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "null";
  return JSON.stringify(String(v));
}

function renderFrontmatter(fm: Record<string, string | null>): string {
  const keys = Object.keys(fm);
  if (!keys.length) return "";
  const lines = ["---"];
  for (const k of keys) lines.push(`${k}: ${yamlValue(fm[k])}`);
  lines.push("---");
  return lines.join("\n") + "\n";
}

/** Разбор frontmatter. Возвращает { fm, body }. fm — плоский map строк. */
function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const norm = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!norm.startsWith("---\n")) return { fm: {}, body: norm };
  const end = norm.indexOf("\n---", 3);
  if (end < 0) return { fm: {}, body: norm };
  const head = norm.slice(4, end);
  const rest = norm.slice(end + 4);
  const fm: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const m = /^([A-Za-z0-9_а-яА-ЯёЁ-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v === "null" || v === "~" || v === "") v = "";
    else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    } else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
      v = v.slice(1, -1);
    }
    fm[m[1]] = v;
  }
  return { fm, body: rest.replace(/^\n+/, "") };
}

// ── имена файлов ─────────────────────────────────────────────────────────

/** Имя файла, пригодное для Obsidian и для любой ФС. */
function sanitizeName(raw: string): string {
  let s = (raw ?? "").replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();
  s = s.replace(/^\.+/, "").replace(/[. ]+$/, "");
  // Заголовок может сам кончаться на «.md» — иначе имя станет «_index.md.md».
  s = s.replace(/\.md$/i, "").trim();
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || "Без названия";
}

/** Имя папки — то же, но без ограничения длины в 120 (те же 120, но с запасом). */
function sanitizeDirName(raw: string): string {
  return sanitizeName(raw);
}

// ── дерево папок ─────────────────────────────────────────────────────────

interface Tree {
  rootId: number;
  /** id папки → путь относительно корня Library («Roles», «Projects/X») */
  rel: Map<number, string>;
  /** id папки → родитель */
  byId: Map<number, FolderRow>;
}

function loadTree(db: Database.Database): Tree {
  const rows = db
    .prepare("SELECT id, parent_id, name, is_kb_root FROM journal_folders")
    .all() as FolderRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const root = rows.find((r) => r.is_kb_root === 1);
  if (!root) {
    throw new Error(
      "Корень Library не найден (journal_folders.is_kb_root=1). " +
        "Прогоняй: cd server && npx tsx scripts/bootstrap-taskflow-library.ts",
    );
  }
  const rel = new Map<number, string>();
  const walk = (id: number, parentRel: string, depth: number): void => {
    if (depth > 12) return;
    rel.set(id, parentRel);
    for (const f of rows) {
      if (f.parent_id === id) {
        const childRel = parentRel ? `${parentRel}/${sanitizeDirName(f.name)}` : sanitizeDirName(f.name);
        walk(f.id, childRel, depth + 1);
      }
    }
  };
  walk(root.id, "", 0);
  return { rootId: root.id, rel, byId };
}

/** Все id папок под корнем Library (включая корень). */
function libraryFolderIds(tree: Tree): number[] {
  return [...tree.rel.keys()];
}

// ── состояние ────────────────────────────────────────────────────────────

function loadState(): State {
  // До 01.11.2026 состояние лежало прямо в волте (kb-files/.sync-state.json) —
  // переносим, чтобы не терять хэши и не переимпортировать всё заново.
  const legacy = path.join(KB_DIR, ".sync-state.json");
  if (!fs.existsSync(STATE_PATH) && fs.existsSync(legacy)) {
    try {
      fs.mkdirSync(KB_STATE, { recursive: true });
      fs.renameSync(legacy, STATE_PATH);
      log("состояние перенесено из волта в kb-state/");
    } catch {
      /* перенос не вышел — начнём с нуля */
    }
  }
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as State;
    if (parsed && typeof parsed === "object" && parsed.imported) return parsed;
  } catch {
    /* состояния нет — первый прогон */
  }
  return { version: 2, imported: {} };
}

function saveState(state: State) {
  if (dryRun) return;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// ── обход файлов ─────────────────────────────────────────────────────────

function walkFiles(dir: string, rel = ""): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // .obsidian, .sync-state.json, .git
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(abs, r));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push({ rel: r, abs });
  }
  return out;
}

// ── основной прогон ──────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`База не найдена: ${DB_PATH}`);
  fs.mkdirSync(KB_STATE, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 8000");

  const state = loadState();

  // Список устаревших путей живёт между прогонами: зеркало на Mac по нему
  // понимает, какие файлы не надо возвращать на сервер.
  const stalePaths = new Set<string>();
  try {
    for (const line of fs.readFileSync(STALE_PATH, "utf8").split("\n")) {
      const p = line.trim();
      if (p) stalePaths.add(p);
    }
  } catch {
    /* списка нет — первый прогон */
  }

  // Миграция состояния: до версии 2 хэш покрывал только тело, теперь — тело
  // и заголовок. Пересобираем хэши по файлам на диске (файлы и база сейчас
  // согласованы) — иначе первый прогон после обновления импортировал бы
  // все 934 заметки и обновил бы их updated_at.
  if (state.version < 2) {
    const rebuilt: State["imported"] = {};
    for (const f of walkFiles(KB_DIR)) {
      const { fm, body } = parseFrontmatter(fs.readFileSync(f.abs, "utf8"));
      const id = (fm.id || "").trim();
      if (!id) continue;
      rebuilt[id] = { hash: sha(`${body}\u0000${(fm.title || "").trim()}`), path: f.rel };
    }
    state.imported = rebuilt;
    state.version = 2;
    log(`состояние пересобрано под формат хэша v2 (${Object.keys(rebuilt).length} заметок)`);
  }
  const tree = loadTree(db);
  const ids = libraryFolderIds(tree);

  const ph = ids.map(() => "?").join(",");
  const notes = db
    .prepare(
      `SELECT id, title, content, folder_id, kb_category, kb_source_task_id, created_at, updated_at
         FROM user_notes
        WHERE folder_id IN (${ph})
        ORDER BY title`,
    )
    .all(...ids) as NoteRow[];

  const notesById = new Map(notes.map((n) => [n.id, n]));

  // Путь заметки → id: чтобы поймать коллизию имён.
  const pathOwners = new Map<string, string>();
  for (const [id, st] of Object.entries(state.imported)) {
    if (notesById.has(id)) pathOwners.set(st.path, id);
  }

  const targetPathFor = (note: NoteRow): string => {
    const folderRel = note.folder_id !== null ? (tree.rel.get(note.folder_id) ?? "") : "";
    const base = sanitizeName(note.title);
    let rel = folderRel ? `${folderRel}/${base}.md` : `${base}.md`;
    const owner = pathOwners.get(rel);
    if (owner && owner !== note.id) {
      rel = folderRel ? `${folderRel}/${base} (${note.id.slice(0, 8)}).md` : `${base} (${note.id.slice(0, 8)}).md`;
    }
    return rel;
  };

  const stats = { imported: 0, exported: 0, created: 0, skipped: 0, missing: 0, stale: 0 };

  // Снимок состояния и файлов ДО прогона: без него проверка «файл пропал»
  // ругалась бы на все заметки, экспортированные текущим же прогоном.
  const stateBefore: State = { version: state.version, imported: { ...state.imported } };
  const filesBeforeSet = new Set(walkFiles(KB_DIR).map((f) => f.rel));

  // ── 1. ИМПОРТ: файлы → база ────────────────────────────────────────────
  const files = walkFiles(KB_DIR);

  const upsertNote = db.prepare(
    `UPDATE user_notes
        SET title = ?, content = ?, updated_at = datetime('now')
      WHERE id = ?`,
  );
  const insertNote = db.prepare(
    `INSERT INTO user_notes (id, title, content, folder_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
  );
  const insertFolder = db.prepare(
    `INSERT INTO journal_folders (parent_id, name, position) VALUES (?, ?, ?)`,
  );
  const findFolderByName = db.prepare(
    "SELECT id FROM journal_folders WHERE parent_id IS ? AND name = ? LIMIT 1",
  );

  /** Папка по относительному пути; недостающие создаются. */
  const folderByRel = (rel: string): number | null => {
    if (!rel) return tree.rootId;
    let parent = tree.rootId;
    let curRel = "";
    for (const seg of rel.split("/")) {
      const row = findFolderByName.get(parent, seg) as { id: number } | undefined;
      curRel = curRel ? `${curRel}/${seg}` : seg;
      if (row) {
        parent = row.id;
        tree.rel.set(parent, curRel);
        continue;
      }
      if (dryRun) return null;
      const info = insertFolder.run(parent, seg, 0);
      parent = Number(info.lastInsertRowid);
      const child: FolderRow = { id: parent, parent_id: tree.rootId, name: seg, is_kb_root: 0 };
      tree.byId.set(parent, child);
      tree.rel.set(parent, curRel);
      log(`создана папка в базе: ${curRel}`);
    }
    return parent;
  };

  /** Заметки, правку которых человек внёс в этом прогоне. */
  const importedThisRun = new Set<string>();

  const importTx = db.transaction(() => {
    // Разбираем файлы по id заметки: одна заметка может лежать в нескольких
    // файлах (зеркало с Мака возвращает файл, который сервер уже переименовал).
    // Живой файл — тот, чей путь записан в состоянии; остальные — устаревшие
    // копии, их убираем в kb-state/backups/stale и в импорт не берём.
    const parsedFiles = files.map((f) => {
      const text = fs.readFileSync(f.abs, "utf8");
      const { fm, body } = parseFrontmatter(text);
      return { ...f, fm, body, hash: sha(`${body}\u0000${(fm.title || "").trim()}`) };
    });
    const byId = new Map<string, typeof parsedFiles>();
    for (const pf of parsedFiles) {
      const id = (pf.fm.id || "").trim();
      if (!id) continue;
      const list = byId.get(id) ?? [];
      list.push(pf);
      byId.set(id, list);
    }
    const liveById = new Map<string, (typeof parsedFiles)[number]>();
    for (const [id, list] of byId) {
      const prev = state.imported[id];
      const live = (prev && list.find((x) => x.rel === prev.path)) || list[0];
      liveById.set(id, live);
      for (const dup of list) {
        if (dup === live) continue;
        // Устаревшая копия той же заметки: убираем из волта, содержимое не теряем.
        const bakDir = path.join(BACKUP_DIR, "stale");
        if (!dryRun) {
          fs.mkdirSync(bakDir, { recursive: true });
          fs.writeFileSync(path.join(bakDir, path.basename(dup.rel)), fs.readFileSync(dup.abs, "utf8"), "utf8");
          fs.unlinkSync(dup.abs);
        }
        log(`устаревшая копия заметки убрана в kb-state/backups/stale: ${dup.rel}`);
        stalePaths.add(dup.rel);
        stats.stale++;
      }
    }

    for (const f of parsedFiles) {
      const { fm, body, hash } = f;
      const id = (fm.id || "").trim();

      if (id && notesById.has(id)) {
        // Живой файл заметки — только он задаёт содержимое.
        if (liveById.get(id) !== f) {
          stats.skipped++;
          continue;
        }
        const prev = state.imported[id];
        if (prev && prev.hash === hash) {
          // Файл не менялся с прошлого прогона — трогать базу нечего.
          if (prev.path !== f.rel) {
            prev.path = f.rel;
            pathOwners.delete(prev.path);
            pathOwners.set(f.rel, id);
          }
          stats.skipped++;
          continue;
        }
        const note = notesById.get(id)!;
        const title = (fm.title || "").trim() || deriveTitleFromMarkdown(body) || note.title;
        const content = markdownToTiptap(body);
        if (!dryRun) upsertNote.run(title, content, id);
        log(`импорт: «${title.slice(0, 70)}» → база`);
        stats.imported++;
        importedThisRun.add(id);
        state.imported[id] = { hash, path: f.rel };
        pathOwners.set(f.rel, id);
        continue;
      }

      // Файл без id (или с чужим id) — новая заметка, созданная в обсидиане.
      if (id && !notesById.has(id)) {
        log(`пропуск: в frontmatter id «${id}», которого нет в базе (файл не наш)`);
        stats.skipped++;
        continue;
      }
      const title = (fm.title || "").trim() || deriveTitleFromMarkdown(body) || path.basename(f.rel, ".md");
      const folderRel = (fm.folder || "").trim() || path.dirname(f.rel).split("/").filter(Boolean).join("/");
      const folderId = folderByRel(folderRel);
      const newId = crypto.randomUUID();
      const content = markdownToTiptap(body);
      if (!dryRun) insertNote.run(newId, title, content, folderId ?? null);
      log(`новая заметка из обсидиана: «${title.slice(0, 70)}» (папка: ${folderRel || "корень"})`);
      stats.created++;

      // Проставляем свой id в файл, чтобы в следующий раз узнать его.
      state.imported[newId] = { hash, path: f.rel };
      pathOwners.set(f.rel, newId);
      if (!dryRun) {
        const merged = { ...fm, id: newId, title };
        const out = renderFrontmatter(merged) + "\n" + body;
        fs.writeFileSync(f.abs, out, "utf8");
      }
    }
  });
  importTx();

  // ⚠️ После импорта список заметок перечитываем: снимок, сделанный ДО
  // импорта, содержал старые тексты, и экспорт затирал свежую правку
  // человека её прежней версией (файл откатывался на месте).
  const notesFresh = db
    .prepare(
      `SELECT id, title, content, folder_id, kb_category, kb_source_task_id, created_at, updated_at
         FROM user_notes
        WHERE folder_id IN (${ph})
        ORDER BY title`,
    )
    .all(...ids) as NoteRow[];
  for (const n of notesFresh) notesById.set(n.id, n);
  notes.length = 0;
  notes.push(...notesFresh);

  // ── 2. ЭКСПОРТ: база → файлы ───────────────────────────────────────────
  const exportTx = db.transaction(() => {
    for (const note of notes) {
      const body = tiptapToMarkdown(note.content);
      const bodyHash = sha(body);
      const dbTitle = (note.title || "").trim();
      // Хэш состояния покрывает тело И заголовок (как в импорте).
      const stateHash = sha(`${body}\u0000${dbTitle}`);
      let rel = targetPathFor(note);

      // Разбираемся, чьё имя у файла.
      //   — файл на месте, его свойство title совпадает с заголовком в базе:
      //     значит имя выбрал человек (переименовал в обсидиане) — уважаем;
      //   — свойство title в файле устарело (заголовок в базе изменили):
      //     файл переезжает на имя из заголовка, старый убираем.
      const st = state.imported[note.id];
      let staleAbs: string | null = null;
      if (st && st.path && st.path !== rel) {
        const stAbs = path.join(KB_DIR, st.path);
        if (fs.existsSync(stAbs)) {
          const parsed = parseFrontmatter(fs.readFileSync(stAbs, "utf8"));
          const sameBody = sha(parsed.body) === bodyHash;
          const fileTitle = (parsed.fm.title || "").trim();
          if (sameBody && fileTitle === dbTitle) {
            rel = st.path;
          } else if (sameBody) {
            staleAbs = stAbs;
          }
        }
      }
      const abs = path.join(KB_DIR, rel);

      let existingBody: string | null = null;
      let existingFm: Record<string, string> = {};
      if (fs.existsSync(abs)) {
        const parsed = parseFrontmatter(fs.readFileSync(abs, "utf8"));
        existingBody = parsed.body;
        existingFm = parsed.fm;
      }

      // Файл совпадает с базой — не трогаем (свойства обсидиана остаются).
      // Исключение: свойство title устарело (заголовок в базе изменили) —
      // тогда файл переписываем, чтобы свойство не расходилось с базой.
      const titleStale = (existingFm.title || "").trim() !== dbTitle;
      if (existingBody !== null && sha(existingBody) === bodyHash && !titleStale) {
        state.imported[note.id] = { hash: stateHash, path: rel };
        pathOwners.set(rel, note.id);
        stats.skipped++;
        continue;
      }

      const ourFm: Record<string, string | null> = {
        id: note.id,
        title: note.title,
        category: note.kb_category,
        source_task: note.kb_source_task_id,
        folder: note.folder_id !== null ? (tree.rel.get(note.folder_id) ?? "") : "",
        created: note.created_at,
        updated: note.updated_at,
      };
      // Чужие ключи frontmatter (свойства обсидиана) сохраняем.
      const merged: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(existingFm)) {
        if (!MANAGED_KEYS.has(k)) merged[k] = v;
      }
      for (const [k, v] of Object.entries(ourFm)) {
        if (v !== null && v !== undefined && v !== "") merged[k] = v;
        else if (!(k in merged)) merged[k] = null;
      }

      if (!dryRun) {
        // Если файл правил человек и мы сейчас его перезаписываем канонической
        // версией из базы — прежние байты сохраняем в kb-state/backups/ (вне волта).
        if (existingBody !== null && importedThisRun.has(note.id)) {
          const bakDir = BACKUP_DIR;
          fs.mkdirSync(bakDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const bak = path.join(bakDir, `${note.id.slice(0, 8)}-${stamp}.md`);
          fs.writeFileSync(bak, fs.readFileSync(abs, "utf8"), "utf8");
          log(`бэкап правки человека: ${path.relative(REPO, bak)}`);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, renderFrontmatter(merged) + "\n" + body, "utf8");
        // Заметку в базе переименовали — старый файл убираем, чтобы в волте
        // не осталось двух копий одной заметки.
        if (staleAbs && staleAbs !== abs) {
          try {
            fs.unlinkSync(staleAbs);
            stalePaths.add(path.relative(KB_DIR, staleAbs));
            log(`старый файл убран после переименования: ${path.relative(KB_DIR, staleAbs)}`);
          } catch {
            /* файл уже исчез — не беда */
          }
        }
      }
      state.imported[note.id] = { hash: stateHash, path: rel };
      pathOwners.set(rel, note.id);
      stats.exported++;
      if (existingBody === null) log(`экспорт: новая «${note.title.slice(0, 70)}» → ${rel}`);
      else log(`экспорт: обновлена «${note.title.slice(0, 70)}» → ${rel}`);
    }
  });
  exportTx();

  // ── 3. Пропавшие файлы ─────────────────────────────────────────────────
  for (const [id, st] of Object.entries(stateBefore.imported)) {
    if (filesBeforeSet.has(st.path)) continue;
    if (!notesById.has(id)) continue;
    stats.missing++;
    log(
      `ВНИМАНИЕ: файл заметки исчез (${st.path}) — заметка в базе сохранена. ` +
        `Удаление файла в обсидиане не удаляет заметку.`,
    );
  }

  saveState(state);
  // Список устаревших путей — это чёрный список «не возвращать на сервер».
  // Поэтому из него убираются только те пути, которые снова стали живыми
  // файлами заметок; исчезнувшие из волта пути остаются в списке (именно их
  // зеркало на Mac не должно возвращать).
  if (!dryRun) {
    const live = new Set(Object.values(state.imported).map((v) => v.path));
    const keep = [...stalePaths].filter((p) => !live.has(p));
    fs.writeFileSync(STALE_PATH, keep.join("\n") + (keep.length ? "\n" : ""), "utf8");
  }
  db.close();

  const summary =
    `импорт=${stats.imported} новая=${stats.created} экспорт=${stats.exported} ` +
    `без изменений=${stats.skipped} пропало файлов=${stats.missing} ` +
    `устаревших копий=${stats.stale} ` +
    `(заметок в Library: ${notes.length}${dryRun ? ", DRY-RUN" : ""})`;
  log(summary);

  if (!dryRun) {
    fs.mkdirSync(KB_DIR, { recursive: true });
    fs.mkdirSync(KB_STATE, { recursive: true });
    // Ротация лога: мост пишет каждый прогон, без обрезки он рос бы вечно.
    try {
      const st = fs.statSync(LOG_PATH);
      if (st.size > 2 * 1024 * 1024) {
        const kept = fs.readFileSync(LOG_PATH, "utf8").split("\n").slice(-2000).join("\n");
        fs.writeFileSync(LOG_PATH, kept, "utf8");
      }
    } catch {
      /* лога нет — создастся при append */
    }
    fs.appendFileSync(LOG_PATH, logLines.map((l) => l.replace(/^\[[^\]]+\]\s*/, "")).join("\n") + "\n", "utf8");
  }
}

try {
  main();
} catch (err) {
  console.error(`kb-files-sync: ОШИБКА: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
