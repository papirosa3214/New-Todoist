// Скриншоты веба в тёмной теме (MAK-51, критерий приёмки — обе темы).
//
// Зачем: в docs/2026-10-04-light-contrast-audit/web/ уже лежат кадры
// светлой темы (MAK-46), но и сами компоненты пилюль/приоритета/аватара
// (MAK-51) должны быть видны рядом с iOS-эталонами в ОБЕИХ темах —
// светлые акценты затемнены до полного прохода WCAG AA, а тёмная тема
// остаётся той, в которой приложение работает по умолчанию. Вьюпорт
// 402×874 — как в светлой съёмке, чтобы рамка строки состояния и home
// indicator легли одинаково.
//
// Что делает:
//   1. Открывает корень БЕЗ persist-стейта → App.tsx ставит дефолтную
//      тёмную тему на <html>.
//   2. RequireAuth сам дёргает POST /api/auth/lan — токен в localStorage,
//      и приложение показывает настоящие данные владельца (не мок).
//   3. Проходит три экрана: «Сегодня» (там видны «Просрочено»-пилюля,
//      шевроны приоритета, аватары), карточка задачи (флаг+слово
//      приоритета, аватар исполнителя), проекты (аватары и метки).
//      Кадры в PNG кладутся в docs/2026-10-04-light-contrast-audit/web/dark/.
//
// Запуск:
//   node scripts/screenshot-dark-theme.mjs
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
const OUT_DIR = join(ROOT, "docs/2026-10-04-light-contrast-audit", "web", "dark");

const VIEWPORT = { width: 402, height: 874 };
const BASE = "https://localhost:5180";

async function shoot(page, url, file) {
  await page.goto(url, { waitUntil: "networkidle" });
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

  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));

  // Сначала открываем /today, чтобы RequireAuth успел залогинить через
  // LAN (cookie ставится в браузерный стор). После этого из того же
  // контекста fetch на /api/tasks уже идёт авторизованным.
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  // Берём id первой задачи владельца (для карточки задачи) и id проекта
  // с максимальным числом задач (там 100% есть пилюли, шевроны, аватары).
  // На «Сегодня» у владельца сейчас пусто, поэтому экран «Сегодня» для
  // MAK-51 не показателен — заменяем на список задач проекта.
  const ids = await page.evaluate(async () => {
    const out = { taskId: null, projectId: null, projectName: null };
    const t = await fetch("/api/tasks", { credentials: "include" });
    if (t.ok) {
      const tj = await t.json();
      if (Array.isArray(tj) && tj.length) out.taskId = tj[0].id;
    }
    const p = await fetch("/api/projects", { credentials: "include" });
    if (p.ok) {
      const pj = await p.json();
      if (Array.isArray(pj) && pj.length) {
        const sorted = [...pj].sort(
          (a, b) => (b.task_count ?? 0) - (a.task_count ?? 0),
        );
        out.projectId = sorted[0].id;
        out.projectName = sorted[0].name;
      }
    }
    return out;
  });
  console.log("ids:", ids);

  // Экран списка задач проекта — основной носитель MAK-51: пилюли
  // «Просрочено», шевроны приоритета 4/3/2/1, аватары исполнителей 30px
  // в строках. Снимаем вместо «Сегодня», потому что today у владельца
  // сейчас пуст.
  if (ids.projectId) {
    await shoot(
      page,
      `${BASE}/projects/${ids.projectId}`,
      "project-tasks-dark.png",
    );
  } else {
    await shoot(page, `${BASE}/today`, "today-dark.png");
  }
  if (ids.taskId) {
    await shoot(page, `${BASE}/task/${ids.taskId}`, "task-detail-dark.png");
  } else {
    console.log("no task found, skipping task-detail-dark.png");
  }
  await shoot(page, `${BASE}/projects`, "projects-dark.png");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});