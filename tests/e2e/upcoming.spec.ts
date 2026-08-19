import { test, expect } from "@playwright/test";
import { setupApp, openScreen, collectErrors, dragBy } from "./helpers";

// «Предстоящее» — календарные виды «неделя» и «месяц» (UpcomingCalendar.tsx).
//
// Оба вида владелец 19.08.2026 просил сделать СТАТИЧНЫМИ: «зачем здесь
// скроллить, вся неделя на экране — статика, абсолютная статика» и «тут
// скроллить нечего, сам календарик пусть будет фикс, а скроллить буду
// задачи внутри открывшегося окна». Поэтому главная проверка обоих видов —
// что страница не прокручивается вовсе: высота сеток замеряется в
// useLayoutEffect, и промах замера возвращает именно прокрутку (прошлый
// расчёт формулой из 100dvh промахивался на 25px, а до него — на 104px).
//
// Вторая тема — раскрытие дня в месяце. Требование дословно: «не нужно
// сжимать все остальные, календарь не должен меняться — просто вниз уезжают
// те недели, что ниже». То есть проверять надо ДВЕ вещи разом: полоса
// появилась И высоты рядов не поехали.

const WEEK_GRID = "div.grid.grid-cols-2";
const MONTH_ROW = "div.grid.min-h-0.shrink-0.grid-cols-7";
const MONTH_WEEKDAYS = "div.grid.grid-cols-7.pb-1";
const DAY_STRIP = "div.shrink-0.bg-card.px-3.py-2";
const MONTHS_NOM = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];
const MONTHS_GEN = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

/** Насколько страница вообще может прокрутиться — по всем контейнерам
 *  прокрутки сразу, чтобы не гадать, какой именно из них «тот самый». */
function pageOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".overflow-y-auto")).map(
      (el) => el.scrollHeight - el.clientHeight,
    ),
  );
}

/** То же, но ровно у контейнера прокрутки СТРАНИЦЫ (тот же обход вверх,
 *  что делает findScrollContainer в UI.tsx). Нужен там, где на экране уже
 *  есть свой законный внутренний скроллер — у раскрытой полосы дня список
 *  задач намеренно прокручивается (max-h-[180px]), и общий замер по всем
 *  .overflow-y-auto считал бы это поломкой страницы. */
function pageScrollerOverflow(
  page: import("@playwright/test").Page,
  anchorSel: string,
) {
  return page.evaluate((sel) => {
    let el: HTMLElement | null =
      document.querySelector<HTMLElement>(sel)!.parentElement;
    while (el && el !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY))
        return el.scrollHeight - el.clientHeight;
      el = el.parentElement;
    }
    return (
      document.documentElement.scrollHeight -
      document.documentElement.clientHeight
    );
  }, anchorSel);
}

/** Тексты рядов месяца: геометрия каждого ряда сетки. */
function monthRows(page: import("@playwright/test").Page) {
  return page.evaluate(
    (sel) =>
      Array.from(document.querySelectorAll<HTMLElement>(sel)).map((el) => {
        const r = el.getBoundingClientRect();
        return { top: +r.top.toFixed(2), height: +r.height.toFixed(2) };
      }),
    MONTH_ROW,
  );
}

test.describe("«Предстоящее»: неделя", () => {
  test("сетка 2×4, первая ячейка — мини-календарь, страница не прокручивается", async ({
    page,
    context,
  }) => {
    await setupApp(context, { upcoming: "week" });
    const errors = collectErrors(page);
    await openScreen(page, "/upcoming");

    const grid = page.locator(WEEK_GRID);
    await expect(grid).toHaveCount(1);

    const shape = await page.evaluate((sel) => {
      const g = document.querySelector<HTMLElement>(sel)!;
      const cells = Array.from(g.children) as HTMLElement[];
      const rows = new Set(
        cells.map((c) => Math.round(c.getBoundingClientRect().top)),
      );
      return {
        cells: cells.length,
        rows: rows.size,
        cols: getComputedStyle(g).gridTemplateColumns.split(" ").length,
        // Мини-календарь — в ПЕРВОЙ ячейке: у него внутри своя сетка 7
        // колонок с буквами дней недели.
        firstHasMiniMonth: !!cells[0].querySelector("div.grid.grid-cols-7"),
        firstText: (cells[0].textContent ?? "").trim().slice(0, 7),
      };
    }, WEEK_GRID);

    // 2 колонки × 4 ряда = 8 ячеек: мини-календарь плюс семь дней недели.
    expect(shape.cells).toBe(8);
    expect(shape.cols).toBe(2);
    expect(shape.rows).toBe(4);
    expect(shape.firstHasMiniMonth).toBe(true);
    // Буквы дней недели мини-календаря начинаются с понедельника — весь
    // календарь этого приложения так построен (см. шапку UpcomingCalendar).
    expect(
      shape.firstText.startsWith("ПВСЧСВ") ||
        shape.firstText.startsWith("ПВСЧПСВ"),
    ).toBe(true);

    // Статика: прокручиваться нечему.
    for (const over of await pageOverflow(page)) expect(over).toBe(0);

    // Подпись месяца — в шапке экрана, под заголовком.
    const headerText = await page.locator("div.fixed.top-0.z-20").innerText();
    expect(headerText).toContain("Предстоящее");
    const now = new Date();
    expect(headerText).toContain(
      `${MONTHS_NOM[now.getMonth()]} ${now.getFullYear()}`,
    );

    expect(errors).toEqual([]);
  });
});

test.describe("«Предстоящее»: месяц", () => {
  test("шесть рядов равной высоты, без границ, страница не прокручивается", async ({
    page,
    context,
  }) => {
    await setupApp(context, { upcoming: "month" });
    const errors = collectErrors(page);
    await openScreen(page, "/upcoming");

    const rows = await monthRows(page);
    expect(rows.length).toBe(6);
    const heights = rows.map((r) => r.height);
    const spread = Math.max(...heights) - Math.min(...heights);
    expect(
      spread,
      `высоты рядов разошлись: ${heights.join(", ")}`,
    ).toBeLessThanOrEqual(1);

    // Сетка без единой линии (владелец 19.08.2026: «убери всю сетку
    // месяца, чтобы не было вообще этих полосок»).
    const borders = await page.evaluate((sel) => {
      const bad: string[] = [];
      document.querySelectorAll<HTMLElement>(sel).forEach((row, ri) => {
        Array.from(row.children).forEach((cell, ci) => {
          const cs = getComputedStyle(cell as HTMLElement);
          const w = [
            cs.borderTopWidth,
            cs.borderRightWidth,
            cs.borderBottomWidth,
            cs.borderLeftWidth,
          ];
          if (w.some((v) => parseFloat(v) > 0))
            bad.push(`ряд ${ri}, ячейка ${ci}: ${w.join("/")}`);
        });
      });
      return bad;
    }, MONTH_ROW);
    expect(borders).toEqual([]);

    for (const over of await pageOverflow(page)) expect(over).toBe(0);
    expect(errors).toEqual([]);
  });

  test("тап по дню раскрывает полосу с задачами, нижние недели съезжают вниз", async ({
    page,
    context,
  }) => {
    await setupApp(context, { upcoming: "month" });
    await openScreen(page, "/upcoming");

    const before = await monthRows(page);
    expect(before.length).toBe(6);

    // День берём из ВТОРОГО ряда: под ним есть ряды, которым положено
    // съехать (у шестого ряда сравнивать было бы не с чем). Колонка —
    // третья, чтобы наверняка попасть в текущий месяц, а не в хвост
    // предыдущего.
    const targetRow = 1;
    const cell = page.locator(MONTH_ROW).nth(targetRow).locator("> div").nth(2);
    const dayNum = Number((await cell.innerText()).trim().split("\n")[0]);
    expect(Number.isFinite(dayNum)).toBe(true);

    await cell.click();
    await page.waitForTimeout(500);

    const strip = page.locator(DAY_STRIP);
    await expect(strip).toHaveCount(1);
    // Полоса подписана числом и днём недели раскрытого дня — месяц
    // выводим из самой даты, а не зашиваем: первый ряд месяца легко
    // оказывается хвостом предыдущего.
    const stripText = await strip.innerText();
    expect(stripText).toContain(String(dayNum));
    const monthsInStrip = MONTHS_GEN.filter((m) => stripText.includes(m));
    expect(monthsInStrip.length).toBe(1);

    // Полоса ВСТРАИВАЕТСЯ в календарь, а не удлиняет страницу: нижние
    // недели обрезаются краем, а прокручиваться должен только список задач
    // внутри самой полосы (владелец 19.08.2026: «сам календарик пусть будет
    // фикс, а скроллить буду задачи внутри открывшегося окна»). Именно
    // раскрытое состояние и способно сломать этот договор — свёрнутое
    // проверяется отдельным тестом выше.
    expect(await pageScrollerOverflow(page, MONTH_ROW)).toBe(0);

    const after = await monthRows(page);
    expect(after.length).toBe(6);

    // Ряды ВЫШЕ раскрытого дня (и он сам) стоят на месте…
    for (let i = 0; i <= targetRow; i++) {
      expect(
        Math.abs(after[i].top - before[i].top),
        `ряд ${i} сдвинулся, хотя он выше раскрытого дня`,
      ).toBeLessThanOrEqual(1);
    }
    // …а те, что ниже, съехали вниз ровно на высоту полосы.
    const stripBox = (await strip.boundingBox())!;
    for (let i = targetRow + 1; i < 6; i++) {
      const shift = after[i].top - before[i].top;
      expect(shift, `ряд ${i} не съехал вниз`).toBeGreaterThan(0);
      expect(Math.abs(shift - stripBox.height)).toBeLessThanOrEqual(1);
    }
    // Сам календарь при этом не изменился: высоты рядов те же.
    for (let i = 0; i < 6; i++) {
      expect(
        Math.abs(after[i].height - before[i].height),
        `высота ряда ${i} поехала: было ${before[i].height}, стало ${after[i].height}`,
      ).toBeLessThanOrEqual(1);
    }

    // Повторный тап по тому же дню сворачивает полосу — отдельной кнопки
    // «Свернуть» намеренно нет.
    await cell.click();
    await page.waitForTimeout(400);
    await expect(strip).toHaveCount(0);
    const back = await monthRows(page);
    for (let i = 0; i < 6; i++) {
      expect(Math.abs(back[i].top - before[i].top)).toBeLessThanOrEqual(1);
    }
  });

  test("свайп влево листает месяц, короткое движение — нет", async ({
    page,
    context,
  }) => {
    await setupApp(context, { upcoming: "month" });
    await openScreen(page, "/upcoming");

    const monthLabel = async () => {
      const t = await page.locator("div.fixed.top-0.z-20").innerText();
      return MONTHS_NOM.find((m) => t.includes(m)) ?? null;
    };

    const start = await page.evaluate((sel) => {
      // Жест кладём на строку дней недели («Пн Вт Ср …»), а не на ячейки:
      // она принадлежит той же сетке (обработчики свайпа висят на её
      // корне), но не несёт onClick, поэтому короткое движение не начнёт
      // заодно раскрывать день и не смешает два эффекта в одной проверке.
      //
      // Строку берём ОТ САМОЙ СЕТКИ вверх по дереву, а не селектором по
      // классам: у ленты-выборщика вида «список» разметка тех же классов,
      // и она хоть и спрятана (hidden), но в DOM остаётся первой — её
      // прямоугольник нулевой, и жест уходил бы в точку (-40; 0) мимо
      // экрана. Этот промах и был причиной «свайп не листает».
      const row = document.querySelector<HTMLElement>(sel)!;
      const grid = row.parentElement!.parentElement!;
      const header = grid.firstElementChild as HTMLElement;
      const r = header.getBoundingClientRect();
      // Две точки старта, а не одна: жест не должен уводить курсор за
      // границу окна — событие туда просто не доедет (проверено: свайп
      // вправо из правого края экрана не долистывал месяц обратно).
      return {
        fromRight: { x: r.right - 40, y: r.top + r.height / 2 },
        fromLeft: { x: r.left + 40, y: r.top + r.height / 2 },
      };
    }, MONTH_ROW);

    const initial = await monthLabel();
    expect(initial).not.toBeNull();

    // Короткое движение (25px) — порог свайпа 70px, месяц листаться не
    // должен: владелец 19.08.2026 просил «свайп прям нормальный, чтобы не
    // в пол пинка он улетал».
    await dragBy(page, start.fromRight, [-10, -25]);
    expect(await monthLabel()).toBe(initial);

    // Полноценный свайп влево — следующий месяц.
    await dragBy(page, start.fromRight, [-40, -90, -140]);
    await page.waitForTimeout(400);
    const next = await monthLabel();
    const expected =
      MONTHS_NOM[(MONTHS_NOM.indexOf(initial!) + 1) % MONTHS_NOM.length];
    expect(next).toBe(expected);

    // И назад вправо — тем же жестом, зеркально.
    await dragBy(page, start.fromLeft, [40, 90, 140]);
    await page.waitForTimeout(400);
    expect(await monthLabel()).toBe(initial);
  });
});
