// QA-проверка MAK-69 fix1: кнопки «Прервать шаг», «Сбросить попытку», «Отменить задание»
// в DOM владельца. Базовый URL = QA-стенд 127.0.0.1:5191 (vite проксирует
// на бэкенд 127.0.0.1:3091). Авторизация LAN (User-Agent: Mozilla/5.0).
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = "/tmp/qa-mak69-fix1/shots";
const BASE = "https://127.0.0.1:5191";
const TASK_ID = "t-qa1";

// Мини-persist стора, чтобы App.tsx поставил светлую тему и грузил
// реальные данные владельца.
const LIGHT_PERSIST = {
  state: {
    settings: { theme: "light", calendarView: "month" },
    taskLayout: { inbox: "list", today: "list" },
    upcomingLayout: "list",
    collapsedInboxProjects: {},
    plannerVisibleProjects: {},
  },
  version: 4,
};

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ["--ignore-certificate-errors"],
  });
  const context = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript((persist) => {
    localStorage.setItem("taskflow-ui", JSON.stringify(persist));
  }, LIGHT_PERSIST);

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });

  // Сначала главная (триггерит /auth/lan)
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  // Теперь карточка задачи
  await page.goto(BASE + "/task/" + TASK_ID, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // 1) Ищем «Отменить задание»
  const cancelTaskVisible = await page
    .getByRole("button", { name: /Отменить задание/i })
    .isVisible()
    .catch(() => false);
  const cancelTaskAny = await page
    .locator("button:has-text('Отменить задание')")
    .count();
  // 2) Ищем «Прервать шаг»
  const cancelSubtaskAny = await page
    .locator("text=Прервать шаг")
    .count();
  // 3) Ищем «Сбросить попытку»
  const resetSubtaskAny = await page
    .locator("text=Сбросить попытку")
    .count();
  // 4) Ищем dotsH-кнопку в строках
  const dotsHAria = await page
    .locator("[aria-label='Управление шагом']")
    .count();
  // 5) Ищем в DOM TaskControlPanel/TaskControlSheet
  const tcp = await page
    .locator("[data-testid='TaskControlPanel'], [data-component='TaskControlPanel']")
    .count();
  const tcs = await page
    .locator("[data-testid='TaskControlSheet'], [data-component='TaskControlSheet']")
    .count();

  // Скриншот карточки
  await page.screenshot({ path: join(OUT_DIR, "01-task-detail.png"), fullPage: true });
  // Скриншот верхней части (как на iOS)
  await page.screenshot({ path: join(OUT_DIR, "01-task-detail-top.png"), fullPage: false });

  // DOM-отчёт
  const report = {
    base: BASE,
    taskId: TASK_ID,
    cancelTaskButtonVisible: cancelTaskVisible,
    cancelTaskButtonAny: cancelTaskAny,
    cancelSubtaskLabelAny: cancelSubtaskAny,
    resetSubtaskLabelAny: resetSubtaskAny,
    dotsHButtonAria: dotsHAria,
    TaskControlPanel: tcp,
    TaskControlSheet: tcs,
    errors,
  };
  console.log("REPORT=" + JSON.stringify(report, null, 2));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
