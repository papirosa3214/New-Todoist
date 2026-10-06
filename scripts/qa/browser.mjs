#!/usr/bin/env node
// Живая проверка для роли QA: проходит сценарий в настоящем браузере и пишет отчёт.
//
//   node scripts/qa/browser.mjs <сценарий.json> [--base URL] [--out КАТАЛОГ]
//        [--engine chromium|webkit] [--viewport 420x912] [--dpr 2]
//
// --base по умолчанию берётся из WEB= последнего `scripts/qa/up.sh` (файл urls), иначе обязателен.
// Сценарий — JSON-массив шагов (один прогон = один браузер, состояние между шагами сохраняется):
//   {"goto": "/today"}                       открыть путь относительно base
//   {"click": "text=Сегодня"}                клик по селектору Playwright (text=…, css, role=…)
//   {"fill": ["input[name=title]", "Тест"]}  ввести текст в поле
//   {"press": "Enter"}                       нажать клавишу
//   {"wait": 500}  |  {"wait": "text=Готово"}  пауза в мс или ожидание элемента
//   {"scroll": 600}                          прокрутить страницу вниз на N px (отрицательное — вверх)
//   {"expect_text": "Задача создана"}        текст должен быть на странице, иначе шаг — дефект
//   {"expect_no_text": "N мин. назад"}       текста быть не должно
//   {"expect_visible": "css-селектор"}       элемент должен быть виден
//   {"snap": "после-создания"}               скриншот + снимок структуры страницы (aria) + видимый текст
// После каждого шага без "snap" скриншот не делается; в конце всегда делается финальный.
// Каждый шаг может нести "note" — человеческое описание, попадёт в отчёт.
//
// Выход: КАТАЛОГ/report.json и report.md (читать report.md), скриншоты PNG рядом.
// Код возврата: 0 — все шаги прошли и в консоли нет ошибок; 1 — есть упавшие шаги или ошибки страницы.
import { chromium, webkit } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const scenarioFile = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
if (!scenarioFile) {
  console.error("Нужен файл сценария: node scripts/qa/browser.mjs сценарий.json");
  process.exit(2);
}

function defaultBase() {
  const root = path.join(os.homedir(), ".local/state/taskflow-qa");
  try {
    const found = fs.readdirSync(root)
      .map((d) => path.join(root, d, "urls"))
      .filter((f) => fs.existsSync(f))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    const m = found && fs.readFileSync(found.f, "utf8").match(/^WEB=(.+)$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const base = (flag("base", defaultBase()) ?? "").replace(/\/$/, "");
if (!base) {
  console.error("Не знаю адрес приложения: сначала scripts/qa/up.sh или укажи --base");
  process.exit(2);
}
const out = path.resolve(flag("out", `qa-report-${new Date().toISOString().replace(/[:.]/g, "-")}`));
fs.mkdirSync(out, { recursive: true });
const [w, h] = flag("viewport", "420x912").split("x").map(Number);
const dpr = Number(flag("dpr", "2"));
const engine = flag("engine", "chromium") === "webkit" ? webkit : chromium;
const steps = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));

const browser = await engine.launch();
const context = await browser.newContext({
  viewport: { width: w, height: h },
  deviceScaleFactor: dpr,
  isMobile: true,
  hasTouch: true,
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

const problems = { console: [], pageerror: [], network: [] };
page.on("console", (m) => {
  if (m.type() === "error") problems.console.push(m.text().slice(0, 400));
});
page.on("pageerror", (e) => problems.pageerror.push(String(e.stack || e).slice(0, 600)));
page.on("response", (r) => {
  if (r.status() >= 400) problems.network.push(`${r.status()} ${r.request().method()} ${r.url().replace(base, "")}`);
});

const results = [];
let shot = 0;
async function snap(label) {
  const name = `${String(++shot).padStart(2, "0")}-${label.replace(/[^\p{L}\p{N}_-]+/gu, "_")}`;
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  let aria = "";
  try { aria = await page.locator("body").ariaSnapshot(); } catch { /* страница могла уйти */ }
  const text = (await page.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 4000);
  return { file: path.basename(file), aria: aria.slice(0, 6000), text };
}

let failed = 0;
for (const [i, step] of steps.entries()) {
  const [kind] = Object.keys(step).filter((k) => k !== "note");
  const arg = step[kind];
  const rec = { n: i + 1, step: kind, arg, note: step.note ?? "", ok: true };
  try {
    switch (kind) {
      case "goto": await page.goto(base + arg, { waitUntil: "networkidle", timeout: 30000 }); break;
      case "click": await page.click(arg, { timeout: 8000 }); break;
      case "fill": await page.fill(arg[0], arg[1], { timeout: 8000 }); break;
      case "press": await page.keyboard.press(arg); break;
      case "wait":
        if (typeof arg === "number") await page.waitForTimeout(arg);
        else await page.waitForSelector(arg, { timeout: 10000 });
        break;
      case "scroll": await page.mouse.wheel(0, arg); await page.waitForTimeout(250); break;
      case "expect_text": await page.getByText(arg, { exact: false }).first().waitFor({ state: "visible", timeout: 6000 }); break;
      case "expect_no_text": {
        const found = await page.getByText(arg, { exact: false }).count();
        if (found) throw new Error(`текст «${arg}» найден на странице (${found})`);
        break;
      }
      case "expect_visible": await page.locator(arg).first().waitFor({ state: "visible", timeout: 6000 }); break;
      case "snap": Object.assign(rec, await snap(String(arg))); break;
      default: throw new Error(`неизвестный шаг «${kind}»`);
    }
  } catch (e) {
    rec.ok = false;
    rec.error = String(e.message || e).split("\n")[0].slice(0, 300);
    failed++;
    // Упавший шаг всегда фиксируем кадром — по нему видно, что было на экране.
    Object.assign(rec, await snap(`ошибка-шаг-${i + 1}`).catch(() => ({})));
  }
  results.push(rec);
}
const final = await snap("финал");
await browser.close();

const noisy = problems.console.length + problems.pageerror.length;
const report = { base, viewport: `${w}x${h}@${dpr}`, engine: flag("engine", "chromium"), failed_steps: failed, problems, steps: results, final };
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));

const md = [
  `# Отчёт живой проверки`,
  `Приложение: ${base} · экран ${w}×${h}@${dpr} · ${report.engine}`,
  `Шагов: ${results.length}, упало: ${failed}. Ошибок консоли: ${problems.console.length}, pageerror: ${problems.pageerror.length}, ответов ≥400: ${problems.network.length}.`,
  ``,
  ...results.map((r) => `${r.ok ? "✅" : "❌"} ${r.n}. ${r.step} ${JSON.stringify(r.arg)}${r.note ? ` — ${r.note}` : ""}${r.error ? `\n   ошибка: ${r.error}` : ""}${r.file ? `\n   кадр: ${r.file}` : ""}`),
  ``,
  `## Ошибки страницы`,
  ...(problems.pageerror.length ? problems.pageerror.map((e) => `- pageerror: ${e}`) : ["- pageerror: нет"]),
  ...(problems.console.length ? problems.console.map((e) => `- console.error: ${e}`) : ["- console.error: нет"]),
  ...(problems.network.length ? problems.network.map((e) => `- сеть: ${e}`) : ["- сеть ≥400: нет"]),
  ``,
  `## Финальный экран (${final.file})`,
  "```",
  final.text.slice(0, 1500),
  "```",
].join("\n");
fs.writeFileSync(path.join(out, "report.md"), md);
console.log(md);
console.log(`\nОтчёт и кадры: ${out}`);
process.exit(failed || noisy ? 1 : 0);
