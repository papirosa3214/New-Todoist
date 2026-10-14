import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWithin } from "../pathSafety.js";
import { BadArgsError, type Operation, LimitError, requireString } from "./types.js";

export interface WriteResult {
  path: string;
  bytes: number;
  /** Файла раньше не было — роль знает, что это создание, а не правка. */
  created: boolean;
  /** Родительскую папку пришлось создать. */
  createdDirs: string[];
}

export const write: Operation = async (args, context) => {
  const target = resolveWithin(context.roots, requireString(args, "path"), { label: "write" });
  const content = args["content"];
  if (typeof content !== "string") throw new BadArgsError("«content» обязателен и должен быть строкой");
  if (content.length > context.limits.bashOutputLimitBytes) {
    throw new LimitError(`содержимое больше ${context.limits.bashOutputLimitBytes} байт — файл не записан`);
  }

  const createdDirs: string[] = [];
  const parent = path.dirname(target);
  // Роль пишет в новую ветку и не хочет вручную mkdir -p перед каждым файлом.
  for (const dir of missingDirs(parent)) createdDirs.push(dir);
  if (createdDirs.length > 0) await fs.mkdir(parent, { recursive: true });

  const existed = await exists(target);
  // Пишем во временный файл рядом и переименовываем: обрыв связи на середине
  // не должен оставить файл, в котором половина нового и половина старого.
  const temporary = path.join(parent, `.${path.basename(target)}.taskflow-${process.pid}.tmp`);
  try {
    await fs.writeFile(temporary, content, "utf8");
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  return { path: target, bytes: Buffer.byteLength(content, "utf8"), created: !existed, createdDirs };
};

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Какие папки до parent ещё не созданы — от самой глубокой к корню. */
function missingDirs(parent: string): string[] {
  const missing: string[] = [];
  let current = parent;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    if (existsSync(current)) break;
    missing.push(current);
    const up = path.dirname(current);
    if (up === current) break;
    current = up;
  }
  return missing.reverse();
}