// Скриншоты веба для MAK-54 (поля ввода, тумблер, шторки, состояния).
//
// Что снимаем — по списку Критика (critic_recheck rev 2 v1, 05.10.2026):
// 1. Switch (включён и выключен)            → 01-settings
// 2. TextField (общий из UI.tsx)            → 02-textfield (RegisterScreen)
// 3. SheetHeader в трёх формах              → 03-task-filter, 05-chat-stats,
//                                              06-role-context
// 4. Loading (inline / block)               → 10-loading
// 5. ErrorBanner (inline + block)           → 11-error-banner
// 6. EmptyState                             → 09-empty-state (chats/notes)
//
// Дополнительно — две шторки с условиями наличия данных:
// 7. RescheduleSheet (только если есть просроченные задачи)
// 8. AttachmentViewerSheet (только если у задачи есть вложения)
//
// Layout 402×874, свет/тьма через persist-стейт. Кадры:
//   docs/2026-10-05-mak54-inputs-states/web/{light,dark}/NN-name.png
//
// Запуск:
//   node scripts/screenshot-mak54.mjs
//
// Требует работающий dev-сервер (npm run dev на :5180) с поднятым
// backend на :3001 и TASKFLOW_LAN_NO_AUTH=1 — RequireAuth сам
// залогинится через POST /api/auth/lan (нужен настоящий chromium с
// UA Mozilla/*, иначе looksLikeBrowser() режет).

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "docs/2026-10-05-mak54-inputs-states", "web");

const VIEWPORT = { width: 402, height: 874 };
const BASE = "https://localhost:5180";

// zustand persist читает localStorage и ставит data-theme на <html>.
// Ключ `taskflow-ui`, version 4 — как в сторе. Минимальный стейт, чтобы
// persist-merge прошёл без warning'ов про потерянные поля.
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
  // `file` уже абсолютный (join(OUT_DIR, theme, name)), двойного
  // склеивания не нужно — прошлый баг был именно в этом.
  await page.waitForTimeout(settle);
  await page.screenshot({ path: file, fullPage: false });
  console.log("wrote", file);
}

// Шторка открывается пружиной useBottomSheet; 1500мс достаточно для
// появления DOM и завершения анимации входа.
async function openSheetByClick(selector, settle = 1500) {
  const btn = document.body; // no-op
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

  // Подменяем ответы ручек, чтобы получить гарантированные состояния:
  //   /api/labels → 500            (ErrorBanner inline на /labels)
  //   /api/templates → 500         (ErrorBanner block на /settings/templates)
  //   /api/tasks → задержка 4с     (Loading inline на /today, потом снимем)
  // Всё это — только в браузерном контексте, сервер не трогаем.
  await ctx.route("**/api/labels", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced for screenshot" }),
      });
      return;
    }
    await route.continue();
  });
  await ctx.route("**/api/templates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced for screenshot" }),
      });
      return;
    }
    await route.continue();
  });
  // /api/chats → [] даст пустой список и EmptyState.
  // /api/projects → 500 даст ErrorBanner block в ProjectsScreen (variant="block" в строке 296).
  await ctx.route("**/api/chats", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
      return;
    }
    await route.continue();
  });
  await ctx.route("**/api/projects", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced for screenshot" }),
      });
      return;
    }
    await route.continue();
  });

  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));

  // Первичная загрузка, чтобы RequireAuth залогинился через /api/auth/lan.
  await page.goto(`${BASE}/overview`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // ── 01 — SettingsScreen: Switch (тема), каркас секций, иконки ─────
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await shoot(page, `${dir}/01-settings.png`, 1500);

  // ── 02 — TextField (общий из UI.tsx) ───────────────────────────────
  // На SettingsScreen TextField нет — там сырые input'ы EditProfileModal
  // и file-input аватарки. RegisterScreen — единственный экран, где
  // используется настоящий TextField из UI.tsx; открыт публично.
  // Прокрутим, чтобы все 4 поля попали в кадр.
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await shoot(page, `${dir}/02-textfield.png`, 1200);

  // ── 03 — TaskFilterSheet ────────────────────────────────────────────
  // Идём на /upcoming (там список обычно не пустой, и кнопка-фильтр в
  // шапке есть стабильно). Кликаем по кнопке, ждём пружину шторки
  // (~1500мс), снимаем кадр. После — закрываем через клик мимо шторки
  // (scrim), а не Escape, потому что useBottomSheet слушает pointerdown
  // на подложке, а не keydown.
  await page.goto(`${BASE}/upcoming`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  let filterShot = false;
  const filterBtn = page.locator('button[aria-label="Фильтры"]').first();
  if (await filterBtn.count()) {
    // Дождёмся, пока кнопка станет видимой и стабильной — иначе Playwright
    // может промахнуться мимо 44×44 тап-зоны.
    await filterBtn.scrollIntoViewIfNeeded();
    await filterBtn.click({ force: false });
    await page.waitForTimeout(2000);
    // Ждём появления шторки: SheetHeader рендерится с текстом «Фильтры».
    try {
      await page.waitForSelector('text="Фильтры"', { timeout: 4000 });
    } catch {
      console.warn("TaskFilterSheet: SheetHeader не появился — пробуем ещё раз");
    }
    await shoot(page, `${dir}/03-task-filter.png`, 800);
    // Закрываем тапом по scrim (верхняя часть viewport, где шторки нет).
    await page.mouse.click(200, 60);
    await page.waitForTimeout(700);
    filterShot = true;
  } else {
    console.warn("TaskFilterSheet: кнопка «Фильтры» не найдена на /upcoming");
  }
  if (!filterShot) console.warn("TaskFilterSheet — пропуск");

  // ── 04 — RescheduleSheet (опционально) ─────────────────────────────
  // Появляется только при наличии просроченных задач. Кнопка «Перенести»
  // — в заголовке секции «Просрочено» на /today.
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const rescheduleBtn = page.locator('button:has-text("Перенести")').first();
  if (await rescheduleBtn.count()) {
    await rescheduleBtn.click();
    await page.waitForTimeout(1800);
    await shoot(page, `${dir}/04-reschedule.png`, 800);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(700);
  } else {
    console.warn("RescheduleSheet: нет просроченных задач — пропуск");
  }

  // ── 05 — ChatStatsSheet из /chats/<id> ─────────────────────────────
  // SheetHeader без действия; сводка «Кого озадачивают чаще всего».
  await page.goto(`${BASE}/chats`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const firstChat = page.locator('a[href^="/chats/"]').first();
  if (await firstChat.count()) {
    await firstChat.click();
    await page.waitForTimeout(1800);
    const statsBtn = page
      .locator('button[aria-label="Кого озадачивают чаще всего"]')
      .first();
    if (await statsBtn.count()) {
      await statsBtn.click();
      await page.waitForTimeout(2000);
      await shoot(page, `${dir}/05-chat-stats.png`, 800);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(700);
    } else {
      console.warn("ChatStatsSheet: кнопка статистики не найдена — пропуск");
    }
  } else {
    console.warn("ChatStatsSheet: нет чатов — пропуск");
  }

  // ── 06 — RoleContextSheet ───────────────────────────────────────────
  // Карточка роли свёрнута по умолчанию; кликаем по первой, потом по
  // кнопке «Контекст запуска». SheetHeader без действия — но крестик и
  // заголовок могут быть обрезаны сверху, поэтому скроллим шторку к
  // началу после открытия.
  await page.goto(`${BASE}/agents`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  const roleLabels = [
    "Архитектор",
    "Разработчик",
    "QA",
    "Критик-проверяющий",
    "Исследователь",
    "Аналитик",
    "Дизайнер интерфейсов",
    "Оркестратор",
  ];
  let roleOpened = false;
  for (const label of roleLabels) {
    const row = page.locator(`text="${label}"`).first();
    if (await row.count()) {
      await row.click();
      await page.waitForTimeout(900);
      const ctxBtn = page.locator('button:has-text("Контекст запуска")').first();
      if (await ctxBtn.count()) {
        await ctxBtn.click();
        await page.waitForTimeout(2500);
        // Шторка открыта с пружиной; Playwright прокрутил контейнер шторки
        // к кнопке, которая была ниже. Скроллим к началу — SheetHeader с
        // крестиком и заголовком станет виден в кадре.
        await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return;
          // Ищем все overflow-y-auto внутри dialog и в body.
          const candidates = [
            ...dialog.querySelectorAll(".overflow-y-auto"),
            ...document.querySelectorAll(".overflow-y-auto"),
          ];
          for (const el of candidates) {
            if ("scrollTop" in el) el.scrollTop = 0;
          }
          // Также пробуем scrollIntoView для SheetHandle (первая полоска).
          const handle = dialog.querySelector('[class*="rounded-full bg-stroke"]');
          if (handle && handle.scrollIntoView) {
            handle.scrollIntoView({ block: "start" });
          }
        });
        await page.waitForTimeout(700);
        await shoot(page, `${dir}/06-role-context.png`, 600);
        await page.mouse.click(200, 60); // закрыть по scrim
        await page.waitForTimeout(700);
        roleOpened = true;
        break;
      }
    }
  }
  if (!roleOpened) console.warn("RoleContextSheet: ни одна роль не раскрылась — пропуск");

  // ── 07 — AttachmentViewerSheet (опционально) ───────────────────────
  // Открывается из карточки задачи при наличии вложения. Если задач или
  // вложений нет — пропуск (объективное отсутствие данных).
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const firstTaskLink = page.locator('a[href^="/tasks/"]').first();
  if (await firstTaskLink.count()) {
    await firstTaskLink.click();
    await page.waitForTimeout(1500);
    const att = page
      .locator('[data-attachment], button[aria-label*="Открыть"]')
      .first();
    if (await att.count()) {
      await att.click();
      await page.waitForTimeout(1800);
      await shoot(page, `${dir}/07-attachment.png`, 800);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(700);
    } else {
      console.warn("AttachmentViewerSheet: у первой задачи нет вложений — пропуск");
    }
  } else {
    console.warn("AttachmentViewerSheet: нет задач — пропуск");
  }

  // ── 09 — EmptyState (ChatsScreen) ────────────────────────────────────
  // У владельца чаты есть, поэтому подменяем /api/chats → []. EmptyState
  // с иконкой chat, заголовком «Чатов пока нет», описанием и red-кнопкой
  // «Новый чат».
  await page.goto(`${BASE}/chats`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await shoot(page, `${dir}/09-empty-state.png`, 800);

  // ── 10 — Loading ───────────────────────────────────────────────────
  // В TodayScreen Loading рисуется при isLoading=true. Подменяем
  // /api/tasks на задержанный ответ, чтобы гарантировать видимый
  // спиннер. После снятия восстанавливаем обычное поведение.
  await ctx.unroute("**/api/tasks");
  await ctx.route("**/api/tasks", async (route) => {
    // 4 секунды — больше, чем useTasks() cache; пользователь увидит Loading.
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue();
  });
  await page.goto(`${BASE}/today`, { waitUntil: "domcontentloaded" });
  // Не дожидаемся networkidle — он не наступит из-за задержки. Спиннер
  // появится после первого рендера (~300мс), снимаем в этом окне.
  await page.waitForTimeout(1200);
  await shoot(page, `${dir}/10-loading.png`, 200);
  // Восстанавливаем обычное поведение, чтобы не мешать следующим шагам.
  await ctx.unroute("**/api/tasks");

  // ── 11 — ErrorBanner: inline + block ────────────────────────────────
  // inline — на /labels (variant="inline", строка текстом).
  await page.goto(`${BASE}/labels`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await shoot(page, `${dir}/11-error-banner.png`, 600);
  // block — на /projects?create=1: форма создания проекта содержит
  // <ErrorBanner variant="block">. Подменяем POST /api/projects на 500,
  // чтобы после нажатия «Создать» появилась плашка.
  await ctx.route("**/api/projects", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced for screenshot" }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto(`${BASE}/projects?create=1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  // Введём имя и нажмём «Создать» — получим ErrorBanner block.
  const nameField = page.locator('input[placeholder*="Название"]').first();
  if (await nameField.count()) {
    await nameField.fill("Тест");
    await page.waitForTimeout(400);
    await page.click('button:has-text("Создать")');
    await page.waitForTimeout(2000);
  }
  await shoot(page, `${dir}/11b-error-banner-block.png`, 600);
  await ctx.unroute("**/api/projects");

  await browser.close();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await runTheme("light");
  await runTheme("dark");
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});