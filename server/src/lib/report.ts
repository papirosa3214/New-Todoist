import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { UPLOAD_DIR } from "../routes/attachments.js";

// Сборка отчёта: markdown → светлый печатный HTML → PDF (headless Chrome).
// Владелец 20.09.2026: «вид светлый, как положено; отметка когда сделан, кем и
// по какой задаче». Титул и колонтитул несут эти данные. PDF — через Chrome:
// pandoc/weasyprint на сервере нет, а Chrome есть и верстает как браузер.

const execFileAsync = promisify(execFile);
const uid = () => crypto.randomUUID();

export const REPORT_DIR = path.join(UPLOAD_DIR, "reports");
const CHROME = process.env.CHROME_BIN || "google-chrome";

export interface ReportMeta {
  title: string;
  markdown: string;
  taskId: string;
  taskTitle: string;
  author: string;
  date: string;
}

async function markdownToHtml(md: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `tf-md-${uid()}.md`);
  fs.writeFileSync(tmp, md, "utf8");
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [
        "-c",
        "import sys,markdown;sys.stdout.write(markdown.markdown(" +
          "open(sys.argv[1],encoding='utf-8').read()," +
          "extensions=['tables','fenced_code','toc','sane_lists']))",
        tmp,
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
    );
    return stdout;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string),
  );
}

function documentHtml(meta: ReportMeta, bodyHtml: string): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>${esc(meta.title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #17171a; background: #ffffff;
    font: 15px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  .page { max-width: 820px; margin: 0 auto; padding: 48px 40px 64px; }
  .cover { border-bottom: 2px solid #e6e6ea; padding-bottom: 20px; margin-bottom: 28px; }
  .cover h1 { font-size: 28px; line-height: 1.25; margin: 0 0 12px; }
  .meta { color: #6b6b73; font-size: 13px; }
  .meta b { color: #17171a; font-weight: 600; }
  main h1, main h2, main h3 { line-height: 1.3; margin: 28px 0 10px; }
  main h2 { font-size: 21px; border-bottom: 1px solid #ececf0; padding-bottom: 6px; }
  main h3 { font-size: 17px; }
  main p { margin: 10px 0; }
  main ul, main ol { margin: 10px 0 10px 22px; }
  main li { margin: 4px 0; }
  main a { color: #1a5fb4; text-decoration: none; }
  main code { background: #f4f4f6; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  main pre { background: #f6f6f8; border: 1px solid #ececf0; border-radius: 8px; padding: 12px; overflow: auto; }
  main pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 14px; }
  th, td { border: 1px solid #e2e2e8; padding: 7px 10px; text-align: left; }
  th { background: #f6f6f8; }
  blockquote { margin: 12px 0; padding: 6px 16px; border-left: 3px solid #d7d7de; color: #55555e; }
  footer {
    max-width: 820px; margin: 0 auto; padding: 16px 40px 32px;
    border-top: 1px solid #ececf0; color: #8a8a92; font-size: 12px;
  }
  @page { margin: 14mm; }
</style></head>
<body>
  <div class="page">
    <header class="cover">
      <h1>${esc(meta.title)}</h1>
      <div class="meta">
        Задача: <b>${esc(meta.taskTitle)}</b> · ${esc(meta.taskId)}<br>
        Автор: <b>${esc(meta.author)}</b> · Составлен: <b>${esc(meta.date)}</b>
      </div>
    </header>
    <main>${bodyHtml}</main>
  </div>
  <footer>TaskFlow · отчёт по задаче ${esc(meta.taskId)} · ${esc(meta.author)} · ${esc(meta.date)}</footer>
</body></html>`;
}

export async function buildReport(
  meta: ReportMeta,
): Promise<{ id: string; htmlPath: string; pdfPath: string }> {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const id = uid();
  const htmlPath = path.join(REPORT_DIR, `${id}.html`);
  const pdfPath = path.join(REPORT_DIR, `${id}.pdf`);

  const bodyHtml = await markdownToHtml(meta.markdown);
  fs.writeFileSync(htmlPath, documentHtml(meta, bodyHtml), "utf8");

  await execFileAsync(
    CHROME,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );

  if (!fs.existsSync(pdfPath)) throw new Error("Chrome не создал PDF");
  return { id, htmlPath, pdfPath };
}
