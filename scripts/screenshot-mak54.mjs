// Скриншоты MAK-54 в тёмной и светлой темах, 402×874.
//
// Снимаем: настройки (Switch + TextField), шторка фильтров (SheetHeader +
// Switch + FieldGroup), экран чатов (EmptyState если пусто, иначе лента).
// Скрипт работает с локальным vite на https://127.0.0.1:5184, который
// слушает этот worktree. Бэкенд на :3001 с TASKFLOW_LAN_NO_AUTH=1.
//
// Запуск:
//   node scripts/screenshot-mak54.mjs
//
// Скрипт НЕ зависит от App.tsx/main: каждый кадр пишется в
// docs/2026-10-05-mak54-fields-toggle-sheets/{dark,light}/.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "docs/2026-10-05-mak54-fields-toggle-sheets");

const VIEWPORT = { width: 402, height: 874 };
const BASE = "https://127.0.0.1:5184";

async function shoot(page, url, file, waitFor = 900) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(waitFor);
  const out = join(OUT_DIR, file);
  await page.screenshot({ path: out, fullPage: false });
  console.log("wrote", out);
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    const KEY = "taskflow-ui";
    const raw = localStorage.getItem(KEY);
    const parsed = raw
      ? JSON.parse(raw)
      : { state: { settings: {} }, version: 0 };
    parsed.state = parsed.state || {};
    parsed.state.settings = parsed.state.settings || {};
    parsed.state.settings.theme = t;
    localStorage.setItem(KEY, JSON.stringify(parsed));
  }, theme);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--ignore-certificate-errors"],
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));

  // Сначала открываем /today — RequireAuth дёргает /api/auth/lan, токен
  // ставится в localStorage, и приложение показывает данные владельца.
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  // Берём id первого проекта — там точно есть задачи, фильтр уместен.
  const project = await page.evaluate(async () => {
    const r = await fetch("/api/projects", { credentials: "include" });
    if (!r.ok) return null;
    const arr = await r.json();
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  });
  console.log("project:", project?.id, project?.name);

  // === ТЁМНАЯ ТЕМА (дефолт) ===
  await setTheme(page, "dark");
  await mkdir(join(OUT_DIR, "dark"), { recursive: true });

  // 1) Настройки — Switch (тема), TextField (имя профиля).
  await shoot(page, `${BASE}/settings`, "dark/01-settings.png");

  // 2) EditProfileModal: TextField в шторке, SheetHeader.
  try {
    await page
      .getByRole("button", { name: /изменить|редактировать/i })
      .first()
      .click({ timeout: 2000 });
    await page.waitForTimeout(800);
    await page.screenshot({
      path: join(OUT_DIR, "dark/02-edit-profile.png"),
      fullPage: false,
    });
    console.log("wrote dark/02-edit-profile.png");
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  } catch (e) {
    console.log("edit-profile modal not found:", e.message);
  }

  // 3) Шторка фильтров — через Upcoming (там есть задачи и кнопка «Фильтры»).
  await page.goto(`${BASE}/upcoming`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  try {
    await page
      .getByRole("button", { name: "Фильтры" })
      .first()
      .click({ timeout: 2000 });
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: join(OUT_DIR, "dark/03-filters.png"),
      fullPage: false,
    });
    console.log("wrote dark/03-filters.png");
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  } catch (e) {
    console.log("filters sheet not found:", e.message);
  }

  // 4) Экран чатов — если есть пустые, снимем EmptyState.
  await shoot(page, `${BASE}/chats`, "dark/04-chats.png");

  // === СВЕТЛАЯ ТЕМА ===
  await setTheme(page, "light");
  await mkdir(join(OUT_DIR, "light"), { recursive: true });

  await shoot(page, `${BASE}/settings`, "light/01-settings.png");
  await shoot(page, `${BASE}/chats`, "light/04-chats.png");

  if (project) {
    await page.goto(`${BASE}/upcoming`, {
      waitUntil: "networkidle",
    });
    await page.waitForTimeout(800);
    try {
      await page
        .getByRole("button", { name: "Фильтры" })
        .first()
        .click({ timeout: 2000 });
      await page.waitForTimeout(1500);
      await page.screenshot({
        path: join(OUT_DIR, "light/03-filters.png"),
        fullPage: false,
      });
      console.log("wrote light/03-filters.png");
    } catch (e) {
      console.log("light filters sheet not found:", e.message);
    }
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
