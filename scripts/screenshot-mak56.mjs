// Сверка веба с iOS по кадрам (Linear MAK-56), 2026-10-06.
// Семь экранов из описания задачи в двух темах, viewport 402×874 @ DSR=1
// (единый базовый размер для сравнения с iOS-ка��рами 1206×2622@DSR=3).
// Выход: docs/2026-10-06-verify-mak-56/web/{light,dark}/NN-<name>.png
//
// Основа — scripts/screenshot-fix2.mjs: LAN-логин через /api/auth/lan
// (TASKFLOW_LAN_NO_AUTH=1), логин подскакивает на User-Agent браузера.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_ROOT = join(ROOT, "docs/2026-10-06-verify-mak-56", "web");

const BASE = "https://127.0.0.1:5260";
const VIEWPORT = { width: 402, height: 874 };

// Маршруты. Карточка задачи — динамическая, id берём из /api/tasks.
const SCREENS = [
  { idx: "01", name: "today", route: "/today" },
  { idx: "02", name: "upcoming", route: "/upcoming" },
  { idx: "03", name: "task", route: "__task__" },
  { idx: "04", name: "projects", route: "/projects" },
  { idx: "05", name: "chats", route: "/chats" },
  { idx: "06", name: "notes", route: "/notes" },
  { idx: "07", name: "settings", route: "/settings" },
];

function persistFor(theme) {
  return {
    state: {
      settings: { theme, calendarView: "month" },
      taskLayout: { inbox: "list", today: "list" },
      upcomingLayout: "list",
      collapsedInboxProjects: {},
      plannerVisibleProjects: {},
    },
    version: 4,
  };
}

async function firstTaskId(context) {
  const page = await context.newPage();
  await page.goto(BASE + "/today", { waitUntil: "domcontentloaded" });
  const id = await page.evaluate(async () => {
    try {
      const r = await fetch("/api/tasks", { credentials: "include" });
      if (!r.ok) return null;
      const list = await r.json();
      return Array.isArray(list) && list.length ? list[0].id : null;
    } catch {
      return null;
    }
  });
  await page.close();
  return id;
}

async function shoot(context, url, file) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  pageerror@${file}:`, e.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: file, fullPage: false });
  console.log("wrote", file);
  await page.close();
}

async function themeRun(browser, theme, taskId) {
  const dir = join(OUT_ROOT, theme);
  await mkdir(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: true,
  });
  const persist = persistFor(theme);
  await ctx.addInitScript((p) => {
    localStorage.setItem("taskflow-ui", JSON.stringify(p));
  }, persist);
  for (const s of SCREENS) {
    const route = s.route === "__task__" ? (taskId ? `/task/${taskId}` : null) : s.route;
    if (!route) {
      console.log(`skip ${s.name}: нет id задачи`);
      continue;
    }
    try {
      await shoot(ctx, BASE + route, join(dir, `${s.idx}-${s.name}.png`));
    } catch (e) {
      console.log(`FAIL ${theme}/${s.name}: ${e.message}`);
    }
  }
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--ignore-certificate-errors"],
  });
  const probe = await browser.newContext({ ignoreHTTPSErrors: true });
  const taskId = await firstTaskId(probe);
  await probe.close();
  console.log("task id:", taskId);
  await themeRun(browser, "light", taskId);
  await themeRun(browser, "dark", taskId);
  await browser.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});