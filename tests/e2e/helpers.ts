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
    upcoming?: "list" | "week" | "month" | "hours";
  } = {},
): Promise<Written[]> {
  const state = {
    taskLayout: { inbox: ui.inbox ?? "list", today: ui.today ?? "list" },
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

// Обязательные поля ApiTask, которые фикстуре ниже незачем перечислять
// каждый раз — значения-заглушки, ничего не значащие для проверок клавиатуры.
const TASK_DEFAULTS = {
  description: null,
  due_date: null,
  project_id: null,
  priority: 4,
  assignee_id: null,
  creator_id: "e2e-fixture-owner",
  status: "active",
  created_at: "2026-08-20T00:00:00.000Z",
  updated_at: "2026-08-20T00:00:00.000Z",
  completed_at: null,
  position: null,
  labels: [],
  subtasks: [],
  comments: [],
  events: [],
  attachments: [],
};

/**
 * Подменяет ТОЛЬКО GET /api/tasks/:id синтетической карточкой — не читает
 * и не пишет в живую базу владельца. Нужна для сценариев (agent_state
 * "blocked", подзадача "blocked"), которых в реальных данных может не
 * оказаться в момент прогона: прежний подход «найти подходящую задачу в
 * живой базе, иначе test.skip» молча превращает проверку в no-op, стоит
 * только такой задаче исчезнуть с доски (ровно это случилось с проверкой
 * agent_state:"review" 20.08.2026 — она стала попросту не запускаться).
 *
 * creator_id можно не подгонять под реального владельца: isTaskOwner()
 * пропускает и role==="owner", а под живым логином (POST /api/auth/lan,
 * который эта заглушка НЕ трогает) у Максима всегда эта роль — владельческие
 * кнопки появятся независимо от того, кто здесь стоит в creator_id.
 *
 * Регистрируется ПОСЛЕ setupApp(context) в каждом тесте: Playwright
 * запускает более поздний обработчик первым, а он для не-GET сам вызывает
 * route.fallback() и уступает место общей заглушке записи из setupApp.
 */
export async function mockTaskDetail(
  context: BrowserContext,
  task: { id: string; title: string } & Record<string, unknown>,
) {
  const full = { ...TASK_DEFAULTS, ...task };
  await context.route(`**/api/tasks/${task.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(full),
    });
  });
}

/** Открыть экран и дождаться, пока список задач отрисуется. */
export async function openScreen(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
}

// Шум самих движков, к приложению отношения не имеющий. WebKit ругается
// на `interactive-widget` в meta viewport (не поддерживает эту опцию, но
// она нужна Chrome для поведения клавиатуры) — это предупреждение, а не
// дефект, и валить на нём тест бессмысленно.
const ENGINE_NOISE = [
  "interactive-widget",
  "Unrecognized Content-Security-Policy",
];

/** Ошибки консоли и падения — собираем на каждой странице: «экран не
 *  упал» это тоже проверка, и раньше её никто не делал. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (ENGINE_NOISE.some((n) => text.includes(n))) return;
    errors.push("console: " + text.slice(0, 200));
  });
  return errors;
}

/** Вертикальный свайп ПАЛЬЦЕМ, кроссбраузерно.
 *
 *  В Chromium жест шлётся через CDP, в WebKit его нет вовсе
 *  («CDP session is only available in Chromium» — на этом падал первый
 *  прогон на Safari), поэтому там события собираются вручную. Мышью такое
 *  проверять нельзя: перетаскивание мышью страницу не прокручивает, и
 *  проверка «прокрутилось ли» на ней всегда ложная. */
export async function touchSwipeVertical(
  page: Page,
  from: { x: number; y: number },
  offsets: number[],
) {
  const isChromium =
    page.context().browser()?.browserType().name() === "chromium";
  if (isChromium) {
    const cdp = await page.context().newCDPSession(page);
    const send = (type: string, y: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints:
          type === "touchEnd"
            ? []
            : [{ x: from.x, y, radiusX: 12, radiusY: 12, force: 1 }],
      });
    await send("touchStart", from.y);
    for (const dy of offsets) {
      await send("touchMove", from.y + dy);
      await page.waitForTimeout(60);
    }
    await send("touchEnd", from.y + offsets[offsets.length - 1]);
    return;
  }
  await page.evaluate(
    async ({ x, y, offsets }) => {
      const target = document.elementFromPoint(x, y) ?? document.body;
      const make = (type: string, cy: number) => {
        const touch = new Touch({
          identifier: 1,
          target,
          clientX: x,
          clientY: cy,
        });
        return new TouchEvent(type, {
          touches: type === "touchend" ? [] : [touch],
          targetTouches: type === "touchend" ? [] : [touch],
          changedTouches: [touch],
          bubbles: true,
          cancelable: true,
        });
      };
      target.dispatchEvent(make("touchstart", y));
      for (const dy of offsets) {
        target.dispatchEvent(make("touchmove", y + dy));
        await new Promise((r) => setTimeout(r, 60));
      }
      target.dispatchEvent(make("touchend", y + offsets[offsets.length - 1]));
    },
    { x: from.x, y: from.y, offsets },
  );
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
