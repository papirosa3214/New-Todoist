// Скриншоты веба для MAK-49 (кнопки: TFButton / TFIconButton).
//
// Что снимаем (DESIGN-SYSTEM.md §2.1 / DESIGN.md «Кнопки»):
//   TFButton (полноширинная): primary / secondary / outline + иконка 16
//     → 01-task-detail (TaskDetailScreen — все три варианта на одном экране)
//     → 04-register    (RegisterScreen — primary на всю ширину, submit)
//   TFIconButton (прозрачная, тап-зона 44×44, обязательный aria-label):
//     → 02-today       (шапка «Сегодня»: фильтр + «Ещё»)
//     → 03-filter-sheet (шторка фильтров: крестик SheetHeader + кнопка фильтра)
//     → 04-register    (BackButton → IconButton chevronLeft в шапке)
//
// Layout 402×874, свет/тьма через persist-стейт (`taskflow-ui`, version 4).
// Кадры: docs/2026-10-06-buttons-mak-49/web/{light,dark}/NN-name.png
//
// Запуск (dev-сервер должен отдавать ЭТОТ worktree):
//   npx vite --host 0.0.0.0 --port 5221 --strictPort
//   node scripts/screenshot-mak49.mjs
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
const OUT_DIR = join(ROOT, "docs/2026-10-06-buttons-mak-49", "web");

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

async function shoot(page, file, settle = 1500) {
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

  // ── 01 — TaskDetailScreen: primary + secondary + outline, иконки 16 ──
  // Нужна задача БЕЗ agent_state: при agent_state кнопки владельца
  // («Завершить», «Готово к работе», «Изменить») не рендерятся — ими
  // управляет агент. Прокручиваем к блоку кнопок.
  const taskId = await page.evaluate(async () => {
    const r = await fetch("/api/tasks", { credentials: "include" });
    if (!r.ok) return null;
    const list = await r.json();
    if (!Array.isArray(list)) return null;
    const plain = list.find((t) => t.status === "active" && !t.agent_state);
    return plain ? plain.id : null;
  });
  if (taskId) {
    await goto(page, `${BASE}/task/${taskId}`);
    await page.waitForTimeout(1500);
    const block = page.locator('button:has-text("Изменить")').first();
    if (await block.count()) {
      await block.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
    } else {
      console.warn("TaskDetail: блок кнопок владельца не найден");
    }
    await shoot(page, `${dir}/01-task-detail-buttons.png`, 500);
  } else {
    console.warn("TaskDetail: нет активной задачи без agent_state — 01 пропущен");
  }

  // ── 02 — TodayScreen: IconButton «Фильтры» + «Ещё» в шапке ──────────
  await goto(page, `${BASE}/today`);
  await page.waitForTimeout(1800);
  await shoot(page, `${dir}/02-today-header-iconbuttons.png`, 800);

  // ── 03 — TaskFilterSheet: крестик SheetHeader (IconButton) ──────────
  await goto(page, `${BASE}/upcoming`);
  await page.waitForTimeout(1800);
  const filterBtn = page.locator('button[aria-label="Фильтры"]').first();
  if (await filterBtn.count()) {
    await filterBtn.scrollIntoViewIfNeeded();
    await filterBtn.click();
    await page.waitForTimeout(2000);
    try {
      await page.waitForSelector('text="Фильтры"', { timeout: 4000 });
    } catch {
      console.warn("TaskFilterSheet: SheetHeader не появился");
    }
    await shoot(page, `${dir}/03-filter-sheet.png`, 800);
    await page.mouse.click(200, 60);
    await page.waitForTimeout(700);
  } else {
    console.warn("TaskFilterSheet: кнопка «Фильтры» не найдена");
  }

  // ── 04 — RegisterScreen: BackButton + primary Button ────────────────
  await goto(page, `${BASE}/register`);
  await page.waitForTimeout(1500);
  await shoot(page, `${dir}/04-register.png`, 800);

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
