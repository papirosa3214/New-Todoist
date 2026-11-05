// ═══════════ Папки базы знаний: инвентаризация, защиты, уборка ═══════════
//
// Карточка 1c93ff67 «Следить за чистотой и порядком в базе знаний».
// Раньше у ролей не было НИ ОДНОЙ операции над папками: маршруты
// /api/journal/folders требуют токена, которого у роли нет, а правка базы
// мимо приложения запрещена правилом владельца от 21.10.2026. Помощник
// владельца в этой карточке убрал 10 заметок из очереди разбора
// (taskflow_kb_categorize), а папки убрать не смог.
//
// Здесь три вещи:
//   1) инвентаризация папок: id, имя, родитель, число заметок, привязанная
//      задача и её состояние, признак корня библиотеки;
//   2) защиты удаления (шаг карточки 1б): нельзя корень библиотеки и его
//      разделы, нельзя папку живой (незакрытой) задачи, нельзя папку с
//      неразобранными заметками;
//   3) перенос заметок с постоянной категорией в раздел библиотеки перед
//      удалением папки закрытой задачи.
//
// Тонкость про автора и дату заметки: при переносе меняется ТОЛЬКО
// folder_id. Обычный PATCH /api/notes/:id переписывает updated_at и
// updated_by, а «срез по роли» (runtime/roleSlice.ts) строится по автору и
// дате правки — перенос заметки в раздел библиотеки не должен выдавать
// роль за автора чужих заметок. Поэтому перенос пишет напрямую в
// user_notes.folder_id (то же, чем разметка категорий в
// lib/kbCategories.ts — и по той же причине).
import fs from "fs";
import path from "path";
import db, { DB_PATH } from "../db.js";
import { getKbRoot } from "./notesFolders.js";
import { KB_DROP_MARK } from "./kbCategories.js";

/** Разделы библиотеки, которые нельзя удалять никогда. */
export const KB_SECTION_NAMES = ["Roles", "Workflows", "Norms", "Knowledge Base", "Projects"];

export interface FolderTaskRef {
  id: string;
  title: string;
  state: "в работе" | "закрыта" | "в архиве";
  closed: boolean;
}

export interface FolderInventoryRow {
  id: number;
  name: string;
  parent_id: number | null;
  parent_name: string | null;
  notes_count: number;
  children_count: number;
  is_kb_root: boolean;
  is_kb_section: boolean;
  under_kb_root: boolean;
  task: FolderTaskRef | null;
  /** Заметки без разбора: ни постоянной категории, ни пометки «мусор». */
  unresolved_notes: number;
  /** Заметки с постоянной категорией (их раздел библиотеки для переноса). */
  categorized_notes: number;
  /** Заметки с пометкой «мусор» — разбор есть, но заметку не удаляем. */
  trash_notes: number;
  deletable: boolean;
  reasons: string[];
}

/** Состояние задачи — словами, а не флагом. */
function taskState(task: any): FolderTaskRef["state"] {
  if (task?.archived_at) return "в архиве";
  if (task?.status === "completed") return "закрыта";
  return "в работе";
}

/**
 * Задача, которой принадлежит папка. Связь — tasks.artifact_folder_id
 * (миграция 106/107: папка задания заводится вместе с задачей).
 */
export function taskOfFolder(folderId: number): FolderTaskRef | null {
  const row = db
    .prepare(
      "SELECT id, title, status, archived_at FROM tasks WHERE artifact_folder_id = ? LIMIT 1",
    )
    .get(folderId) as any;
  if (!row) return null;
  const state = taskState(row);
  return { id: row.id, title: row.title, state, closed: state !== "в работе" };
}

/** Раздел библиотеки для категории заметки (по названию категории). */
export function sectionFolderForCategory(category: string): number | null {
  const root = getKbRoot();
  if (!root) return null;
  const row = db
    .prepare(
      "SELECT id FROM journal_folders WHERE parent_id = ? AND lower(name) = lower(?) LIMIT 1",
    )
    .get(root.id, category) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Есть ли у папки дочерние папки: удаление родителя каскадит на детей. */
export function hasChildren(folderId: number): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM journal_folders WHERE parent_id = ?")
    .get(folderId) as { n: number };
  return row.n > 0;
}

/** Папка под корнем библиотеки (включая сам корень). */
export function isUnderKbRoot(folderId: number): boolean {
  const root = getKbRoot();
  if (!root) return false;
  let id: number | null = folderId;
  const seen = new Set<number>();
  while (id !== null && !seen.has(id)) {
    if (id === root.id) return true;
    seen.add(id);
    const row = db
      .prepare("SELECT parent_id FROM journal_folders WHERE id = ?")
      .get(id) as { parent_id: number | null } | undefined;
    id = row?.parent_id ?? null;
  }
  return false;
}

/**
 * Защиты удаления папки (шаг карточки 1б):
 *   • нельзя корень библиотеки (is_kb_root=1) и его разделы;
 *   • нельзя папку живой (незакрытой) задачи;
 *   • нельзя папку с неразобранными заметками (постоянной категории нет и
 *     пометки «мусор» нет);
 *   • нельзя папку с заметками, постоянная категория которых не имеет
 *     раздела библиотеки (переносить их некуда — например «Исследования»).
 * Возвращает список причин; пустой список — удалять можно.
 */
export function folderDeleteReasons(folderId: number): string[] {
  const reasons: string[] = [];
  const folder = db
    .prepare("SELECT id, parent_id, name, is_kb_root FROM journal_folders WHERE id = ?")
    .get(folderId) as any;
  if (!folder) return ["Папка не найдена"];

  if (folder.is_kb_root === 1) {
    reasons.push("Это корень библиотеки знаний — его удалять нельзя");
    return reasons;
  }
  const root = getKbRoot();
  if (root && folder.parent_id === root.id && KB_SECTION_NAMES.includes(folder.name)) {
    reasons.push(`Это раздел библиотеки «${folder.name}» — его удалять нельзя`);
  }
  if (hasChildren(folder.id)) {
    reasons.push("В папке есть вложенные папки — их удаление пойдёт каскадом");
  }
  const task = taskOfFolder(folder.id);
  if (task && !task.closed) {
    reasons.push(`Папка живой задачи «${task.title}» (${task.state})`);
  }
  // «Неразобранная» заметка — та, что стоит в очереди разбора базы знаний:
  // временная метка есть, постоянной категории нет и пометки «мусор» нет.
  // Обычные заметки задания (ни одной метки) сюда не относятся: они не в
  // базе знаний, и их папка убирается вместе с задачей.
  const unresolved = db
    .prepare(
      `SELECT COUNT(*) AS n FROM user_notes
        WHERE folder_id = ?
          AND kb_category IS NULL
          AND kb_temp_category IS NOT NULL
          AND kb_temp_category <> ?`,
    )
    .get(folder.id, KB_DROP_MARK) as { n: number };
  if (unresolved.n > 0) {
    reasons.push(
      `В папке ${unresolved.n} неразобранных заметок (временная метка есть, постоянной категории нет) — сначала разбор`,
    );
  }
  const unmapped = db
    .prepare(
      `SELECT kb_category, COUNT(*) AS n FROM user_notes
        WHERE folder_id = ? AND kb_category IS NOT NULL
        GROUP BY kb_category`,
    )
    .all(folder.id) as Array<{ kb_category: string; n: number }>;
  for (const row of unmapped) {
    if (sectionFolderForCategory(row.kb_category) === null) {
      reasons.push(
        `${row.n} заметок с постоянной категорией «${row.kb_category}» — такого раздела в библиотеке нет, переносить их некуда`,
      );
    }
  }
  return reasons;
}

/** Полный срез по папкам: инвентаризация + вердикт по каждой. */
export function listFolderInventory(): FolderInventoryRow[] {
  const root = getKbRoot();
  const folders = db
    .prepare(
      `SELECT id, parent_id, name, is_kb_root FROM journal_folders
        ORDER BY parent_id IS NULL DESC, parent_id, id`,
    )
    .all() as any[];
  const names = new Map<number, string>(folders.map((f) => [f.id, f.name]));
  const rows: FolderInventoryRow[] = [];
  for (const f of folders) {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN kb_category IS NOT NULL THEN 1 ELSE 0 END) AS categorized,
                SUM(CASE WHEN kb_category IS NULL AND kb_temp_category = ? THEN 1 ELSE 0 END) AS trash,
                SUM(CASE WHEN kb_category IS NULL AND kb_temp_category IS NOT NULL AND kb_temp_category <> ? THEN 1 ELSE 0 END) AS unresolved
           FROM user_notes WHERE folder_id = ?`,
      )
      .get(KB_DROP_MARK, KB_DROP_MARK, f.id) as any;
    const reasons = folderDeleteReasons(f.id);
    rows.push({
      id: f.id,
      name: f.name,
      parent_id: f.parent_id,
      parent_name: f.parent_id ? names.get(f.parent_id) ?? null : null,
      notes_count: counts.total ?? 0,
      children_count: db
        .prepare("SELECT COUNT(*) AS n FROM journal_folders WHERE parent_id = ?")
        .get(f.id).n,
      is_kb_root: f.is_kb_root === 1,
      is_kb_section: !!(root && f.parent_id === root.id && KB_SECTION_NAMES.includes(f.name)),
      under_kb_root: isUnderKbRoot(f.id, root?.id ?? -1),
      task: taskOfFolder(f.id),
      unresolved_notes: counts.unresolved ?? 0,
      categorized_notes: counts.categorized ?? 0,
      trash_notes: counts.trash ?? 0,
      deletable: reasons.length === 0,
      reasons,
    });
  }
  return rows;
}

export interface MovedNote {
  id: string;
  title: string;
  category: string;
  target_folder: string | null;
}

/**
 * Перенос заметок с постоянной категорией из папки в раздел библиотеки.
 * Меняется ТОЛЬКО folder_id: автор и дата правки заметки остаются прежними.
 * Заметки, для которых раздела нет (например, категория «Исследования»),
 * остаются на месте и попадают в отчёт — решение по ним за владельцем.
 */
export function moveCategorizedNotes(folderId: number): { moved: MovedNote[]; left: MovedNote[] } {
  const moved: MovedNote[] = [];
  const left: MovedNote[] = [];
  const notes = db
    .prepare(
      `SELECT id, title, kb_category FROM user_notes
        WHERE folder_id = ? AND kb_category IS NOT NULL`,
    )
    .all(folderId) as any[];
  for (const note of notes) {
    const target = sectionFolderForCategory(note.kb_category);
    if (target === null) {
      left.push({ id: note.id, title: note.title, category: note.kb_category, target_folder: null });
      continue;
    }
    db.prepare("UPDATE user_notes SET folder_id = ? WHERE id = ?").run(target, note.id);
    const name = db
      .prepare("SELECT name FROM journal_folders WHERE id = ?")
      .get(target) as { name: string };
    moved.push({ id: note.id, title: note.title, category: note.kb_category, target_folder: name.name });
  }
  return { moved, left };
}

export interface CleanupCandidate {
  id: number;
  name: string;
  reason: string;
  task: FolderTaskRef | null;
  notes_count: number;
  categorized_notes: number;
}

/**
 * Кандидаты на уборку (шаг карточки 2):
 *   • пустые листовые папки закрытых заданий (нет заметок, нет дочерних
 *     папок, задача закрыта или в архиве);
 *   • папки закрытых заданий с заметками, у которых есть постоянная
 *     категория (их можно перенести в раздел библиотеки, а папку удалить);
 *   • осиротевшие пустые папки (задачи больше нет — как в уборке
 *     17.10.2026).
 * Папки библиотеки и папки живых задач не трогаем.
 */
export function cleanupCandidates(): CleanupCandidate[] {
  const out: CleanupCandidate[] = [];
  for (const row of listFolderInventory()) {
    if (row.is_kb_root || row.is_kb_section || row.under_kb_root) continue;
    if (row.children_count > 0) continue;
    if (row.task && !row.task.closed) continue;
    if (row.unresolved_notes > 0) continue;
    if (row.notes_count === 0) {
      out.push({
        id: row.id,
        name: row.name,
        reason: row.task
          ? `пустая папка задачи «${row.task.title}» (${row.task.state})`
          : "пустая папка, задачи больше нет",
        task: row.task,
        notes_count: 0,
        categorized_notes: 0,
      });
      continue;
    }
    if (row.task && row.task.closed && row.categorized_notes > 0) {
      out.push({
        id: row.id,
        name: row.name,
        reason: `папка закрытой задачи «${row.task.title}» (${row.task.state}), заметки с постоянной категорией переносятся в раздел`,
        task: row.task,
        notes_count: row.notes_count,
        categorized_notes: row.categorized_notes,
      });
    }
  }
  return out;
}

/**
 * Горячий бэкап БД перед уборкой (шаг карточки 2): снимок в
 * server/backups/ с датой в имени. Онлайн-бэкап better-sqlite3 — база
 * не блокируется. Возвращает путь к файлу.
 */
export async function hotBackupDb(prefix = "kb-folder-cleanup"): Promise<string> {
  const dir = path.join(path.dirname(DB_PATH), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `${prefix}-${stamp}.db`);
  await db.backup(file);
  return file;
}
