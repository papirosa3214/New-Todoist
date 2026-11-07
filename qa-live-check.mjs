// Живая проверка дефектов карточки 38ca01ac (шаг builder_fix_8f38bbe2):
//   1) клик МЫШЬЮ по дню в календаре срока выбирает дату;
//   2) /upcoming и /today на ширине 420 открываются без экрана ошибки.
//
// node /tmp/live-check.mjs --base https://192.168.1.110:5180 --engine chromium|webkit
import { chromium, webkit } from "playwright";
import fs from "node:fs";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const base = flag("base", "https://192.168.1.110:5180");
const engine = flag("engine", "chromium");
const outDir = flag("out", "/tmp/live-check-out");
fs.mkdirSync(outDir, { recursive: true });

const browserType = engine === "webkit" ? webkit : chromium;
const res = { engine, base, steps: [], consoleErrors: [], ok: true };

const browser = await browserType.launch();
const ctx = await browser.newContext({
  viewport: { width: 420, height: 912 },
  deviceScaleFactor: 2,
  ignoreHTTPSErrors: true,
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
});
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") res.consoleErrors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => res.consoleErrors.push("pageerror: " + String(e).slice(0, 300)));

async function step(name, fn) {
  try {
    const value = await fn();
    res.steps.push({ name, status: "passed", value });
  } catch (e) {
    res.steps.push({ name, status: "failed", error: String(e).slice(0, 400) });
    res.ok = false;
  }
}

// ── 1. календарь срока: клик мышью по дню ───────────────────────────────
await step("open-form", async () => {
  await page.goto(base + "/task/new", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const body = await page.textContent("body");
  if (/Что-то пошло не так/.test(body || "")) throw new Error("экран ошибки на форме задачи");
  if (!/Срок/.test(body || "")) throw new Error("нет поля «Срок» на форме");
  return "форма задачи открыта, поле «Срок» есть";
});

await step("open-calendar", async () => {
  const label = page.locator("span.tf-body").filter({ hasText: /^Срок/ }).first();
  await label.waitFor({ state: "visible", timeout: 8000 });
  await label.click();
  await page.waitForTimeout(500);
  const btn = await page.evaluate(() => {
    const s = [...document.querySelectorAll("span.tf-body")].find((x) => /^Срок/.test(x.textContent?.trim() || ""));
    return s?.closest("button")?.textContent?.trim() ?? null;
  });
  return { rowValueBefore: btn };
});

await step("click-day-with-mouse", async () => {
  const day = page.locator("div.grid.grid-cols-7 button").filter({ hasText: /^\d{1,2}$/ }).nth(14);
  await day.waitFor({ state: "visible", timeout: 8000 });
  const text = (await day.textContent())?.trim();
  const box = await day.boundingBox();
  if (!box) throw new Error("нет геометрии кнопки дня");
  // Именно мышь: без hasTouch, pointerType === "mouse"
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  const row = await page.evaluate(() => {
    const s = [...document.querySelectorAll("span.tf-body")].find((x) => /^Срок/.test(x.textContent?.trim() || ""));
    return s?.closest("button")?.textContent?.trim() ?? null;
  });
  if (!row) throw new Error("поле «Срок» не найдено после клика");
  if (/Не установлен/.test(row)) throw new Error(`клик мышью по дню ${text} не выбрал дату: «${row}»`);
  return { clickedDay: text, rowValueAfter: row };
});

await page.screenshot({ path: `${outDir}/${engine}-due.png`, fullPage: false });

// ── 2. экраны «Планирование» и «Сегодня» на ширине 420 ──────────────────
for (const [name, path] of [["upcoming", "/upcoming"], ["today", "/today"]]) {
  await step(`screen-${name}`, async () => {
    await page.goto(base + path, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const body = (await page.textContent("body")) || "";
    if (/Что-то пошло не так/.test(body)) throw new Error("экран ошибки «Что-то пошло не так»");
    if (/MarkdownInline is not defined/.test(body)) throw new Error("MarkdownInline is not defined");
    await page.screenshot({ path: `${outDir}/${engine}-${name}.png` });
    return body.slice(0, 120).replace(/\s+/g, " ");
  });
}

res.consoleErrors = res.consoleErrors.slice(0, 10);
fs.writeFileSync(`${outDir}/${engine}.json`, JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
await browser.close();
process.exit(res.ok ? 0 : 1);
