// Файл от роли в чат (владелец 14.10.2026: «прошу прикрепить документ —
// а роль присылает неактивные ссылки»). Раньше у роли не было способа
// положить файл в чат вообще: только текст, и ссылки она выдумывала.
//
// Роль отдаёт содержимое и формат, сервер собирает файл и кладёт его
// вложением тем же путём, что и загрузка владельца (saveUploadedFile —
// те же проверки размера, типа и имени). Текстовые форматы пишутся как
// есть; PDF/Word/ODT собираются LibreOffice из Markdown (через HTML),
// Excel/ODS — LibreOffice из CSV. LibreOffice стоит на .110 (/usr/bin/soffice).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const CHAT_FILE_FORMATS = ["md", "txt", "csv", "json", "html", "pdf", "docx", "odt", "xlsx", "ods"] as const;
export type ChatFileFormat = (typeof CHAT_FILE_FORMATS)[number];

const MIME: Record<ChatFileFormat, string> = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};

export class ChatFileError extends Error {}

/** Имя файла с нужным расширением: роль может прислать «отчёт» или «отчёт.md». */
export function chatFileName(name: string, format: ChatFileFormat): string {
  const base = path.basename(String(name || "").trim()).replace(/\.[^.]{1,8}$/, "") || "документ";
  return `${base.slice(0, 180)}.${format}`;
}

/** Markdown → HTML питоновским `markdown` (стоит на .110), с таблицами. */
async function markdownToHtml(md: string, dir: string): Promise<string> {
  const src = path.join(dir, "in.md");
  fs.writeFileSync(src, md);
  const { stdout } = await run("python3", ["-I", "-c",
    "import sys,markdown;print(markdown.markdown(open(sys.argv[1],encoding='utf-8').read(),extensions=['tables','fenced_code','sane_lists']))",
    src], { maxBuffer: 32 * 1024 * 1024 });
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:'Liberation Sans',Arial,sans-serif;font-size:11pt;line-height:1.4}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}pre,code{font-family:'Liberation Mono',monospace}</style></head><body>${stdout}</body></html>`;
}

async function soffice(input: string, target: string, dir: string, infilter?: string): Promise<Buffer> {
  const args = ["--headless", `-env:UserInstallation=file://${path.join(dir, "profile")}`];
  if (infilter) args.push(`--infilter=${infilter}`);
  args.push("--convert-to", target, "--outdir", path.join(dir, "out"), input);
  await run("soffice", args, { timeout: 120_000 });
  const out = fs.readdirSync(path.join(dir, "out"))[0];
  if (!out) throw new ChatFileError(`LibreOffice не собрал ${target}`);
  return fs.readFileSync(path.join(dir, "out", out));
}

/** Собрать байты файла нужного формата из содержимого роли. */
export async function buildChatFile(content: string, format: ChatFileFormat): Promise<{ body: Buffer; mime: string }> {
  if (!CHAT_FILE_FORMATS.includes(format)) throw new ChatFileError(`неизвестный формат: ${format}`);
  if (!String(content ?? "").trim()) throw new ChatFileError("пустое содержимое");
  const mime = MIME[format];
  if (["md", "txt", "csv", "json", "html"].includes(format)) return { body: Buffer.from(content, "utf8"), mime };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-chatfile-"));
  try {
    if (format === "xlsx" || format === "ods") {
      const src = path.join(dir, "table.csv");
      fs.writeFileSync(src, content);
      // 44 — запятая, 34 — кавычка, 76 — UTF-8.
      return { body: await soffice(src, format, dir, "CSV:44,34,76,1"), mime };
    }
    const src = path.join(dir, "doc.html");
    fs.writeFileSync(src, await markdownToHtml(content, dir));
    const target = format === "pdf" ? "pdf:writer_web_pdf_Export" : format === "docx" ? "docx:MS Word 2007 XML" : "odt";
    return { body: await soffice(src, target, dir), mime };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
