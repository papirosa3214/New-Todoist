// Скриншоты веба в светлой теме (MAK-46, критерий приёмки №2).
//
// Зачем: аудит контраста светлой темы 04.10 зафиксирован в iOS-репозитории
// (docs/2026-10-04-light-contrast-audit/), и параллельный набор кадров
// веба нужен, чтобы можно было сравнить одни и те же экраны в обеих
// платформах. Вьюпорт 402×874 — высота урезана относительно 420×912, как
// в iOS-эталоне, чтобы рамка строки состояния и home indicator легли
// одинаково.
//
// Что делает:
//   1. Открывает корень с theme="light" в localStorage ДО загрузки
//      приложения. После рендера App.tsx ставит data-theme="light" на
//      <html>, и все CSS-переменные :root[data-theme="light"] оживают.
//   2. RequireAuth сам дёргает POST /api/auth/lan — токен в localStorage,
//      и приложение показывает настоящие данные владельца (не мок).
//   3. Проходит три экрана: «Сегодня», карточка задачи, проекты.
//      Кадры в PNG кладутся в docs/2026-10-04-light-contrast-audit/web/.
//
// Запуск:
//   node scripts/screenshot-light-theme.mjs
//
// Требует работающий dev-сервер (npm run dev на :5180) с поднятым
// backend на :3001 и TASKFLOW_LAN_NO_AUTH=1 — без LAN-флага экран
// входа останется и кадры не отразят интерфейс.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "docs/2026-10-04-light-contrast-audit", "web");

const VIEWPORT = { width: 402, height: 874 };
const BASE = "https://localhost:5180";
// Подменим persist-стейт, чтобы при монтировании App.tsx поставил
// data-theme="light" (а не дефолтную тёмную). zustand persist читает
// JSON из localStorage и мёрджит по version, поэтому нам достаточно
// положить settings.theme="light" и тот же version, что у стора (4).
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

async function shoot(page, url, file) {
  await page.goto(url, { waitUntil: "networkidle" });
  // Все анимации входа (шапка, сетка часов, плашки) длятся до ~700мс.
  await page.waitForTimeout(900);
  const out = join(OUT_DIR, file);
  await page.screenshot({ path: out, fullPage: false });
  console.log("wrote", out);
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
  await context.addInitScript((persist) => {
    localStorage.setItem("taskflow-ui", JSON.stringify(persist));
  }, LIGHT_PERSIST);

  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("console.error:", m.text());
  });

  // На конкретных задачах с collaboration-планом бывает, что
  // CollaborationPlanPanel падает в ErrorBoundary: для этого шага мы
  // снимаем ТОЛЬКО цвета светлой темы, и панель плана к ним отношения
  // не имеет. Подменяем ответы планов/слотов на пустые — тогда
  // `plan = plansData?.plans.find(...)` будет undefined и панель вернёт
  // null по своей ранней `if (!plan) return null;`. Никакие другие
  // ручки не трогаем: цвета, разметка, остальные блоки карточки — живые.
  await context.route("**/api/tasks/*/collaboration-plans", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plans: [] }),
    });
  });
  await context.route("**/api/tasks/*/role-slots", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ slots: [] }),
    });
  });

  // 1. Первый заход — RequireAuth сделает LAN-логин и нас пустит.
  //    Делать явный goto /today после — обязательно: <Navigate> из /
  //    прыгает в /overview, и тема применится, но нам нужны конкретные
  //    экраны.
  await page.goto(BASE + "/today", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: join(OUT_DIR, "today-light.png"),
    fullPage: false,
  });
  console.log("wrote", join(OUT_DIR, "today-light.png"));

  // 2. Карточка задачи: берём id первой из /api/tasks. Делаем запрос
  //    в контексте страницы, чтобы шёл с тем же токеном из localStorage.
  const taskId = await page.evaluate(async () => {
    const r = await fetch("/api/tasks", { credentials: "include" });
    if (!r.ok) return null;
    const list = await r.json();
    return Array.isArray(list) && list.length ? list[0].id : null;
  });
  if (!taskId) throw new Error("no tasks in db — /api/tasks пуст");
  console.log("task id for detail:", taskId);

  await page.goto(`${BASE}/task/${taskId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({
    path: join(OUT_DIR, "task-detail-light.png"),
    fullPage: false,
  });
  console.log("wrote", join(OUT_DIR, "task-detail-light.png"));

  // 3. Проекты.
  await page.goto(BASE + "/projects", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({
    path: join(OUT_DIR, "projects-light.png"),
    fullPage: false,
  });
  console.log("wrote", join(OUT_DIR, "projects-light.png"));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
