import { test, expect, type Page } from "@playwright/test";
import { setupApp, collectErrors } from "./helpers";

// «Составить задачи» (AI-меню «Собрать задачи из текста») на экране
// заметки. Карточка 70697681 (19.09.2026): пользователь нажимал кнопку —
// приложение падало белым экраном. Серверная часть в порядке, ручные
// curl возвращают 200; падение случалось на клиенте при странной форме
// ответа (`tasks.map(...)` без проверки на undefined → TypeError прямо
// в render-phase, ниже ErrorBanner, выше ErrorBoundary — её до правки
// вообще не было).
//
// Проверяем три сценария:
//   1. Штатный ответ 200 + { tasks: [...] } — шторка открывается с
//      предложенными задачами.
//   2. Битый ответ 200 + { tasks: null } — НЕ белый экран, а понятный
//      баннер «AI не нашёл в тексте конкретных задач».
//   3. Пустое тело 200 + "" — то же, что в (2).
//
// Заметка-подопытная — «Do jiiiihk» (id 0b0c2753): короткий текст с
// микрофоном, AI стабильно возвращает одну задачу. Брать первую попавшуюся
// нельзя — аналитический отчёт на 30к символов даёт tasks:[] и тест на
// сценарии (1) падал бы в зависимости от того, что вернёт модель.

const BASE_URL = "https://localhost:5180";
const NOTE_ID = "0b0c2753-4003-4ec1-a1a4-803816cc5641";
const EXTRACT_BUTTON = "Собрать задачи из текста";
const ERROR_BOUNDARY_TEXT = "Что-то пошло не так";

async function openNoteAndOpenAIMenu(page: Page) {
  await page.goto(`${BASE_URL}/notes/${NOTE_ID}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "AI-действия" }).click();
  // Шторка ActionsMenu всплывает с JS-анимацией (useSpring). Webkit ждёт,
  // пока элемент станет «стабильным» (opacity:1 + transform:scale(1)) —
  // без паузы клик приходит на стартовый opacity:0 и считается невидимым.
  await page.locator('[role="menu"]').waitFor({ state: "visible" });
  await page.waitForTimeout(150);
}

async function clickExtractTasks(page: Page) {
  // Webkit дольше «ставит» ActionsMenu в стабильное состояние (JS-spring
  // в useSpring — это кадры, не CSS-transition, проверка «stable» не
  // сходится), и в портретной мобильной вьюпорте кнопка «Собрать
  // задачи из текста» оказывается ниже viewport. dispatchEvent обходит
  // обе проверки: он не скроллит и не ждёт стабильности, и если пункт
  // меню логически видим (в DOM, не перекрыт), нажатие засчитывается.
  await page
    .getByRole("menuitem", { name: new RegExp(EXTRACT_BUTTON) })
    .dispatchEvent("click");
}

test.describe("Notes — AI extract tasks", () => {
  test("штатный ответ: шторка открывается и не падает", async ({ page }) => {
    await setupApp(page.context(), {});
    const errors = collectErrors(page);

    // Подменяем ответ — setupApp глушит все POST, кроме /api/auth/, и
    // возвращает { ok: true }, до extract-tasks запрос не доходит. Для
    // сценария (1) нам нужна форма ответа как от сервера: { tasks: [...] }.
    await page.route("**/api/ai/extract-tasks", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            tasks: [
              { title: "Тестовая задача 1", description: "", priority: 4, due_date: null },
              { title: "Тестовая задача 2", description: "", priority: 3, due_date: null },
            ],
          }),
        });
      } else {
        await route.continue();
      }
    });

    await openNoteAndOpenAIMenu(page);
    await clickExtractTasks(page);

    const sheet = page.locator('[data-overlay] h3:has-text("Задачи из дневника")');
    await expect(sheet).toBeVisible({ timeout: 30_000 });

    const checkboxes = page.locator('[data-overlay] button[aria-label*="списка"]');
    await expect(checkboxes.first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("битый ответ (tasks:null) не даёт белого экрана", async ({ page }) => {
    await setupApp(page.context(), {});
    const errors = collectErrors(page);

    await page.route("**/api/ai/extract-tasks", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ tasks: null }),
        });
      } else {
        await route.continue();
      }
    });

    await openNoteAndOpenAIMenu(page);
    await clickExtractTasks(page);

    // Шторка НЕ открывается (задач нет), но и белого экрана быть не должно.
    await expect(page.locator('p[role="alert"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: ERROR_BOUNDARY_TEXT })).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("пустое тело 200 не даёт белого экрана", async ({ page }) => {
    await setupApp(page.context(), {});
    const errors = collectErrors(page);

    await page.route("**/api/ai/extract-tasks", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "",
        });
      } else {
        await route.continue();
      }
    });

    await openNoteAndOpenAIMenu(page);
    await clickExtractTasks(page);

    await expect(page.locator('p[role="alert"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: ERROR_BOUNDARY_TEXT })).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
