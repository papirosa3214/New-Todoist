// Скриншоты веба для MAK-50 (карточки, строки списка, секции, разделители).
//
// Что снимаем (DESIGN-SYSTEM.md §2.2/§2.7 / DESIGN.md «Карточки, строки,
// секции, разделители»):
//   Card / FieldGroup  — bg-card, радиус 16, без рамки, разделитель 1px stroke
//   SectionHeader      — ступень action (13/400/+0.10), цвет sub
//   ListRow / FieldRow — иконка 40×40 (заливка 18%) или 18px dim, заголовок,
//                        подзаголовок, значение/шеврон 13, строка 52
//
// Layout 402×874, свет/тьма через persist-стейт (`taskflow-ui`, version 4).
// Кадры: docs/2026-10-06-cards-mak-50/web/{light,dark}/NN-name.png
//
// Запуск (dev-сервер должен отдавать ЭТОТ worktree):
//   npx vite --host 0.0.0.0 --port 5221 --strictPort
//   node scripts/screenshot-mak50.mjs
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
const OUT_DIR = join(ROOT, "docs/2026-10-06-cards-mak-50", "web");

const VIEWPORT = { width: 402, height: 874 };
const BASE = process.env.BASE_URL ?? "https://localhost:5221";

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

async function shoot(page, file, settle = 1200) {
  await page.waitForTimeout(settle);
  await page.screenshot({ path: file, fullPage: false });
  console.log("wrote", file);
}

// ERR_CERT_VERIFIER_CHANGED на self-signed сертификате vite —
// транзиентная ошибка Chrome; повторный goto её снимает.
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

  // Первичный заход — RequireAuth делает LAN-логин.
  await goto(page, `${BASE}/overview`);
  await page.waitForTimeout(1500);

  // ── 01 — SettingsScreen: карточки, SectionHeader, ListRow 40×40, FieldGroup ──
  await goto(page, `${BASE}/settings`);
  await page.waitForTimeout(1800);
  await shoot(page, `${dir}/01-settings.png`, 800);

  // ── 02 — TemplatesScreen: SectionHeader + карточки шаблонов ─────────
  await goto(page, `${BASE}/settings/templates`);
  await page.waitForTimeout(1800);
  await shoot(page, `${dir}/02-templates.png`, 800);

  // ── 03 — IntegrationsScreen: SectionHeader + карточки-аккордеоны ────
  await goto(page, `${BASE}/settings/integrations`);
  await page.waitForTimeout(1800);
  await shoot(page, `${dir}/03-integrations.png`, 800);

  // ── 04 — TaskFormScreen: FieldGroup/FieldRow, строки 52 ─────────────
  await goto(page, `${BASE}/task/new`);
  await page.waitForTimeout(1800);
  await shoot(page, `${dir}/04-task-form.png`, 800);

  await browser.close();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const theme of ["light", "dark"]) {
    console.log(`\n=== theme: ${theme} ===`);
    await runTheme(theme);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
