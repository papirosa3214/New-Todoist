// Свежие скриншоты светлой темы для MAK-47 «доработка 2» (2026-10-05).
// Основа — scripts/screenshot-light-theme.mjs (MAK-46): использует
// TASKFLOW_LAN_NO_AUTH=1 и автоматический LAN-логин через /api/auth/lan,
// без APP_EMAIL/APP_PASSWORD.
//
// Для MAK-47 снимаем ОБЕ версии каждого экрана (QA e240ea70):
//   • 1206×2622 @ DSR=3 — iOS-сверка (требование ревью v2).
//   • 402×874 @ DSR=1 — единый базовый размер для сравнения с a362f3d3
//     (там тоже 1206×2622@DSR=3, но 402×874 удобнее как «человек видит
//     один CSS-пиксель = один физический пиксель»).
//
// Выход: docs/2026-10-05-typography-mak-47/web/fix2/ — рядом с web/fix1/
// (где лежит login-dark.png из прошлой попытки), не заменяет исходные 6
// файлов a362f3d3.
//
// Три экрана: /today, /task/<id> (первая задача из /api/tasks), /settings.
// Лайт-тема: localStorage init script (settings.theme="light", version=4).
//
// Использование: node scripts/screenshot-fix2.mjs
// Требует: dev-сервер на :5180, бэкенд на :3001 с TASKFLOW_LAN_NO_AUTH=1.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "docs/2026-10-05-typography-mak-47", "web", "fix2");

const BASE = "https://localhost:5180";
// iPhone 14/15 в pt (логических пикселях CSS).
const VIEWPORT = { width: 402, height: 874 };

// Экраны в порядке съёмки. ВАЖНО: заходим на каждый экран ОДИН раз на
// @DSR=3 (для скорости и согласованности с a362f3d3), а потом в этом же
// контексте пересоздаём с @DSR=1 для «человеческой» версии. Состояние
// авторизации и localStorage (theme=light) сохраняется в storageState
// между прогонами, так что LAN-логин достаточно сделать один раз.
const SCREENS = [
  { idx: "01", route: "/today", title: "today" },
  { idx: "02", route: null, title: "task-detail" }, // динамический route
  { idx: "03", route: "/settings", title: "settings" },
];

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

async function newContext(browser, dsr) {
  return browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: dsr,
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: true,
  });
}

async function applyPersistAndLan(context) {
  await context.addInitScript((persist) => {
    localStorage.setItem("taskflow-ui", JSON.stringify(persist));
  }, LIGHT_PERSIST);
}

async function shootOnce(context, url, file) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  pageerror@${file}:`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`  console.error@${file}:`, m.text());
  });
  await page.goto(url, { waitUntil: "networkidle" });
  // Анимации входа (шапка, сетка часов, плашки) длятся ~700мс.
  await page.waitForTimeout(1500);
  const out = join(OUT_DIR, file);
  await page.screenshot({ path: out, fullPage: false });
  console.log("wrote", out);
  await page.close();
}

async function firstTaskId(context) {
  // Берём id из уже открытой страницы /today — там есть базовый URL и
  // куки/токен, /api/tasks в about:blank падает с "Failed to parse URL".
  const page = await context.newPage();
  await page.goto(BASE + "/today", { waitUntil: "domcontentloaded" });
  const id = await page.evaluate(async () => {
    const r = await fetch("/api/tasks", { credentials: "include" });
    if (!r.ok) return null;
    const list = await r.json();
    return Array.isArray(list) && list.length ? list[0].id : null;
  });
  await page.close();
  return id;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--ignore-certificate-errors"],
  });

  // DSR=3 (1206×2622) — основной набор для iOS-сверки.
  const ctx3 = await newContext(browser, 3);
  await applyPersistAndLan(ctx3);
  // 01 /today @DSR=3
  await shootOnce(ctx3, BASE + "/today", "01-today-1206.png");
  // 02 /task/<id> @DSR=3 (берём id из уже открытой /today)
  const taskId = await firstTaskId(ctx3);
  if (taskId) {
    console.log("task id for detail:", taskId);
    await shootOnce(ctx3, `${BASE}/task/${taskId}`, "02-task-detail-1206.png");
  } else {
    console.log("нет задач в /api/tasks — task-detail пропущен");
  }
  // 03 /settings @DSR=3
  await shootOnce(ctx3, BASE + "/settings", "03-settings-1206.png");
  await ctx3.close();

  // DSR=1 (402×874) — базовый размер для сравнения с a362f3d3.
  const ctx1 = await newContext(browser, 1);
  await applyPersistAndLan(ctx1);
  await shootOnce(ctx1, BASE + "/today", "01-today-402.png");
  if (taskId) {
    await shootOnce(ctx1, `${BASE}/task/${taskId}`, "02-task-detail-402.png");
  } else {
    console.log("нет задач в /api/tasks — task-detail @DSR=1 пропущен");
  }
  await shootOnce(ctx1, BASE + "/settings", "03-settings-402.png");
  await ctx1.close();

  await browser.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
