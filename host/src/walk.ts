import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Обход папок для grep/find. Скип по умолчанию: без него поиск по /Users/max
 * уходил бы в .git и node_modules и не возвращался минутами.
 */
export const DEFAULT_SKIP_DIRS = [".git", "node_modules", "dist", "build", ".build", "DerivedData", ".next", ".cache", "Library", ".Trash"];

export interface WalkOptions {
  /** Максимальная глубина рекурсии относительно корня. */
  maxDepth?: number;
  /** Максимум отданных записей — предохранитель от бесконечного обхода. */
  maxEntries?: number;
  skipDirs?: readonly string[];
  /** Пропускать папки (по умолчанию true для grep, false для ls/find). */
  includeDirs?: boolean;
  /** Прерваться по этому сигналу. */
  signal?: AbortSignal;
}

export interface WalkEntry {
  path: string;
  type: "file" | "dir";
  depth: number;
}

export interface WalkResult {
  entries: WalkEntry[];
  /** Записи обрезаны потолком maxEntries. */
  truncated: boolean;
  /** Каталоги, где обход упёрся в ошибку чтения (нет прав, битый симлинк). */
  unreadable: string[];
}

export async function walk(root: string, options: WalkOptions = {}): Promise<WalkResult> {
  const skip = new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS);
  const maxDepth = options.maxDepth ?? 12;
  const maxEntries = options.maxEntries ?? 20_000;
  const includeDirs = options.includeDirs ?? false;

  const entries: WalkEntry[] = [];
  const unreadable: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    if (options.signal?.aborted) break;
    const current = queue.shift();
    if (!current) break;
    let listing: Dirent[];
    try {
      listing = await fs.readdir(current.dir, { withFileTypes: true });
    } catch (error) {
      unreadable.push(`${current.dir}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // Сортировка — чтобы результат grep/find был воспроизводимым между вызовами.
    for (const item of listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(current.dir, item.name);
      if (item.isDirectory()) {
        if (skip.has(item.name)) continue;
        if (includeDirs) {
          if (entries.length >= maxEntries) {
            truncated = true;
            break;
          }
          entries.push({ path: full, type: "dir", depth: current.depth + 1 });
        }
        if (current.depth + 1 <= maxDepth) queue.push({ dir: full, depth: current.depth + 1 });
      } else if (item.isFile()) {
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        entries.push({ path: full, type: "file", depth: current.depth + 1 });
      }
      // Симлинки и устройства пропускаем: их мишень лежит снаружи обхода.
    }
    if (truncated) break;
  }

  return { entries, truncated, unreadable };
}

/**
 * Мини-глоб для grep: поддерживает `*`, `?`, `**` и класс `[...]`.
 * Отдельная библиотека ради одного фильтра не нужна, а node:path не умеет
 * ничего из этого.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        // `**/` может съесть и сам сегмент: «**/x» должно матчить и «x».
        if (glob[i + 1] === "/") i += 1;
        out += "(?:[^/]+/)*";
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
        continue;
      }
      out += glob.slice(i, end + 1);
      i = end;
      continue;
    }
    out += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}