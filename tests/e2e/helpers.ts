import type { Page, BrowserContext } from "@playwright/test";

// Общие помощники e2e-набора.
//
// Главное правило здесь: тесты НЕ ПИШУТ в базу владельца. Все PATCH/POST/
// DELETE перехватываются и подтверждаются заглушкой, а проверяется тело
// запроса — «что ушло бы на сервер». Прецедент, из-за которого правило
// появилось: 19.08.2026 диагностический прогон перетаскивания сдвинул
// живую задачу с 11:00 на 23:45, и восстанавливать пришлось замером по
// скриншоту.

export interface Written {
  method: string;
  url: string;
  body: unknown;
}

/** Ставит вид экранов и глушит записи. Возвращает список того, что «ушло
 *  бы» на сервер. */
export async function setupApp(
  context: BrowserContext,
  ui: {
    inbox?: "list" | "board";
    today?: "list" | "board" | "hours";
    hoursSpan?: 1 | 3;
    upcoming?: "list" | "week" | "month";
  } = {},
): Promise<Written[]> {
  const state = {
    taskLayout: { inbox: ui.inbox ?? "list", today: ui.today ?? "list" },
    hoursSpan: ui.hoursSpan ?? 1,
    upcomingLayout: ui.upcoming ?? "list",
  };
  await context.addInitScript((s) => {
    localStorage.setItem(
      "taskflow-ui",
      JSON.stringify({ state: s, version: 0 }),
    );
  }, state);

  const written: Written[] = [];
  await context.route("**/api/**", async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === "GET") return route.continue();
    // Авторизацию глушить НЕЛЬЗЯ: вход по домашней сети — это POST
    // /api/auth/lan, и с заглушкой приложение остаётся неавторизованным,
    // список пуст, а тест падает не по делу (первый же прогон 19.08.2026
    // дал «строк 0» именно из-за этого).
    if (req.url().includes("/api/auth/")) return route.continue();
    written.push({
      method,
      url: req.url(),
      body: (() => {
        try {
          return req.postDataJSON();
        } catch {
          return null;
        }
      })(),
    });
    // Ответ-заглушка: приложению достаточно 200, а данные оно всё равно
    // перечитает своим GET.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  return written;
}

/** Открыть экран и дождаться, пока список задач отрисуется. */
export async function openScreen(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
}

/** Ошибки консоли и падения — собираем на каждой странице: «экран не
 *  упал» это тоже проверка, и раньше её никто не делал. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200));
  });
  return errors;
}

/** Медленный жест пальцем/курсором с промежуточными кадрами: между шагами
 *  можно снимать состояние. Именно этого не хватало прежним проверкам —
 *  они смотрели только результат. */
export async function dragBy(
  page: Page,
  from: { x: number; y: number },
  steps: number[],
  onStep?: (dx: number) => Promise<void>,
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const dx of steps) {
    await page.mouse.move(from.x + dx, from.y, { steps: 3 });
    await page.waitForTimeout(90);
    if (onStep) await onStep(dx);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
}

/** Геометрия строки списка: обёртка, едущий слой и кнопка действия. */
export async function rowGeometry(page: Page, index = 0) {
  return page.evaluate((i) => {
    const wraps = Array.from(document.querySelectorAll("div")).filter((d) =>
      d.className.includes("-mx-4 border-b"),
    );
    const wrap = wraps[i];
    if (!wrap) return null;
    const slider = wrap.querySelector<HTMLElement>(
      ":scope > div:not([aria-label])",
    );
    const action = wrap.querySelector<HTMLElement>(
      "button[aria-label='Изменить задачу']",
    );
    const w = wrap.getBoundingClientRect();
    const s = slider?.getBoundingClientRect();
    const a = action?.getBoundingClientRect();
    const readX = (el: HTMLElement | null | undefined) => {
      if (!el) return null;
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return +m.m41.toFixed(2);
    };
    return {
      wrap: { top: +w.top.toFixed(1), bottom: +w.bottom.toFixed(1) },
      sliderX: readX(slider),
      slider: s
        ? { top: +s.top.toFixed(1), bottom: +s.bottom.toFixed(1) }
        : null,
      action: a
        ? {
            left: +a.left.toFixed(1),
            right: +a.right.toFixed(1),
            top: +a.top.toFixed(1),
            bottom: +a.bottom.toFixed(1),
            width: +a.width.toFixed(1),
            pointerEvents: action
              ? getComputedStyle(action).pointerEvents
              : null,
            opacity: action ? +getComputedStyle(action).opacity : null,
          }
        : null,
    };
  }, index);
}
