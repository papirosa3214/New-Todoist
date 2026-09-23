// Извлечение ТЕКСТА из вложения — материал для локальной модели, которая
// нарезает из него задачи (просьба владельца 20.09.2026: большой текст
// приложить файлом в чат, а задачи пусть соберёт локальная модель).
//
// Кто что умеет на .110 (проверено):
//   txt / md          — читаем как есть;
//   pdf               — `pdftotext` (poppler);
//   doc/docx/odt/odf  — `libreoffice --headless --convert-to txt`.
//
// Картинки здесь НЕ распознаём: vision-модели в Ollama нет, а тащить OCR на
// сервер незачем — на телефоне их читает Apple Vision до отправки.
//
// Безопасность: имена и аргументы передаём ЧЕРЕЗ execFile (массивами), без
// shell — пользовательское имя файла в команду не подставляется. Файл берём
// ТОЛЬКО по stored_name (случайный UUID), не по присланному имени.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** Потолок текста, который отдаём модели: 16k-контекст, больше не влезет. */
const MAX_OUT = 24_000;

function clamp(text: string): string {
  const t = text.replace(/\u0000/g, "").trim();
  return t.length > MAX_OUT ? t.slice(0, MAX_OUT) : t;
}

export class AttachmentTextError extends Error {}

const WORD_MIME = [
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.oasis.opendocument",
];

export async function extractAttachmentText(
  filePath: string,
  mime: string,
): Promise<string> {
  const m = (mime || "").toLowerCase();

  if (m === "text/plain" || m === "text/markdown") {
    return clamp(fs.readFileSync(filePath, "utf8"));
  }

  if (m === "application/pdf") {
    try {
      const { stdout } = await execFileAsync(
        "pdftotext",
        ["-layout", filePath, "-"],
        { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
      );
      return clamp(stdout);
    } catch (e) {
      throw new AttachmentTextError(
        `pdftotext не осилил файл: ${(e as Error).message}`,
      );
    }
  }

  if (WORD_MIME.some((prefix) => m.startsWith(prefix))) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "att-txt-"));
    try {
      await execFileAsync(
        "soffice",
        ["--headless", "--convert-to", "txt:Text", "--outdir", dir, filePath],
        { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
      );
      const base = path.basename(filePath).replace(/\.[^.]+$/, "") + ".txt";
      const out = path.join(dir, base);
      if (!fs.existsSync(out)) {
        throw new AttachmentTextError("libreoffice не создал текстовый файл");
      }
      return clamp(fs.readFileSync(out, "utf8"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  throw new AttachmentTextError(`из ${mime} текст вытащить не умею`);
}
