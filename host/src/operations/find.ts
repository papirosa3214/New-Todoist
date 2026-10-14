import { resolveWithin } from "../pathSafety.js";
import { DEFAULT_SKIP_DIRS, walk } from "../walk.js";
import { BadArgsError, type Operation, optionalNumber, optionalString } from "./types.js";

export interface FindEntry {
  path: string;
  type: "file" | "dir";
}

export interface FindResult {
  entries: FindEntry[];
  truncated: boolean;
  unreadable: string[];
}

const MAX_ENTRIES = 5_000;

export const find: Operation = async (args, context) => {
  const root = resolveWithin(context.roots, optionalString(args, "path") ?? context.roots[0] ?? ".", { label: "find" });
  // Подстрока, а не регулярка: роль ищет «TaskFlow», а не «Task.*Flow».
  const pattern = optionalString(args, "pattern");
  const type = optionalString(args, "type");
  if (type !== undefined && type !== "file" && type !== "dir") throw new BadArgsError("«type» может быть file или dir");
  const maxDepth = Math.floor(optionalNumber(args, "maxDepth", 12, { min: 1, max: 30 }));
  const limit = Math.floor(optionalNumber(args, "limit", MAX_ENTRIES, { min: 1, max: MAX_ENTRIES }));
  const skipDirs = Array.isArray(args["skipDirs"])
    ? (args["skipDirs"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [...DEFAULT_SKIP_DIRS];

  const walkResult = await walk(root, {
    maxDepth,
    maxEntries: limit,
    signal: context.signal,
    skipDirs,
    includeDirs: type === "dir",
  });

  let entries = walkResult.entries.map(({ path, type: entryType }) => ({ path, type: entryType }));
  if (type) entries = entries.filter((entry) => entry.type === type);
  // Сама папка поиска в выдачу не попадает: роль зовёт find по корню и не хочет
  // видеть в ответе собственную точку входа.
  const entriesWithoutRoot = entries.filter((entry) => entry.path !== root);

  return {
    entries: entriesWithoutRoot,
    truncated: walkResult.truncated || entriesWithoutRoot.length >= limit,
    unreadable: walkResult.unreadable,
  };
};