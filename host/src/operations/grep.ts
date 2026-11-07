import fs from "node:fs/promises";
import path from "node:path";
import { resolveWithin } from "../pathSafety.js";
import { DEFAULT_SKIP_DIRS, globToRegExp, walk } from "../walk.js";
import { BadArgsError, type Operation, optionalBoolean, optionalNumber, optionalString, requireString } from "./types.js";

export interface GrepMatch {
  path: string;
  /** Номер строки с 1. */
  line: number;
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  /** Совпадений больше потолка — поиск остановлен. */
  truncated: boolean;
  filesScanned: number;
  /** Папки, где не смогли прочитать (нет прав) — чтобы молчание не выглядело как «не нашлось». */
  unreadable: string[];
}

const MAX_MATCHES = 2_000;

export const grep: Operation = async (args, context) => {
  const pattern = requireString(args, "pattern");
  const root = resolveWithin(context.roots, optionalString(args, "path") ?? context.roots[0] ?? ".", { label: "grep" });
  const ignoreCase = optionalBoolean(args, "ignoreCase", false);
  const glob = optionalString(args, "glob");
  const maxMatches = Math.floor(optionalNumber(args, "maxMatches", MAX_MATCHES, { min: 1, max: MAX_MATCHES }));
  const skipDirs = Array.isArray(args["skipDirs"])
    ? (args["skipDirs"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [...DEFAULT_SKIP_DIRS];

  let regexp: RegExp;
  try {
    regexp = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (error) {
    throw new BadArgsError(`«${pattern}» не разобралось как регулярное выражение: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fileFilter = glob ? globToRegExp(glob) : null;

  const found: GrepMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  const walkResult = await walk(root, {
    maxEntries: 200_000,
    signal: context.signal,
    skipDirs,
    includeDirs: false,
  });

  for (const entry of walkResult.entries) {
    if (context.signal.aborted) break;
    // Маска сравнивается и с полным путём, и с путём относительно корня поиска:
    // «*.swift» и «**/*.swift» должны работать одинаково, а не требовать от роли
    // знать, где именно лежит корень.
    if (fileFilter && !fileFilter.test(entry.path) && !fileFilter.test(path.relative(root, entry.path))) continue;
    filesScanned += 1;
    let content: string;
    try {
      content = await fs.readFile(entry.path, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!regexp.test(lines[i]!)) continue;
      found.push({ path: entry.path, line: i + 1, text: lines[i]!.slice(0, 500) });
      if (found.length >= maxMatches) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return { matches: found, truncated, filesScanned, unreadable: walkResult.unreadable };
};