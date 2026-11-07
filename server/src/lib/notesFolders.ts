/** Утилиты для папок `journal_folders`, связанные с TaskFlow Library.
 *
 * `is_kb_root=1` — пометка корневой папки «TaskFlow Library» (миграция
 * `119_kb_root_folder`, 08.10.2026). Под этой папкой живут 4 подпапки
 * (Roles, Workflows, Norms, Knowledge Base) — именно их роли читают
 * через `taskflow_kb_search` и туда сами пишут через `taskflow_doc_write`.
 *
 * Здесь собраны чистые хелперы: запрос факта и пути. Никаких побочных
 * эффектов и операций записи — это библиотечная функция, а не API.
 */
import type Database from "better-sqlite3";
import db from "../db.js";

export interface FolderRow {
  id: number;
  parent_id: number | null;
  name: string;
  position: number;
  is_kb_root: number;
}

// Prepared statements — ленивые. На module-level таблица journal_folders
// может ещё не быть создана (тесты вызывают migrate()/runMigrations() после
// импорта модуля). Подготовка запроса триггерится при первом обращении.
let rootStmt: Database.Statement | null = null;
let folderStmt: Database.Statement | null = null;

function stmtsReady() {
  if (!rootStmt) {
    rootStmt = db.prepare(
      "SELECT id, parent_id, name, position, is_kb_root FROM journal_folders WHERE is_kb_root = 1 LIMIT 1",
    );
  }
  if (!folderStmt) {
    folderStmt = db.prepare(
      "SELECT id, parent_id, name, position, is_kb_root FROM journal_folders WHERE id = ?",
    );
  }
  return { rootStmt, folderStmt };
}

/** Корневая папка Library. Если её нет (bootstrap не прогоняли) — null. */
export function getKbRoot(): FolderRow | null {
  return (stmtsReady().rootStmt.get() as FolderRow | undefined) ?? null;
}

/** Сама ли эта папка корневой? (id должен быть id корня Library). */
export function isKbRoot(folderId: number | null): boolean {
  if (folderId === null) return false;
  const row = stmtsReady().folderStmt.get(folderId) as FolderRow | undefined;
  return !!row && row.is_kb_root === 1;
}

/** Заметка/папка лежит ГДЕ-ТО под корнем Library (включая сам корень).
 *  Поднимается по parent_id до корня или до NULL. Зацикливание невозможно:
 *  у каждой папки parent_id ведёт выше (корневая имеет parent_id=NULL). */
export function isUnderKbRoot(folderId: number | null): boolean {
  if (folderId === null) return false;
  const root = getKbRoot();
  if (!root) return false;
  const stmt = stmtsReady().folderStmt;
  let id: number | null = folderId;
  const seen = new Set<number>();
  while (id !== null) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (id === root.id) return true;
    const row = stmt.get(id) as FolderRow | undefined;
    if (!row) return false;
    id = row.parent_id;
  }
  return false;
}

/** Путь от корня Library до папки (включая саму папку), как массив имён.
 *  Корень — первый элемент. Если папка не под Library — пустой массив. */
export function pathToFolder(folderId: number): string[] {
  const root = getKbRoot();
  if (!root) return [];
  const stmt = stmtsReady().folderStmt;
  const names: string[] = [];
  let id: number | null = folderId;
  const seen = new Set<number>();
  while (id !== null) {
    if (seen.has(id)) return [];
    seen.add(id);
    const row = stmt.get(id) as FolderRow | undefined;
    if (!row) return [];
    names.unshift(row.name);
    if (id === root.id) return names;
    id = row.parent_id;
  }
  return [];
}

/** Путь заметки от корня Library через её folder_id.
 *  Если у заметки folder_id нет или он не под Library — пустой массив. */
export function notePathToKbRoot(folderId: number | null): string[] {
  if (folderId === null) return [];
  return pathToFolder(folderId);
}