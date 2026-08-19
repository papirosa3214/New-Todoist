import { test, expect } from "@playwright/test";
import { setupApp, openScreen } from "./helpers";

// ПОЛЯ ВВОДА ПРИ ОТКРЫТОЙ КЛАВИАТУРЕ.
//
// Жалоба владельца 20.08.2026: «когда я хочу вернуть на доработку,
// открывается окошко с комментарием ровно там, где клавиатура, — писать
// нечем». И следом: «сделай тест, чтобы он прошёлся по всем полям, где
// нужно что-то вписывать, и всё ли там корректно открывается».
//
// Как это вообще проверить в браузере. Настоящей клавиатуры на десктопе
// нет, и её появление не эмулируется. Но приложение и не смотрит на
// клавиатуру напрямую: вся вёрстка поднимается от двух CSS-переменных,
// которые пишет useVisualViewportInset (--kb-inset для элементов в потоке,
// --kb-height для fixed). Значит клавиатуру можно ЗАДАТЬ: выставить обе
// переменные в реальную высоту (iPhone, русская раскладка с полосой
// подсказок — 336pt) и смотреть, что при этом не уехало под неё.
//
// Проверка одна и та же для всех полей: активное поле и кнопка отправки
// рядом с ним должны остаться выше линии клавиатуры. Ниже этой линии
// пользователь ничего не видит и не может нажать.
const KB = 336;

// Панорамирование: WebKit при фокусе в поле сам подкручивает ВИДИМУЮ
// область к нему, и vv.offsetTop становится ненулевым. Из-за этого две
// переменные расходятся: --kb-inset = высота клавиатуры МИНУС пан (верно
// для элементов в потоке — они уезжают вместе со страницей), --kb-height =
// чистая высота (верно для fixed, который в пане не участвует).
//
// Если в тесте выставить обе одинаково, он перестанет различать эти два
// случая — и пропустит ровно ту ошибку, из-за которой шторка возврата на
// доработку садилась под клавиатуру.
const PAN = 40;

async function pressKeyboard(
  page: import("@playwright/test").Page,
  opts: { pan?: boolean } = {},
) {
  await page.evaluate(
    ({ kb, pan }) => {
      const root = document.documentElement;
      root.style.setProperty("--kb-inset", `${kb - pan}px`);
      root.style.setProperty("--kb-height", `${kb}px`);
    },
    { kb: KB, pan: opts.pan ? PAN : 0 },
  );
  await page.waitForTimeout(250);
}

/** Нижняя кромка элемента относительно верха экрана. */
async function bottomOf(page: import("@playwright/test").Page, sel: string) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return el.getBoundingClientRect().bottom;
  }, sel);
}

test.describe("Поля ввода не уезжают под клавиатуру", () => {
  // Это ровно тот случай, с которого пришла жалоба.
  test("возврат задачи на доработку: поле комментария остаётся видимым", async ({
    page,
    context,
  }) => {
    await setupApp(context);
    await openScreen(page, "/inbox");

    // Нужна задача, сданная агентом на проверку: кнопка «Вернуть на
    // доработку» есть только у неё.
    const opened = await page.evaluate(async () => {
      const res = await fetch("/api/tasks");
      const tasks = await res.json();
      const t = tasks.find((x: any) => x.agent_state === "review");
      return t ? t.id : null;
    });
    test.skip(!opened, "нет задачи на проверке — нечего возвращать");

    await openScreen(page, `/task/${opened}`);
    await page.getByRole("button", { name: "Вернуть на доработку" }).click();
    await page.waitForTimeout(500);

    const field = page.locator("textarea");
    await expect(field).toBeVisible();
    // Шторка `fixed` + autoFocus на поле — тот самый случай, где WebKit
    // панорамирует страницу, а сама шторка в этом не участвует.
    await pressKeyboard(page, { pan: true });

    const viewportH = page.viewportSize()!.height;
    const line = viewportH - KB;

    const fieldBottom = await bottomOf(page, "textarea");
    expect(fieldBottom).not.toBeNull();
    expect(fieldBottom!).toBeLessThanOrEqual(line);

    // И кнопка отправки — писать в поле, которое видно, но нечем
    // отправить, так же бессмысленно.
    const sendBottom = await page.evaluate(() => {
      const b = document.querySelector('[aria-label="Отправить"]');
      return b ? b.getBoundingClientRect().bottom : null;
    });
    expect(sendBottom).not.toBeNull();
    expect(sendBottom!).toBeLessThanOrEqual(line);
  });

  // Лента задачи: поле комментария живёт внизу экрана и подпирается
  // --kb-inset (элемент в потоке — там переменная как раз правильная).
  test("карточка задачи: поле комментария остаётся видимым", async ({
    page,
    context,
  }) => {
    await setupApp(context);
    await openScreen(page, "/inbox");
    const id = await page.evaluate(async () => {
      const tasks = await (await fetch("/api/tasks")).json();
      return tasks[0]?.id ?? null;
    });
    test.skip(!id, "нет ни одной задачи");

    await openScreen(page, `/task/${id}`);
    await page.waitForTimeout(400);

    // Поле живёт в конце прокручиваемой ленты, поэтому проверка тут не
    // «где оно сейчас», а «МОЖЕТ ли оно оказаться над клавиатурой»:
    // поднимаем клавиатуру, прокручиваем ленту до самого низа и смотрим,
    // куда встало поле. Если вёрстка отдаёт клавиатуре её высоту снизу —
    // поле окажется выше линии; если нет — упрётся в низ экрана и уедет
    // под неё, сколько ни скролль.
    await pressKeyboard(page);
    const bottom = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        'input[placeholder="Написать комментарий…"]',
      );
      if (!el) return null;
      let sc: HTMLElement | null = el.parentElement;
      while (sc && sc !== document.body) {
        if (/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) break;
        sc = sc.parentElement;
      }
      if (sc) sc.scrollTop = sc.scrollHeight;
      return el.getBoundingClientRect().bottom;
    });
    await page.waitForTimeout(200);

    const line = page.viewportSize()!.height - KB;
    expect(bottom).not.toBeNull();
    expect(bottom!).toBeLessThanOrEqual(line);
  });

  // Обход всех остальных мест, где что-то вписывают. Каждое поле
  // фокусируется, «клавиатура» поднимается, и поле обязано остаться видимым.
  const PLACES: { path: string; name: string; open?: string }[] = [
    { path: "/search", name: "Поиск" },
    { path: "/projects", name: "Проекты", open: "Новый проект" },
    { path: "/labels", name: "Метки", open: "Новая метка" },
    { path: "/task/new", name: "Новая задача" },
    { path: "/settings", name: "Настройки" },
  ];

  for (const place of PLACES) {
    test(`${place.name}: поле ввода видно при открытой клавиатуре`, async ({
      page,
      context,
    }) => {
      await setupApp(context);
      await openScreen(page, place.path);

      if (place.open) {
        const btn = page.getByRole("button", { name: place.open });
        if (await btn.count()) {
          await btn.first().click();
          await page.waitForTimeout(400);
        }
      }

      const fields = page.locator(
        "input:not([type=hidden]):not([type=file]), textarea",
      );
      const count = await fields.count();
      test.skip(count === 0, "на этом экране нечего вписывать");

      const viewportH = page.viewportSize()!.height;
      const line = viewportH - KB;
      const hidden: string[] = [];

      for (let i = 0; i < Math.min(count, 6); i++) {
        const f = fields.nth(i);
        if (!(await f.isVisible())) continue;
        await f.focus();
        await pressKeyboard(page);
        const rect = await f.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        });
        // Поле должно быть целиком выше линии клавиатуры — и не уехать за
        // верх экрана (второй способ «спрятать» поле).
        if (rect.bottom > line || rect.top < 0) {
          hidden.push(
            `поле ${i}: top=${Math.round(rect.top)} bottom=${Math.round(
              rect.bottom,
            )}, линия ${line}`,
          );
        }
      }

      expect(hidden).toEqual([]);
    });
  }
});
