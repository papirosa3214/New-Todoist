/**
 * QA-копия: второй живой прогон экрана «Заходы ролей» (/role-runs).
 * Что проверяет:
 *   1. у каких состояний кнопки есть, а у каких — нет (по одному списку);
 *   2. телефонная ширина 420×912: нет горизонтального скролла, кнопки видны;
 *   3. сервер отказывает в отмене (409) — экран показывает понятную ошибку,
 *      а не молча ничего.
 * Запуск: PLAYWRIGHT_BROWSERS_PATH=/home/maksim/.cache/ms-playwright \
 *         node /tmp/qa-roleruns-run-b.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://127.0.0.1:4180";
const OUT = "/tmp/qa-roleruns-run-b";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 420, height: 912 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();

const problems = { console: [], pageerror: [], network: [] };
page.on("console", (m) => {
  if (m.type() === "error") problems.console.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => problems.pageerror.push(String(e.stack || e).slice(0, 400)));
page.on("response", (r) => {
  if (r.status() >= 400) problems.network.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`);
});

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
};

const card = (title) => page.locator(".runs__run").filter({ hasText: title });

await page.goto(`${BASE}/role-runs`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/01-teлефон-до-действий.png`.replace("телефон", "telefon") });

// 1. Кнопки по состояниям.
const expectButtons = async (title, expectedLabel) => {
  const c = card(title);
  const cards = await c.count();
  const buttons = c.locator("button.ui-button");
  const count = await buttons.count();
  const labels = [];
  for (let i = 0; i < count; i += 1) labels.push((await buttons.nth(i).innerText()).trim());
  const ok = cards === 1 && (expectedLabel === null ? count === 0 : count === 1 && labels[0] === expectedLabel);
  check(
    `«${title}»: ${expectedLabel === null ? "кнопок нет" : "кнопка «" + expectedLabel + "»"}`,
    ok,
    `карточек ${cards}, кнопок ${count}${labels.length ? " (" + labels.join(", ") + ")" : ""}`,
  );
};

await expectButtons("QA-копия: запуск в очереди", "Повторить");
await expectButtons("QA-копия: запуск ждёт повтора", "Повторить");
await expectButtons("QA-копия: запуск упал", "Отменить");
await expectButtons("QA-копия: гонка отмены", "Отменить");
await expectButtons("QA-копия: запуск идёт", null);
await expectButtons("QA-копия: запуск готово", null);
await expectButtons("QA-копия: запуск не понадобился", null);

// 2. Раскладка на телефоне.
const layout = await page.evaluate(() => {
  const vw = window.innerWidth;
  const buttons = [...document.querySelectorAll(".runs__run button.ui-button")].map((el) => {
    const r = el.getBoundingClientRect();
    return { text: (el.innerText || "").trim(), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) };
  });
  return {
    vw,
    hscroll: document.documentElement.scrollWidth > vw + 1,
    scrollWidth: document.documentElement.scrollWidth,
    buttons,
  };
});
check("на телефоне нет горизонтального скролла", !layout.hscroll, `ширина страницы ${layout.scrollWidth} при ${layout.vw}`);
check("кнопки действий не обрезаны за краем", layout.buttons.every((b) => b.right <= layout.vw + 1), JSON.stringify(layout.buttons));

// 3. Сервер отказывает в отмене: отменяем заход из другой вкладки и жмём кнопку.
const raceResult = await page.evaluate(async () => {
  const res = await fetch("/api/role-run-jobs/qa-job-race/cancel", { method: "POST" });
  return { status: res.status, body: await res.text() };
});
check("внешняя отмена прошла (состояние подготовлено)", raceResult.status === 200, `HTTP ${raceResult.status} ${raceResult.body.slice(0, 120)}`);

await card("QA-копия: гонка отмены").locator("button.ui-button:has-text(\"Отменить\")").click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/02-teлефон-отказ-сервера.png`.replace("телефон", "telefon") });

const errorVisible = await page.getByText("Заход не изменился").count();
check("экран показал ошибку «Заход не изменился»", errorVisible > 0, `найдено вхождений: ${errorVisible}`);
const errorNote = await page.locator(".runs__error-card").first().innerText().catch(() => "");
check("в ошибке виден ответ сервера", /нельзя отменить/.test(errorNote), errorNote.replace(/\n/g, " | ").slice(0, 160));

const raceStatus = await card("QA-копия: гонка отмены").innerText();
check("карточка осталась в старом состоянии (экран не перерисовался)", /В очереди/.test(raceStatus), raceStatus.replace(/\n/g, " | ").slice(0, 120));

// 4. После обновления состояние честное.
await page.getByRole("button", { name: "Обновить" }).click();
await page.waitForTimeout(1200);
const afterReload = await card("QA-копия: гонка отмены").innerText();
check("после «Обновить» состояние «Отменён»", /Отменён/.test(afterReload), afterReload.replace(/\n/g, " | ").slice(0, 120));
await page.screenshot({ path: `${OUT}/03-telefon-posle-obnovleniya.png` });

const report = { base: BASE, viewport: "420x912@2", checks, problems };
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
await browser.close();
const failed = checks.filter((c) => !c.ok).length;
console.log(`\nПроверок: ${checks.length}, провалено: ${failed}. Ошибок консоли: ${problems.console.length}, pageerror: ${problems.pageerror.length}, ответов ≥400: ${problems.network.length}`);
if (problems.console.length) console.log("console:", problems.console);
if (problems.pageerror.length) console.log("pageerror:", problems.pageerror);
if (problems.network.length) console.log("сеть ≥400:", problems.network);
console.log(`Отчёт: ${OUT}/report.json`);
process.exit(failed ? 1 : 0);
