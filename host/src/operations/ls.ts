import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWithin } from "../pathSafety.js";
import { type Operation, BadArgsError, NotFoundError } from "./types.js";

export interface LsEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "other";
  size: number;
  mtimeMs: number;
}

export interface LsResult {
  path: string;
  entries: LsEntry[];
}

export const ls: Operation = async (args, context) => {
  const target = resolveWithin(context.roots, typeof args["path"] === "string" && args["path"].trim() ? String(args["path"]) : ".", { label: "ls" });

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") throw new NotFoundError(`путь не найден: ${target}`);
    if (code === "ENOTDIR") throw new BadArgsError(`не папка: ${target}`);
    throw error;
  }

  const entries: LsEntry[] = [];
  // Сначала папки, потом файлы, внутри — по алфавиту: так список читаемый и
  // совпадает между вызовами.
  const sorted = [...dirents].sort((a, b) => {
    const aDir = a.isDirectory();
    const bDir = b.isDirectory();
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  for (const dirent of sorted) {
    const full = path.join(target, dirent.name);
    let size = 0;
    let mtimeMs = 0;
    // stat по каждому элементу дорог на больших папках, но без него роль не
    // видит, какой файл менялся, — а это и есть смысл листинга.
    try {
      const stats = await fs.stat(full);
      size = stats.size;
      mtimeMs = stats.mtimeMs;
    } catch {
      // Элемент мог исчезнуть между чтением папки и stat — пропускаем метки.
    }
    entries.push({
      name: dirent.name,
      path: full,
      type: dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other",
      size,
      mtimeMs,
    });
  }

  return { path: target, entries };
};