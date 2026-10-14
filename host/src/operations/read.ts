import fs from "node:fs/promises";
import { resolveWithin } from "../pathSafety.js";
import { BadArgsError, type Operation, NotFoundError, optionalNumber, requireString } from "./types.js";

export interface ReadResult {
  path: string;
  content: string;
  /** Нумерация строк с 1, как у инструмента read у ролей. */
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  bytes: number;
  eol: "\n" | "\r\n";
}

/** Строк за один вызов: роль читает кусками, целиком никто не просит. */
const MAX_LINES = 2000;

export const read: Operation = async (args, context) => {
  const target = resolveWithin(context.roots, requireString(args, "path"), { label: "read" });
  const startLine = Math.max(1, Math.floor(optionalNumber(args, "offset", 1, { min: 1 })));
  const limit = Math.floor(optionalNumber(args, "limit", MAX_LINES, { min: 1, max: MAX_LINES }));

  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") throw new NotFoundError(`файл не найден: ${target}`);
    if (code === "EISDIR") throw new BadArgsError(`это папка, а не файл: ${target}`);
    throw error;
  }

  // Двоичный файл в строку превращается в мусор, который роль потом diff-ит.
  if (raw.includes("\u0000")) throw new BadArgsError(`похоже на двоичный файл, читать нечего: ${target}`);
  if (raw.length > context.limits.bashOutputLimitBytes) {
    throw new BadArgsError(`файл больше ${context.limits.bashOutputLimitBytes} байт — читай его частями через bash`);
  }

  const eol: "\n" | "\r\n" = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(eol);
  // Файл, оканчивающийся переводом строки, даёт лишнюю пустую строку в конце.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const slice = lines.slice(startLine - 1, startLine - 1 + limit);

  return {
    path: target,
    content: slice.join(eol),
    startLine,
    endLine: slice.length > 0 ? startLine + slice.length - 1 : startLine - 1,
    totalLines,
    truncated: startLine - 1 + limit < totalLines,
    bytes: Buffer.byteLength(raw, "utf8"),
    eol,
  };
};