import fs from "node:fs/promises";
import { rename } from "node:fs/promises";
import { resolveWithin } from "../pathSafety.js";
import { BadArgsError, type Operation, NotFoundError, optionalBoolean, requireString } from "./types.js";

export interface EditResult {
  path: string;
  /** Сколько фрагментов заменено. */
  occurrences: number;
  bytes: number;
}

export const edit: Operation = async (args, context) => {
  const target = resolveWithin(context.roots, requireString(args, "path"), { label: "edit" });
  const oldText = requireString(args, "oldText");
  const newText = requireString(args, "newText");
  const replaceAll = optionalBoolean(args, "replaceAll", false);
  if (oldText === newText) throw new BadArgsError("oldText и newText совпадают — правки не будет");

  let content: string;
  try {
    content = await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") throw new NotFoundError(`файл не найден: ${target}`);
    throw error;
  }

  const occurrences = countOccurrences(content, oldText);
  if (occurrences === 0) {
    throw new NotFoundError(`в файле нет такого фрагмента: ${target}. Прочитай файл и сверь текст — заменять нечего`);
  }
  if (occurrences > 1 && !replaceAll) {
    // Молчаливый выбор первого вхождения — источник правок не там, где думает роль.
    throw new BadArgsError(`фрагмент встречается ${occurrences} раза в ${target} — уточни правку или поставь replaceAll`);
  }

  const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
  const temporary = `${target}.taskflow-${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, updated, "utf8");
    await rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  return { path: target, occurrences: replaceAll ? occurrences : 1, bytes: Buffer.byteLength(updated, "utf8") };
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}