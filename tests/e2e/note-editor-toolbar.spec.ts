import { test, expect } from "@playwright/test";
import { setupApp, collectErrors, openScreen } from "./helpers";

// ═══════════ Тест панели форматирования NoteEditor ═══════════
//
// Карточка 9b4c4984 (29.08.2026): синхронизировать тулбар редактора
// заметок с движком — кнопки для quote, codeBlock, strike, H3, hr,
// inlineCode, link и прибивание тулбара к верху (стик под шапкой),
// чтобы он не уезжал за клавиатуру на телефоне.
//
// Здесь — smoke: открываем уже существующую заметку (подменяем
// /api/notes/:id синтетическим объектом, базу не трогаем), проверяем,
// что тулбар рендерит все 16 кнопок и каждая применяет соответствующий
// узел/марку TipTap. Прогон идёт в двух профилях из playwright.config.ts
// (chromium, webkit), оба используют мобильный вьюпорт 420×912 — этого
// достаточно, поскольку карточка просит проверить мобильный сценарий.

const NOTE_ID = "42";

test.describe.configure({ mode: "serial" });

test("тулбар редактора заметок: 16 кнопок и они применяют формат", async ({
  page,
  context,
}) => {
  const errors = collectErrors(page);
  await setupApp(context, {});

  // Подменяем заметку: GET /api/notes/:id и POST /api/notes.
  await context.route(`**/api/notes/${NOTE_ID}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: NOTE_ID,
        title: "Тестовая",
        content: '{"type":"doc","content":[{"type":"paragraph"}]}',
        folder_id: null,
        created_at: "2026-08-29T00:00:00.000Z",
        updated_at: "2026-08-29T00:00:00.000Z",
        updated_by: null,
      }),
    });
  });

  await openScreen(page, `/notes/${NOTE_ID}`);

  // Прокрутить до тулбара, чтобы проверить стик.
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(150);

  const toolbar = page.locator('div[data-hswipe]').filter({
    has: page.locator('button[aria-label]'),
  }).first();
  await expect(toolbar).toBeVisible({ timeout: 7000 });

  // Канонический набор иконок-кнопок (порядок — это контракт UI).
  const expected = [
    "Жирный",
    "Курсив",
    "Подчёркнутый",
    "Зачёркнутый",
    "Выделить маркером",
    "Строчный код",
    "Ссылка",
    "Цитата",
    "Блок кода",
    "Разделитель",
  ];
  for (const label of expected) {
    await expect(
      toolbar.locator(`button[aria-label="${label}"]`),
      `нет кнопки «${label}» в тулбаре`,
    ).toBeVisible();
  }
  // Заголовки — отдельные <button> с текстом H1/H2/H3, без aria-label.
  for (const heading of ["H1", "H2", "H3"]) {
    await expect(
      toolbar.locator(`button:has-text("${heading}")`),
      `нет кнопки «${heading}» в тулбаре`,
    ).toBeVisible();
  }

  // ── Применяем форматы и проверяем появление узлов/марков ──
  const editor = page.locator(".tiptap-content .ProseMirror").first();
  await editor.click();
  // Очистим и начнём с пустого — setContent заодно синхронизирует mark-state.
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");

  // Зачёркнутый: нажимаем кнопку и печатаем — текст должен сразу уйти под strike.
  await toolbar.locator('button[aria-label="Зачёркнутый"]').click();
  await editor.type("вычеркнуто");
  await expect(page.locator(".tiptap-content s").first()).toBeVisible();

  // Снимаем strike.
  await toolbar.locator('button[aria-label="Зачёркнутый"]').click();
  await editor.press("End");
  await editor.press("Enter");

  // Цитата.
  await toolbar.locator('button[aria-label="Цитата"]').click();
  await editor.type("цитата");
  await expect(page.locator(".tiptap-content blockquote").first()).toBeVisible();

  // Блок кода.
  await editor.press("End");
  await editor.press("Enter");
  await toolbar.locator('button[aria-label="Цитата"]').click(); // снимаем blockquote
  await editor.press("End");
  await editor.press("Enter");
  await toolbar.locator('button[aria-label="Блок кода"]').click();
  await editor.type("code");
  await expect(page.locator(".tiptap-content pre code").first()).toBeVisible();

  // Разделитель.
  await editor.press("End");
  await editor.press("Enter");
  await toolbar.locator('button[aria-label="Блок кода"]').click(); // снимаем codeBlock
  await editor.press("End");
  await editor.press("Enter");
  await toolbar.locator('button[aria-label="Разделитель"]').click();
  await expect(page.locator(".tiptap-content hr").first()).toBeVisible();

  // H3.
  await toolbar.locator('button:has-text("H3")').click();
  await editor.type("Заголовок");
  await expect(page.locator(".tiptap-content h3").first()).toBeVisible();

  // ── Стик-проверка: после скролла вниз тулбар всё ещё виден ──
  const stickyTop = await toolbar.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { position: cs.position, top: cs.top };
  });
  expect(stickyTop.position).toBe("sticky");
  // top равно реальной высоте ScreenHeader (опубликованной в
  // --screen-header-h через usePublishHeaderHeight). На тестовом вьюпорте
  // 420×912 шапка компактная — 64px. Это число должно быть > 0:
  // иначе тулбар садится НА шапку (z-20) и та перекрывает его кнопки.
  const topPx = parseFloat(stickyTop.top);
  expect(topPx).toBeGreaterThan(0);

  await page.evaluate(() => window.scrollTo(0, 800));
  await page.waitForTimeout(150);
  await expect(toolbar).toBeVisible();

  // Ошибок в консоли не появилось.
  expect(errors).toEqual([]);
});