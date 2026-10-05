// Скриншоты веба для MAK-54 (поля ввода, тумблер, шторки, состояния).
//
// Что делает:
//   1. Поднимает браузер в светлой и тёмной теме (data-theme на <html>).
//   2. Делает кадры 402×874 для экранов, где виден результат работы:
//      - Settings (Switch/TextField/Button)            01-settings
//      - TaskFilterSheet из «Сегодня» (SheetHeader + Switch + TextField)  02-task-filter
//      - RescheduleSheet из задачи (SheetHeader с red ✓) 03-reschedule
//      - TaskJournal из задачи (SheetHeader + TextField) 04-task-journal
//      - ChatStatsSheet из чата (SheetHeader без действия) 05-chat-stats
//      - RoleContextSheet из «Агентов» (SheetHeader без действия) 06-role-context
//      - AttachmentViewerSheet (SheetHeader с plain arrowDown) 07-attachment
//      - ChatsScreen пустой (EmptyState) — если у владельца нет чатов,
//        кадр показывает EmptyState в кружке. 08-chats-empty
//
//   3. Кадры кладутся в docs/2026-10-05-mak54-inputs-states/web/
//      по подпапкам light/ и dark/.
//
// Запуск:
//   node scripts/screenshot-mak54.mjs
//
// Требует работающий dev-сервер (npm run dev на :5180) с поднятым
// backend на :3001 и TASKFLOW_LAN_NO_AUTH=1. RequireAuth сам залогинится
// через POST /api/auth/lan (нужен реальный chromium с UA Mozilla/*).

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "docs/2026-10-05-mak54-inputs-states", "web");

const VIEWPORT = { width: 402, height: 874 };
const BASE = "https://localhost:5180";

// zustand persist в App.tsx читает localStorage и ставит data-theme на
// <html>. Поэтому до загрузки приложения нам достаточно положить
// settings.theme в persist-стейт (version 4, как в сторе).
const PERSIST = (theme) => ({
  state: {
    settings: { theme, calendarView: "month" },
    taskLayout: { inbox: "list", today: "list" },
    upcomingLayout: "list",
    collapsedInboxProjects: {},
    plannerVisibleProjects: {},
  },
  version: 4,
});

async function shoot(page, url, file, settle = 3000) {
  await page.goto(url, { waitUntil: "networkidle" });
  // Анимации входа (шапка, шторка, спиннер) длятся до ~700мс. Шторки
  // открываются на 100мс медленнее из-за пружины useBottomSheet.
  await page.waitForTimeout(settle);
  const out = join(OUT_DIR, file);
  await page.screenshot({ path: out, fullPage: false });
  console.log("wrote", out);
}

async function openSheet(page, buttonSelector, settle = 2500) {
  // useBottomSheet поднимает шторку через setMounted(true) + spring;
  // после клика достаточно подождать анимацию входа.
  await page.click(buttonSelector);
  await page.waitForTimeout(settle);
}

async function runTheme(theme) {
  const dir = join(OUT_DIR, theme);
  await mkdir(dir, { recursive: true });

  const browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  // Подкидываем persist до загрузки приложения, иначе App.tsx поставит
  // дефолтную тёмную тему.
  await ctx.addInitScript((persist) => {
    localStorage.setItem("taskflow-app", JSON.stringify(persist));
  }, PERSIST(theme));

  const page = await ctx.newPage();

  // 01 — SettingsScreen: тут Switch (тема), TextField (поиск),
  // FieldGroup со строками и Button. Показывает сразу всё §2.7–2.8.
  await shoot(page, `${BASE}/settings`, `${dir}/01-settings.png`);

  // 02 — TaskFilterSheet из «Сегодня». «Сегодня» = /today.
  // На /today в шапке есть кнопка-фильтр (см. TodayScreen header actions).
  await shoot(page, `${BASE}/today`, `${dir}/02-today-base.png`);
  // Кнопка-фильтр в TodayScreen — третья слева в правой группе шапки
  // (после плюса и колокольчика). Стабильный селектор — aria-label.
  const filterBtn = page.locator('button[aria-label="Фильтры"]').first();
  if (await filterBtn.count()) {
    await openSheet(page, 'button[aria-label="Фильтры"]');
    await shoot(page, `${BASE}/today`, `${dir}/02-task-filter.png`, 1500);
    // Закрываем шторку перед следующим кадром.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(800);
  } else {
    console.warn("Filter button not found on /today");
  }

  // 03 — RescheduleSheet: открывается через кнопку «Перенести» в
  // секции «Просрочено» на /today. Появляется только при наличии
  // просроченных задач; если их нет — пропускаем (нет сценария).
  const rescheduleBtn = page
    .locator('button:has-text("Перенести")')
    .first();
  if (await rescheduleBtn.count()) {
    await rescheduleBtn.click();
    await page.waitForTimeout(2000);
    await shoot(page, `${BASE}/today`, `${dir}/03-reschedule.png`, 1500);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(800);
  } else {
    console.warn("Reschedule trigger not present (no overdue tasks)");
  }

  // 04 — TaskJournal: открывается из карточки задачи; если ни одной
  // задачи — пропускаем. Перед этим тапнем по первой задаче.
  const firstTask = page.locator('a[href^="/tasks/"]').first();
  if (await firstTask.count()) {
    await firstTask.click();
    await page.waitForTimeout(1500);
    // Ищем кнопку «Заметка»/«Добавить запись» в TaskDetail.
    const journalBtn = page
      .locator(
        'button:has-text("Заметка"), button:has-text("Добавить запись"), button:has-text("Дневник")',
      )
      .first();
    if (await journalBtn.count()) {
      await journalBtn.click();
      await page.waitForTimeout(2000);
      await shoot(page, page.url(), `${dir}/04-task-journal.png`, 1500);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(800);
    } else {
      console.warn("Journal button not found in task detail");
    }
    await page.goBack().catch(() => {});
    await page.waitForTimeout(800);
  } else {
    console.warn("No tasks on /today — skip TaskJournal");
  }

  // 05 — ChatStatsSheet из чата: /chats/<id>. У владельца минимум один
  // чат с «Секретарём». Идём в первый попавшийся.
  await shoot(page, `${BASE}/chats`, `${dir}/05-chats-list.png`);
  const firstChat = page.locator('a[href^="/chats/"]').first();
  if (await firstChat.count()) {
    await firstChat.click();
    await page.waitForTimeout(1500);
    await shoot(page, page.url(), `${dir}/05-chat-room.png`);
    // aria-label в ChatScreen.tsx: «Кого озадачивают чаще всего».
    const statsBtn = page
      .locator('button[aria-label="Кого озадачивают чаще всего"]')
      .first();
    if (await statsBtn.count()) {
      await statsBtn.click();
      await page.waitForTimeout(2000);
      await shoot(page, page.url(), `${dir}/05-chat-stats.png`, 2000);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(800);
    } else {
      console.warn("Chat stats button not found");
    }
  } else {
    console.warn("No chats found");
  }

  // 06 — RoleContextSheet из AgentsScreen.
  await shoot(page, `${BASE}/agents`, `${dir}/06-agents.png`);
  // Кнопка открытия RoleContextSheet — карточка роли с обработчиком;
  // проще открыть через тап по карточке «Текущая роль» в шапке.
  const roleCard = page
    .locator('button[aria-label="Контекст запуска"], [data-role-context]')
    .first();
  if (await roleCard.count()) {
    await roleCard.click();
    await page.waitForTimeout(1500);
    await shoot(page, page.url(), `${dir}/06-role-context.png`, 1500);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(800);
  } else {
    console.warn("Role context trigger not found");
  }

  // 07 — AttachmentViewerSheet: открывается по тапу на вложение в
  // карточке задачи. Если ни у одной задачи нет вложений — пропускаем.
  await page.goto(`${BASE}/today`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const task2 = page.locator('a[href^="/tasks/"]').first();
  if (await task2.count()) {
    await task2.click();
    await page.waitForTimeout(1500);
    const attachment = page
      .locator('[data-attachment], button[aria-label*="Открыть"]')
      .first();
    if (await attachment.count()) {
      await attachment.click();
      await page.waitForTimeout(2000);
      await shoot(page, page.url(), `${dir}/07-attachment.png`, 2000);
    } else {
      console.warn("No attachment to open — skip 07");
    }
  }

  // 08 — EmptyState: ChatsScreen у владельца обычно НЕ пустой (есть
  // «Секретарь»). Снимем как есть, а если пустой — кадр сам покажет
  // EmptyState.
  await shoot(page, `${BASE}/chats`, `${dir}/08-chats.png`);

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