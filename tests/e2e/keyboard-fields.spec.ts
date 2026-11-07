import { test, expect } from "@playwright/test";
import { setupApp, openScreen, mockTaskDetail } from "./helpers";

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
      root.style.setProperty("--vv-height", `${window.innerHeight - kb}px`);
      root.style.setProperty("--vv-top", `${pan}px`);
    },
    { kb: KB, pan: opts.pan ? PAN : 0 },
  );
  await page.waitForTimeout(250);
}

/**
 * НАСТОЯЩАЯ эмуляция клавиатуры: подменяется window.visualViewport, и
 * приложение само пересчитывает все свои переменные — так же, как на
 * телефоне.
 *
 * Зачем, если есть pressKeyboard. Тот выставляет переменные, которые
 * приложение ВЫЧИСЛЯЕТ, — то есть проверяет вёрстку при заведомо верных
 * числах. Ровно поэтому он и пропустил живую поломку: на телефоне
 * владельца числа выходили другими, и шторка вылезала под клавиатуру,
 * пока тест был зелёным (20.08.2026, его слова: «клавиатура выехала, и
 * ровно в том же месте выехало окно — не решено вообще»).
 *
 * `shrinkLayout` — второй режим WebKit, при котором вместе с видимой
 * областью ужимается и layout-вьюпорт. Тогда разность innerHeight −
 * vv.height равна нулю, и любая вёрстка, опирающаяся на эту разность, не
 * поднимается вообще. Это и есть случай владельца.
 */
async function emulateKeyboard(
  page: import("@playwright/test").Page,
  opts: { shrinkLayout?: boolean } = {},
) {
  await page.evaluate(
    ({ kb, shrink }) => {
      const vv = window.visualViewport!;
      const visible = window.innerHeight - kb;
      Object.defineProperty(vv, "height", {
        value: visible,
        configurable: true,
      });
      Object.defineProperty(vv, "offsetTop", { value: 0, configurable: true });
      if (shrink) {
        Object.defineProperty(window, "innerHeight", {
          value: visible,
          configurable: true,
        });
      }
      vv.dispatchEvent(new Event("resize"));
    },
    { kb: KB, shrink: !!opts.shrinkLayout },
  );
  await page.waitForTimeout(300);
}

/** Нижняя кромка элемента относительно верха экрана. */
async function bottomOf(page: import("@playwright/test").Page, sel: string) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return el.getBoundingClientRect().bottom;
  }, sel);
}

// Текст в ТРИ ПРЕДЛОЖЕНИЯ — прямое требование владельца 20.08.2026: «надо
// написать текст, скажу в три предложения, потому что длина очень сильно
// тоже может ломать схему». И правда может: поле с несколькими строками
// растёт вверх, вместе с ним растёт шторка, и кнопка отправки может уехать
// туда, откуда её не нажать. Короткий текст этого не показывает.
const LONG =
  "Проверяю, как ведёт себя поле, когда текста много, а не одно слово. " +
  "Пишу три предложения подряд, чтобы поле выросло и подвинуло всё, что " +
  "стоит рядом с ним. Если что-то уедет под клавиатуру или обрежется, " +
  "проверка это увидит.";

/**
 * Набрать текст в поле и убедиться, что он записался ЦЕЛИКОМ, а от его
 * длины ничего не уехало под клавиатуру.
 *
 * Печатается посимвольно (pressSequentially), а не подставляется значением:
 * подстановка проверяет только вёрстку, а владелец жаловался именно на
 * «написание» — на то, как поле ведёт себя, пока в него пишут.
 */
async function typeAndCheck(
  page: import("@playwright/test").Page,
  field: import("@playwright/test").Locator,
  opts: { send?: string } = {},
) {
  const line = page.viewportSize()!.height - KB;

  await field.focus();
  await field.pressSequentially(LONG, { delay: 1 });
  await page.waitForTimeout(200);

  // 1. Текст дошёл полностью — ни обрезки, ни потерянных символов.
  expect(await field.inputValue()).toBe(LONG);

  // 2. Само поле осталось в видимой части экрана.
  const rect = await field.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.bottom).toBeLessThanOrEqual(line);

  // 3. И кнопка отправки — иначе текст написан, а отправить его нечем.
  if (opts.send) {
    const btn = page.locator(opts.send).first();
    const btnRect = await btn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    expect(btnRect.top).toBeGreaterThanOrEqual(0);
    expect(btnRect.bottom).toBeLessThanOrEqual(line);
    await expect(btn).toBeEnabled();
  }
}

test.describe("Поля ввода не уезжают под клавиатуру", () => {
  // ДВА РЕЖИМА НАСТОЯЩЕЙ КЛАВИАТУРЫ. Проверка идёт не по переменным, а по
  // подменённому visualViewport: приложение считает всё само, как на
  // телефоне. Второй режим (ужимается и layout-вьюпорт) — тот самый, на
  // котором прежняя вёрстка не поднималась вообще, а тест был зелёным.
  for (const shrinkLayout of [false, true]) {
    test(`окно возврата встаёт над клавиатурой${
      shrinkLayout ? " (layout тоже ужат)" : ""
    }`, async ({ page, context }) => {
      await setupApp(context);
      await openScreen(page, "/inbox");

      const opened = await page.evaluate(async () => {
        const tasks = await (await fetch("/api/tasks")).json();
        const t = tasks.find((x: any) => x.agent_state === "review");
        return t ? t.id : null;
      });
      test.skip(!opened, "нет задачи на проверке");

      await openScreen(page, `/task/${opened}`);
      await page.getByRole("button", { name: "Вернуть на доработку" }).click();
      await page.waitForTimeout(400);

      await emulateKeyboard(page, { shrinkLayout });
      // Шторка выезжает пружиной — даём ей осесть, иначе замер поймает
      // кадр анимации, а не итоговое положение.
      await page.waitForTimeout(700);

      const line = 912 - KB;
      const sheet = await page.evaluate(() => {
        const ta = document.querySelector("textarea");
        const panel = ta?.closest("div.bg-card") as HTMLElement | null;
        const btn = document.querySelector('[aria-label="Отправить"]');
        return {
          panelBottom: panel?.getBoundingClientRect().bottom ?? null,
          fieldBottom: ta?.getBoundingClientRect().bottom ?? null,
          btnBottom: btn?.getBoundingClientRect().bottom ?? null,
        };
      });

      // Вся шторка целиком — над клавиатурой: и панель, и поле, и кнопка.
      expect(sheet.panelBottom).not.toBeNull();
      expect(sheet.panelBottom!).toBeLessThanOrEqual(line + 1);
      expect(sheet.fieldBottom!).toBeLessThanOrEqual(line);
      expect(sheet.btnBottom!).toBeLessThanOrEqual(line);

      // И с настоящим текстом в три предложения: поле растёт, шторка
      // вместе с ним — кнопка отправки обязана остаться нажимаемой.
      await typeAndCheck(page, page.locator("textarea"), {
        send: '[aria-label="Отправить"]',
      });
    });
  }

  // ЗАБЛОКИРОВАННАЯ ЗАДАЧА — жалоба владельца 20.08.2026 (карточка
  // 27ee45ba): «отвечая на заблокированную задачу, всплывает окошко для
  // комментариев... клавиатура закрыта за этим окошком, не могу напечатать
  // ни ничего сделать». Тот же ReturnToWorkSheet, что и «Вернуть на
  // доработку» выше, но по кнопке «Ответить и вернуть в работу» — цикл над
  // ней (agent_state:"review") этот путь НЕ проверяет вообще: разные
  // кнопки, разное состояние задачи, разный тайминг монтирования формы.
  // Фикстура через mockTaskDetail — не ищем задачу в живой базе (в
  // blocked-состоянии её может не быть), не создаём и не трогаем ничего
  // на доске владельца.
  for (const shrinkLayout of [false, true]) {
    test(`окно ответа на блокировку встаёт над клавиатурой${
      shrinkLayout ? " (layout тоже ужат)" : ""
    }`, async ({ page, context }) => {
      await setupApp(context);
      await mockTaskDetail(context, {
        id: "e2e-fixture-blocked-task",
        title: "E2E: заблокированная задача",
        agent_state: "blocked",
        agent_session_id: null,
      });

      await openScreen(page, "/task/e2e-fixture-blocked-task");
      await page
        .getByRole("button", { name: "Ответить и вернуть в работу" })
        .click();
      await page.waitForTimeout(400);

      await emulateKeyboard(page, { shrinkLayout });
      await page.waitForTimeout(700);

      const line = 912 - KB;
      const sheet = await page.evaluate(() => {
        const ta = document.querySelector("textarea");
        const panel = ta?.closest("div.bg-card") as HTMLElement | null;
        const btn = document.querySelector('[aria-label="Отправить"]');
        return {
          panelBottom: panel?.getBoundingClientRect().bottom ?? null,
          fieldBottom: ta?.getBoundingClientRect().bottom ?? null,
          btnBottom: btn?.getBoundingClientRect().bottom ?? null,
        };
      });

      expect(sheet.panelBottom).not.toBeNull();
      expect(sheet.panelBottom!).toBeLessThanOrEqual(line + 1);
      expect(sheet.fieldBottom!).toBeLessThanOrEqual(line);
      expect(sheet.btnBottom!).toBeLessThanOrEqual(line);

      await typeAndCheck(page, page.locator("textarea"), {
        send: '[aria-label="Отправить"]',
      });
    });
  }

  // Тот же самый разбор, но для ШАГА задачи — «Ответить» у заблокированного
  // шага (SubtaskFeed.tsx ReplyForm), а не у задачи целиком: другой
  // компонент, другой механизм подъёма (keepAboveKeyboard/--kb-inset, не
  // --vv-top/--vv-height), другой owner-путь. Существующий тест ниже
  // покрывает только review-«Вернуть», не blocked-«Ответить».
  test("шаг задачи: ответ на блокировку пишется и не уезжает", async ({
    page,
    context,
  }) => {
    await setupApp(context);
    await mockTaskDetail(context, {
      id: "e2e-fixture-blocked-step-task",
      title: "E2E: задача с заблокированным шагом",
      subtasks: [
        {
          id: "e2e-fixture-blocked-step",
          task_id: "e2e-fixture-blocked-step-task",
          title: "Заблокированный шаг",
          done: false,
          position: 0,
          state: "blocked",
          result: null,
          agent_id: null,
        },
      ],
    });

    await openScreen(page, "/task/e2e-fixture-blocked-step-task");
    await page.waitForTimeout(400);

    // Клавиатура поднимается ДО открытия формы — как в живом сценарии,
    // владелец жмёт «Ответить», уже что-то напечатав в другом месте.
    await pressKeyboard(page);

    await page.getByText("Заблокированный шаг", { exact: false }).click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Ответить", exact: true }).click();
    await page.waitForTimeout(600);

    const field = page.getByPlaceholder(
      "Например: доступ уже дал, попробуй ещё раз…",
    );
    await expect(field).toBeVisible();
    await typeAndCheck(page, field);
  });

  // ШАГИ ЗАДАЧИ. У каждого шага своя форма: «Вернуть» у сданного на
  // проверку и «Ответить» у заблокированного. В прежнем тесте их не было
  // вовсе — а владелец пишет комментарии к шагам чаще, чем к задачам.
  test("шаг задачи: комментарий при возврате пишется и не уезжает", async ({
    page,
    context,
  }) => {
    await setupApp(context);
    await openScreen(page, "/inbox");

    // Нужна задача, у которой есть шаг на проверке.
    const target = await page.evaluate(async () => {
      const tasks = await (await fetch("/api/tasks")).json();
      for (const t of tasks) {
        const full = await (await fetch(`/api/tasks/${t.id}`)).json();
        const step = (full.subtasks || []).find(
          (s: any) => s.agent_state === "review" && !s.done,
        );
        if (step) return { taskId: t.id, stepTitle: step.title };
      }
      return null;
    });
    test.skip(!target, "нет ни одного шага на проверке");

    await openScreen(page, `/task/${target!.taskId}`);
    await page.waitForTimeout(600);

    // Клавиатура поднимается ДО открытия формы — так и бывает на телефоне:
    // человек читает шаги, уже написав что-то в комментарий, и жмёт
    // «Вернуть» с открытой клавиатурой. Форма разворачивается внутри
    // прокрученной ленты, и подтянуть её обязана она сама (keepAboveKeyboard).
    await pressKeyboard(page);

    // Шаг раскрывается тапом, под ним появляются «Принять» и «Вернуть».
    await page.getByText(target!.stepTitle, { exact: false }).first().click();
    await page.waitForTimeout(400);
    const back = page.getByRole("button", { name: "Вернуть", exact: true });
    test.skip(
      (await back.count()) === 0,
      "у этого шага нет кнопки возврата (не владелец?)",
    );
    await back.first().click();
    await page.waitForTimeout(600);

    const field = page.getByPlaceholder("Что нужно поправить…");
    await expect(field).toBeVisible();
    await typeAndCheck(page, field);
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

    // И длинный текст сюда же — но с НАСТОЯЩЕЙ эмуляцией клавиатуры:
    // приложение само пересчитывает отступы, лента прокручивается до
    // конца, и поле обязано остаться над клавиатурой вместе с кнопкой
    // отправки.
    await emulateKeyboard(page);
    const commentField = page.getByPlaceholder("Написать комментарий…");
    await commentField.focus();
    await commentField.pressSequentially(LONG, { delay: 1 });
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        'input[placeholder="Написать комментарий…"]',
      );
      let sc: HTMLElement | null = el?.parentElement ?? null;
      while (sc && sc !== document.body) {
        if (/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) break;
        sc = sc.parentElement;
      }
      if (sc) sc.scrollTop = sc.scrollHeight;
    });
    await page.waitForTimeout(300);

    expect(await commentField.inputValue()).toBe(LONG);
    const after = await page.evaluate(() => {
      const el = document.querySelector(
        'input[placeholder="Написать комментарий…"]',
      );
      const btn = document.querySelector('button[type="submit"]');
      return {
        field: el ? el.getBoundingClientRect().bottom : null,
        send: btn ? btn.getBoundingClientRect().bottom : null,
      };
    });
    expect(after.field!).toBeLessThanOrEqual(line);
    expect(after.send!).toBeLessThanOrEqual(line);
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
