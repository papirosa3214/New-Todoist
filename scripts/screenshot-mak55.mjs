// Скриншоты веба для MAK-55 (одно действие — одна иконка и один размер).
//
// Что снимаем (DESIGN.md «Словарь действий — иконка и размер»):
//   01-templates — TemplatesScreen: trash/edit в строке шаблона (15 → 18).
//   02-labels    — LabelsScreen: trash/edit в строке метки (16 → 18).
//   03-today-row — TodayScreen со свайп-строкой TaskRow (trash 22, edit 22).
//
// Layout 402×874, свет/тьма через persist-стейт (`taskflow-ui`, version 4).
// Кадры: docs/2026-10-06-buttons-mak-55/web/{light,dark}/NN-name.png
//
// Запуск (dev-сервер должен отдавать ЭТОТ worktree):
//   npx vite --host 0.0.0.0 --port 5251 --strictPort
//   node scripts/screenshot-mak55.mjs
//
// Требует backend на :3001 с TASKFLOW_LAN_NO_AUTH=1 — RequireAuth сам
// залогинится через POST /api/auth/lan (нужен настоящий chromium с
// UA Mozilla/*, иначе looksLikeBrowser() режет).

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "docs/2026-10-06-buttons-mak-55", "web");

const VIEWPORT = { width: 402, height: 874 };
const BASE = process.env.BASE_URL ?? "https://localhost:5251";

const PERSIST = (theme) => ({
  state: {
    settings: { theme, calendarView: "month" },
    taskLayout: { inbox: "list", today: "list" },
    upcomingLayout: "month",
    collapsedInboxProjects: {},
    plannerVisibleProjects: {},
    aiProvider: "local",
    localOllamaModel: "qwen3.6-27b-iq4-16k:latest",
    antigravityModel: "gemini-3.7-flash-high",
    claudeModel: "claude-sonnet-4.6",
    hermesModel: "nous-hermes-3-405b",
    deepseekModel: "deepseek-r1",
  },
  version: 4,
});

async function shoot(page, file, settle = 1500) {
  await page.waitForTimeout(settle);
  await page.screenshot({ path: file, fullPage: false });
  console.log("wrote", file);
}

async function goto(page, url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.goto(url, { waitUntil: "networkidle" });
      return;
    } catch (e) {
      if (!String(e).includes("ERR_CERT_VERIFIER_CHANGED")) throw e;
      console.warn(`goto ${url}: ${e.message.split("\n")[0]} — повтор ${attempt + 1}`);
      await page.waitForTimeout(1000);
    }
  }
  await page.goto(url, { waitUntil: "networkidle" });
}

async function runTheme(theme) {
  const dir = join(OUT_DIR, theme);
  await mkdir(dir, { recursive: true });

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--ignore-certificate-errors"],
  });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  await ctx.addInitScript((persist) => {
    localStorage.setItem("taskflow-ui", JSON.stringify(persist));
  }, PERSIST(theme));

  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("console.error:", m.text());
  });

  // 01-templates — Шаблоны задач.
  await goto(page, `${BASE}/settings/templates`);
  await shoot(page, join(dir, "01-templates.png"));

  // 02-labels — Метки.
  await goto(page, `${BASE}/labels`);
  await shoot(page, join(dir, "02-labels.png"));

  // 03-today — Сегодня со свайп-строкой.
  await goto(page, `${BASE}/today`);
  await shoot(page, join(dir, "03-today.png"));

  await browser.close();
}

await runTheme("light");
await runTheme("dark");
console.log("OK");