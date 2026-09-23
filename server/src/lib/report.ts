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
//
// Владелец 21.09.2026: «инструменты именно для написания отчётов — качественные
// таблицы, графики». Поэтому кроме markdown отчёт умеет:
//   • ```mermaid  — схемы/диаграммы (блок-схемы, последовательности, гант, pie);
//   • ```chart    — графики из данных в формате Vega-Lite (JSON-спека);
// всё рендерит сам браузер локальными библиотеками (assets/report/*.js), без
// интернета и без внешних сервисов. Таблицы у markdown уже умеются —
// под них доработана печатная вёрстка (шапка, зебра, рамки).

const execFileAsync = promisify(execFile);
const uid = () => crypto.randomUUID();

export const REPORT_DIR = path.join(UPLOAD_DIR, "reports");
const CHROME = process.env.CHROME_BIN || "google-chrome";

/** Локальные JS-библиотеки отчёта (mermaid + vega-lite), вендорены в репозиторий. */
const REPORT_ASSETS = path.resolve(import.meta.dirname, "../../assets/report");
const REPORT_LIBS = [
  "mermaid.min.js",
  "vega.min.js",
  "vega-lite.min.js",
  "vega-embed.min.js",
];

/** Собрать библиотеки ВНУТРЬ html: страница скачивается и открывается где
 *  угодно (в приложении, из письма, локально), без рядом лежащих файлов и без
 *  интернета. Иначе HTML ссылался бы на соседние .js, которых по URL нет, и
 *  схемы/графики не рисовались бы. `</script` внутри кода экранируем, иначе
 *  HTML-парсер оборвёт скрипт. */
function inlineReportLibs(): string {
  const parts: string[] = [];
  for (const name of REPORT_LIBS) {
    try {
      const code = fs.readFileSync(path.join(REPORT_ASSETS, name), "utf8");
      parts.push(
        "<script>" +
          code.replace(/<\/script/gi, "<\\/script") +
          "</script>",
      );
    } catch {
      // библиотеки нет — графики не нарисуются, сам отчёт не рушим
    }
  }
  return parts.join("\n");
}

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

function documentHtml(meta: ReportMeta, bodyHtml: string, libs: string): string {
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
  th, td { border: 1px solid #e2e2e8; padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f1f2f5; font-weight: 600; }
  tbody tr:nth-child(even) { background: #fafafc; }
  main .mermaid, main .chart { margin: 16px 0; text-align: center; }
  main .chart svg, main .mermaid svg { max-width: 100%; height: auto; }
  main figure { margin: 16px 0; }
  main figcaption { color: #8a8a92; font-size: 12px; text-align: center; margin-top: 6px; }
  .chart-error, .mermaid-error { color: #b23; font-size: 13px; text-align: left; }
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
${libs}
  <script>
    // Блоки mermaid → живые схемы, блоки chart/vega-lite → графики.
    // Рендер асинхронный; Chrome печатает PDF с --virtual-time-budget, поэтому
    // успевает дождаться, пока mermaid/vega отрисуются (см. buildReport).
    (function () {
      function blocks(sel) {
        return Array.prototype.slice.call(document.querySelectorAll(sel));
      }
      // mermaid
      try {
        if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: "neutral" });
      } catch (e) {}
      blocks("pre > code.language-mermaid").forEach(function (code) {
        var div = document.createElement("div");
        div.className = "mermaid";
        div.textContent = code.textContent;
        code.parentElement.replaceWith(div);
      });
      if (window.mermaid) {
        try { mermaid.run({ querySelector: ".mermaid" }); } catch (e) {}
      }
      // vega-lite / vega
      blocks(
        "pre > code.language-chart, pre > code.language-vega-lite, pre > code.language-vega"
      ).forEach(function (code) {
        var div = document.createElement("div");
        div.className = "chart";
        code.parentElement.replaceWith(div);
        var spec;
        try {
          spec = JSON.parse(code.textContent);
        } catch (e) {
          div.className = "chart-error";
          div.textContent = "Ошибка в данных графика (не JSON): " + e;
          return;
        }
        if (window.vegaEmbed) {
          vegaEmbed(div, spec, { actions: false, renderer: "svg" }).catch(function (e) {
            div.className = "chart-error";
            div.textContent = "Ошибка графика: " + e;
          });
        }
      });
    })();
  </script>
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
  fs.writeFileSync(
    htmlPath,
    documentHtml(meta, bodyHtml, inlineReportLibs()),
    "utf8",
  );

  await execFileAsync(
    CHROME,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--no-pdf-header-footer",
      // Ждём, пока страница досчитает JS (mermaid/vega) перед печатью PDF:
      // без этого графики и схемы не успевают отрисоваться.
      "--virtual-time-budget=15000",
      "--allow-file-access-from-files",
      "--hide-scrollbars",
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ],
    { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
  );

  if (!fs.existsSync(pdfPath)) throw new Error("Chrome не создал PDF");
  return { id, htmlPath, pdfPath };
}
