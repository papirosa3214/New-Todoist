import { test, expect } from "@playwright/test";
import { setupApp, openScreen, collectErrors, dragBy } from "./helpers";

/** Плашка задачи внутри сетки часов (DayHours → TimedBlock). Тот же
 *  селектор, что в today-hours.spec.ts — компонент один и тот же, только
 *  теперь может рисоваться и здесь. */
const TIMED_BLOCK = "div.absolute.select-none.overflow-hidden";

// «Предстоящее» — календарные виды «неделя» и «месяц» (UpcomingCalendar.tsx).
//
// Неделя владелец 19.08.2026 просил сделать СТАТИЧНОЙ: «зачем здесь
// скроллить, вся неделя на экране — статика, абсолютная статика». Главная
// проверка этого вида — что страница не прокручивается вовсе: высота
// сетки замеряется в useLayoutEffect, и промах замера возвращает именно
// прокрутку (прошлый расчёт формулой из 100dvh промахивался на 25px, а до
// него — на 104px).
//
// Месяц 20.08.2026 стал ПРОТИВОПОЛОЖНЫМ — континуальный вертикальный
// скролл недель («нужно, чтобы бесконечный скролл был вниз-вверх, тоже
// месяца менялись... прям непрерывно и полотном»), заменил прежнее
// «месяц — фикс, свайп меняет страницу целиком» (19.08.2026: «тут
// скроллить нечего»). Здесь проверки другие: список РЕАЛЬНО скроллится,
// подгружает недели без визуального прыжка, автоскроллится к сегодняшнему
// месяцу при открытии, и тонкая линия-разделитель — только на неделе, где
// встречаются два месяца.
//
// Раскрытие дня в месяце — требование не изменилось: «не нужно сжимать
// все остальные, календарь не должен меняться — просто вниз уезжают те
// недели, что ниже». Проверяем ДВЕ вещи разом: полоса появилась И высоты
// рядов не поехали.

const WEEK_GRID = "div.grid.grid-cols-2";
const MONTH_ROW = "div.grid.shrink-0.grid-cols-7";
const MONTH_WEEKDAYS = "div.grid.grid-cols-7.pb-1";
const DAY_STRIP = "div.shrink-0.bg-card.px-3.py-2";
const MONTH_ROW_H = 128;
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

    // Высота ряда — МАКСИМАЛЬНО возможная без скролла (Максим 20.08.2026:
    // «неужели нет свободного места опустить ещё чуть-чуть, на
    // максимально возможный низ» — старый замер промахивался мимо гонки
    // раскладки при первом проходе и терял ~31.5px). Регрессионная
    // проверка: высота ряда заметно выше дозамерного значения 167.1px —
    // если кто-то случайно вернёт однократный синхронный measure() без
    // MutationObserver, тест поймает откат к заниженному числу раньше,
    // чем это заметят глазами.
    const rowHeight = await page.evaluate(
      (sel) =>
        document.querySelector<HTMLElement>(sel)!.getBoundingClientRect()
          .height / 4,
      WEEK_GRID,
    );
    expect(rowHeight).toBeGreaterThan(172);

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

  test("свайп влево-вправо переключает неделю", async ({ page, context }) => {
    // Максим 20.08.2026: «нужно реализовать это влево-вправо, чтобы недели
    // перескакивали» — раньше неделя листалась только тапом по числу в
    // мини-календаре. data-week-day — атрибут, заведённый в WeekGrid
    // специально под этот тест, несёт точную дату дня.
    await setupApp(context, { upcoming: "week" });
    await openScreen(page, "/upcoming");

    const firstDay = () =>
      page.evaluate(() => {
        const cells = document.querySelectorAll("[data-week-day]");
        return cells[0]?.getAttribute("data-week-day") ?? null;
      });

    const grid = page.locator(WEEK_GRID);
    const box = await grid.boundingBox();
    if (!box) throw new Error("сетка недели не найдена");
    const startX = box.x + box.width / 2;
    const startY = box.y + 40;

    const initial = await firstDay();
    expect(initial).not.toBeNull();

    // Свайп влево — следующая неделя (+7 дней).
    await dragBy(page, { x: startX, y: startY }, [-40, -90, -140]);
    await page.waitForTimeout(400);
    const next = await firstDay();
    // Локальными методами Date, как в lib/date.ts addDays() — toISOString()
    // тут даёт другую дату при часовом поясе восточнее UTC (первая попытка
    // теста ошибочно сравнивала UTC-дату с локальной).
    const expectedNext = new Date(initial! + "T00:00:00");
    expectedNext.setDate(expectedNext.getDate() + 7);
    const y = expectedNext.getFullYear();
    const m = String(expectedNext.getMonth() + 1).padStart(2, "0");
    const day = String(expectedNext.getDate()).padStart(2, "0");
    expect(next).toBe(`${y}-${m}-${day}`);

    // И назад — тем же жестом, зеркально.
    await dragBy(page, { x: startX, y: startY }, [40, 90, 140]);
    await page.waitForTimeout(400);
    expect(await firstDay()).toBe(initial);
  });
});

test.describe("«Предстоящее»: месяц", () => {
  test("строки фиксированной высоты, сегодня видно сразу, страница реально скроллится", async ({
    page,
    context,
  }) => {
    await setupApp(context, { upcoming: "month" });
    const errors = collectErrors(page);
    await openScreen(page, "/upcoming");

    const rows = await monthRows(page);
    // Много недель заранее (WEEKS_INITIAL_PAST+FUTURE+1), не шесть — это и
    // есть суть continuous-scroll, 20.08.2026.
    expect(rows.length).toBeGreaterThan(20);
    const heights = rows.map((r) => r.height);
    const spread = Math.max(...heights) - Math.min(...heights);
    expect(
      spread,
      `высоты рядов разошлись: ${heights.join(", ")}`,
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(heights[0] - MONTH_ROW_H)).toBeLessThanOrEqual(1);

    // Автоскролл к сегодняшней неделе при открытии — иначе первым кадром
    // виден прошлый месяц (WEEKS_INITIAL_PAST недель назад), а не «сейчас»,
    // которое владелец ждёт увидеть сразу.
    const todayVisible = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        "[data-month-grid] .bg-red.font-semibold",
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top <= window.innerHeight;
    });
    expect(todayVisible, "кружок «сегодня» не виден на первом экране").toBe(
      true,
    );

    // Сетка без границ у ОБЫЧНЫХ ячеек-дней (владелец 19.08.2026: «убери
    // всю сетку месяца, чтобы не было вообще этих полосок») — граница
    // теперь бывает только у САМОЙ СТРОКИ переходной недели (см. отдельный
    // тест ниже), не у ячеек внутри.
    const cellBorders = await page.evaluate((sel) => {
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
    expect(cellBorders).toEqual([]);

    // Обратная проверка к прежней: раньше страница НЕ должна была
    // прокручиваться («тут скроллить нечего»), теперь реальный скролл —
    // это и есть вся суть фичи.
    const overflows = await pageOverflow(page);
    expect(
      Math.max(...overflows),
      "список недель не скроллится",
    ).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("переходная неделя двух месяцев отмечена тонкой линией, обычные — нет", async ({
    page,
    context,
  }) => {
    await setupApp(context, { upcoming: "month" });
    await openScreen(page, "/upcoming");

    const rows = await page.evaluate((sel) => {
      const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
      return els.map((row) => {
        const days = Array.from(row.children).map((c) =>
          (c.textContent ?? "").trim().slice(0, 2).replace(/\D/g, ""),
        );
        return {
          firstDay: days[0],
          lastDay: days[6],
          borderTop: parseFloat(getComputedStyle(row).borderTopWidth) > 0,
        };
      });
    }, MONTH_ROW);

    // Переходная неделя — там, где число в конце строки МЕНЬШЕ числа в
    // начале (месяц перевалил: «29» → «5» вместо «29» → «35»).
    const expectedTransitions = rows
      .map((r, i) => ({
        i,
        isTransition: Number(r.lastDay) < Number(r.firstDay),
      }))
      .filter((r) => r.isTransition)
      .map((r) => r.i);
    expect(expectedTransitions.length).toBeGreaterThan(0);

    for (let i = 0; i < rows.length; i++) {
      // Самая первая строка списка — граница ей не положена, даже если
      // формально переходная: сверху её ничто не отделяет.
      const expected = i > 0 && expectedTransitions.includes(i);
      expect(
        rows[i].borderTop,
        `строка ${i} (${rows[i].firstDay}→${rows[i].lastDay}): граница ${rows[i].borderTop}, ожидалось ${expected}`,
      ).toBe(expected);
    }
  });

  test("подгрузка недель при скролле вверх не сдвигает видимую часть", async ({
    page,
    context,
  }) => {
    // 20.08.2026: добавление недель СВЕРХУ списка отодвигает уже видимый
    // контент вниз, если не скорректировать scrollTop — «без каких-либо
    // заминок» было прямым требованием стиля Google Calendar.
    await setupApp(context, { upcoming: "month" });
    await openScreen(page, "/upcoming");

    const readAnchor = () =>
      page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-month-grid] div.grid.shrink-0.grid-cols-7",
          ),
        );
        // Строка, чей верх ближе всего к верху видимой области — тот же
        // «якорь», что использует человек глазами при скролле.
        let best: { text: string; top: number } | null = null;
        for (const r of rows) {
          const top = r.getBoundingClientRect().top;
          if (top >= -10 && (!best || top < best.top)) {
            best = { text: r.children[0].textContent!.trim(), top };
          }
        }
        return best;
      });

    const before = await readAnchor();
    expect(before).not.toBeNull();

    // Прыгаем близко к самому верху уже построенного диапазона, чтобы
    // гарантированно завести сентинел и подгрузку.
    await page.evaluate(() => {
      let el: HTMLElement | null =
        document.querySelector<HTMLElement>("[data-month-grid]")!.parentElement;
      while (el) {
        if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
          el.scrollTop = 30;
          return;
        }
        el = el.parentElement;
      }
    });
    await page.waitForTimeout(1000);

    const anchorAfterJump = await readAnchor();
    // Дать подгрузке случиться и коррекции отработать, затем сверить, что
    // визуальный якорь (какая строка стоит у верхней кромки) не «уехал».
    await page.waitForTimeout(500);
    const anchorSettled = await readAnchor();
    expect(anchorAfterJump?.text).toBe(anchorSettled?.text);
    expect(
      Math.abs((anchorAfterJump?.top ?? 0) - (anchorSettled?.top ?? 0)),
    ).toBeLessThanOrEqual(2);
  });

  test("тап по дню раскрывает полосу с задачами, нижние недели съезжают вниз", async ({
    page,
    context,
  }) => {
    await setupApp(context, { upcoming: "month" });
    await openScreen(page, "/upcoming");

    const before = await monthRows(page);
    // Много недель заранее — не шесть, см. смок-тест выше. Ряд под тест
    // берём около WEEKS_INITIAL_PAST (та неделя, что реально видна на
    // экране после автоскролла к сегодня, не строка 0..1 — они после
    // 20.08.2026 в основном выше видимой области).
    expect(before.length).toBeGreaterThan(20);
    const targetRow = 9;
    const cell = page.locator(MONTH_ROW).nth(targetRow).locator("> div").nth(2);
    const dayNum = Number((await cell.innerText()).trim().split("\n")[0]);
    expect(Number.isFinite(dayNum)).toBe(true);

    await cell.click();
    await page.waitForTimeout(500);

    const strip = page.locator(DAY_STRIP);
    await expect(strip).toHaveCount(1);
    // Полоса подписана числом и днём недели раскрытого дня — месяц
    // выводим из самой даты, а не зашиваем: любой ряд может оказаться
    // хвостом соседнего месяца.
    const stripText = await strip.innerText();
    expect(stripText).toContain(String(dayNum));
    const monthsInStrip = MONTHS_GEN.filter((m) => stripText.includes(m));
    expect(monthsInStrip.length).toBe(1);

    const after = await monthRows(page);
    expect(after.length).toBe(before.length);

    // Ряды ВЫШЕ раскрытого дня (и он сам) стоят на месте…
    for (let i = 0; i <= targetRow; i++) {
      expect(
        Math.abs(after[i].top - before[i].top),
        `ряд ${i} сдвинулся, хотя он выше раскрытого дня`,
      ).toBeLessThanOrEqual(1);
    }
    // …а те, что ниже, съехали вниз ровно на высоту полосы (владелец
    // 19.08.2026: «не нужно сжимать все остальные... просто вниз уезжают
    // те недели, что ниже»). Не до самого конца списка — там уже вступает
    // подгрузка чанками, сравнивать нечего.
    const stripBox = (await strip.boundingBox())!;
    for (
      let i = targetRow + 1;
      i < Math.min(targetRow + 5, before.length);
      i++
    ) {
      const shift = after[i].top - before[i].top;
      expect(shift, `ряд ${i} не съехал вниз`).toBeGreaterThan(0);
      expect(Math.abs(shift - stripBox.height)).toBeLessThanOrEqual(1);
    }
    // Сам календарь при этом не изменился: высоты рядов те же.
    for (let i = 0; i < before.length; i++) {
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
    for (let i = 0; i <= targetRow; i++) {
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

// «Три дня» — почасовая сетка (DayHours.tsx), перенесённая со «Сегодня»
// 20.08.2026 (владелец: «перенос кода без каких-либо изменений... просто
// нужно сменить локацию»). Сами тесты — тоже перенос: раньше жили в
// today-hours.spec.ts под hoursSpan:3, теперь здесь под upcoming:"hours".
test.describe("«Предстоящее»: три дня", () => {
  test("переключение на 3 дня даёт три колонки с датами", async ({
    page,
    context,
  }) => {
    await setupApp(context, { upcoming: "hours" });
    const errors = collectErrors(page);
    await openScreen(page, "/upcoming");

    const captions = await page
      .locator("span.flex-1.text-center.font-semibold")
      .allTextContents();
    expect(captions.length).toBe(3);
    for (const c of captions) {
      expect(c).toMatch(/^(Пн|Вт|Ср|Чт|Пт|Сб|Вс) \d{1,2}$/);
    }

    // Геометрия подписей обязана совпадать с геометрией самих колонок —
    // это единственное, что удерживает их над своими днями (подписи
    // рендерятся в шапке, а колонки в сетке, общего родителя у них нет).
    const aligned = await page.evaluate(() => {
      const caps = Array.from(
        document.querySelectorAll<HTMLElement>(
          "span.flex-1.text-center.font-semibold",
        ),
      ).map((e) => e.getBoundingClientRect());
      const cols = Array.from(
        document.querySelectorAll<HTMLElement>("div.relative.min-w-0.flex-1"),
      ).map((e) => e.getBoundingClientRect());
      return {
        caps: caps.length,
        cols: cols.length,
        diffs: caps.map((c, i) =>
          cols[i]
            ? +(
                c.left +
                c.width / 2 -
                (cols[i].left + cols[i].width / 2)
              ).toFixed(1)
            : null,
        ),
      };
    });
    expect(aligned.cols).toBe(3);
    for (const d of aligned.diffs) expect(Math.abs(d!)).toBeLessThanOrEqual(1);

    expect(errors).toEqual([]);
  });

  test("задачу можно перетащить в соседнюю колонку дня", async ({
    page,
    context,
  }) => {
    // 20.08.2026: раньше draggable в DayHours был только у 1-дневного вида
    // (interactive = days.length===1) — владелец попросил снять это
    // ограничение, «между днями тоже должны ездить». Перехват PATCH —
    // проверяем ИМЕННО тело запроса (due_date сменился на колонку, куда
    // отпустили), в живую базу ничего не пишем (см. helpers.ts).
    const written = await setupApp(context, { upcoming: "hours" });
    await openScreen(page, "/upcoming");

    const blocks = page.locator(TIMED_BLOCK);
    const count = await blocks.count();
    test.skip(count === 0, "в базе сейчас нет ни одной задачи со временем");

    const source = blocks.first();
    const box = await source.boundingBox();
    if (!box) throw new Error("у плашки задачи нет геометрии");

    // Колонки дня равной ширины, GUTTER_W (161/3) слева под подписи часов
    // — под неё драг не заводим, есть свои проверки на выход за сетку.
    // Столбец назначения — следующий по кругу от исходного (в какой
    // колонке ни оказался бы source, «+1 колонка вправо/влево по модулю
    // 3» гарантированно другая дата). data-day-col — атрибут, заведённый
    // в DayHours.tsx специально под этот тест, несёт саму дату колонки.
    const gridBox = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-day-col]")).map(
        (e) => {
          const r = e.getBoundingClientRect();
          return { date: e.dataset.dayCol!, left: r.left, width: r.width };
        },
      ),
    );
    expect(gridBox.length).toBe(3);
    const startColIndex = gridBox.findIndex(
      (c) => box.x >= c.left - 2 && box.x < c.left + c.width + 2,
    );
    expect(startColIndex).toBeGreaterThanOrEqual(0);
    const targetColIndex = (startColIndex + 1) % gridBox.length;
    const targetDate = gridBox[targetColIndex].date;
    const targetX =
      gridBox[targetColIndex].left + gridBox[targetColIndex].width / 2;

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    // Долгий жест с промежуточными шагами — тот же приём, что у dragBy в
    // helpers.ts: MouseSensor(distance:4) требует реального движения, не
    // телепорта, иначе перетаскивание не активируется вовсе.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const x = startX + ((targetX - startX) * i) / steps;
      await page.mouse.move(x, startY, { steps: 2 });
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);

    const patch = written.find(
      (w) => w.method === "PATCH" && w.url.includes("/api/tasks/"),
    );
    expect(patch, "перетаскивание не отправило PATCH").toBeTruthy();
    const body = patch!.body as { due_date?: string; start_time?: string };
    // Дата назначения — ровно колонка targetColIndex, не исходная и не
    // случайная: единственная проверка, которая реально ловит регресс
    // «X не учитывается» (старая реализация писала бы либо ничего, либо
    // всегда исходную дату — X полностью игнорировался).
    expect(body.due_date).toBe(targetDate);
    expect(body.start_time).toBeTruthy();
  });
});
