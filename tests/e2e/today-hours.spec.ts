import { test, expect } from "@playwright/test";
import { setupApp, openScreen, collectErrors } from "./helpers";

// «Сегодня» в виде часов — календарная развёртка дня (DayHours.tsx).
//
// Числа здесь не выдуманы: высота часа 124px/3 = 41.33pt снята замером
// присланного владельцем скриншота (см. шапку DayHours.tsx), и именно на
// ней держится вся сетка. Поэтому проверки ниже сверяют ПОЛОЖЕНИЕ, а не
// факт отрисовки: два живых дефекта 19.08.2026 были ровно про положение —
// линия «сейчас» стояла на 8.5px ниже своего времени (у неё забыли
// -translate-y-1/2, хотя подписи часов центрируются именно так), и сетка
// оставляла свою прокрутку общему контейнеру Layout, из-за чего соседние
// экраны открывались подъехавшими вверх.
const HOUR_H = 124 / 3;

/** Подписи часов в левом жёлобе. text-dim отделяет их от красной подписи
 *  линии «сейчас», которая тоже tabular-nums. */
const HOUR_LABEL = "span.absolute.text-dim.tabular-nums";
/** Подпись времени у линии «сейчас». */
const NOW_LABEL = "span.text-red.tabular-nums";
/** Плашка задачи внутри сетки (TimedBlock). Призрак перетаскивания похож,
 *  но он pointer-events-none и живёт только во время жеста. */
const TIMED_BLOCK = "div.absolute.select-none.overflow-hidden";

/** Переход на другой экран ВНУТРИ приложения (через веер разделов), а не
 *  page.goto: утечка прокрутки проявляется только при смене маршрута без
 *  перезагрузки — общий контейнер Layout.tsx при этом не размонтируется.
 *  С полной перезагрузкой проверка была бы тавтологией. */
async function navigateInApp(
  page: import("@playwright/test").Page,
  label: string,
) {
  await page.locator('button[aria-label^="Открыть меню разделов"]').click();
  await page.waitForTimeout(500);
  await page.locator(`button[aria-label="${label}"]`).click();
  await page.waitForTimeout(1000);
}

test.describe("«Сегодня»: вид часов", () => {
  test("сетка рисуется: подписи часов, подпись даты в шапке, ошибок нет", async ({
    page,
    context,
  }) => {
    await setupApp(context, { today: "hours" });
    const errors = collectErrors(page);
    await openScreen(page, "/today");

    const hourLabels = await page.locator(HOUR_LABEL).allTextContents();
    // Сутки целиком плюс продолжение за их пределы (overscan) — но сами
    // сутки обязаны быть все, от 00:00 до замыкающей 24:00.
    expect(hourLabels).toContain("00:00");
    expect(hourLabels).toContain("12:00");
    expect(hourLabels).toContain("24:00");
    expect(hourLabels.every((t) => /^\d{2}:00$/.test(t))).toBe(true);

    // Подпись даты — «Четверг, 20 авг.» — сам заголовок шапки, не отдельная
    // плашка под ней (владелец 20.08.2026: «четверг, двадцатая — там же,
    // где написано „Сегодня“, прямо в шапке»; было — 19.08.2026, отдельная
    // строка ScreenHeader.below).
    const title = await page.locator("h1").textContent();
    expect(title).toMatch(
      /^(Понедельник|Вторник|Среда|Четверг|Пятница|Суббота|Воскресенье), \d{1,2} [а-я]{3}\.$/,
    );

    expect(errors).toEqual([]);
  });

  test("линия «сейчас» стоит ровно на своём времени", async ({
    page,
    context,
  }) => {
    await setupApp(context, { today: "hours" });
    await openScreen(page, "/today");

    const geom = await page.evaluate(
      ({ nowSel, hourSel }) => {
        const label = document.querySelector<HTMLElement>(nowSel);
        if (!label) return null;
        // Родитель подписи — контейнер линии; его offsetParent и есть сама
        // сетка (единственный position:relative предок). Так верх сетки
        // берётся из раскладки, а не угадыванием по классам.
        const line = label.parentElement!;
        const grid = line.offsetParent as HTMLElement | null;
        if (!grid) return null;
        const gridRect = grid.getBoundingClientRect();
        const r = label.getBoundingClientRect();
        // Подписи часов центрируются по своей отметке (-translate-y-1/2),
        // поэтому и у линии «сейчас» сверять надо ЦЕНТР строки, а не её
        // верх: иначе проверка «сойдётся» на кривом варианте, который
        // владелец и поймал глазами.
        // Центры ВСЕХ подписей часов, отсортированные сверху вниз. По
        // тексту их различать нельзя: шкала продолжена за пределы суток
        // (overscan), и «12:00» на ней встречается дважды — своё и
        // прошлых суток. Поэтому сверяемся с ближайшей по расстоянию и с
        // шагом между соседними.
        const hourCenters = Array.from(
          document.querySelectorAll<HTMLElement>(hourSel),
        )
          .map((el) => {
            const hr = el.getBoundingClientRect();
            return hr.top + hr.height / 2 - gridRect.top;
          })
          .sort((a, b) => a - b);
        return {
          text: (label.textContent ?? "").trim(),
          centerFromGridTop: r.top + r.height / 2 - gridRect.top,
          gridHeight: gridRect.height,
          hourCenters,
          hasDot: !!line.querySelector("span.rounded-full"),
        };
      },
      { nowSel: NOW_LABEL, hourSel: HOUR_LABEL },
    );

    expect(geom, "линия «сейчас» не найдена").not.toBeNull();
    // Точка-маркер слева от линии — часть той же конструкции.
    expect(geom!.hasDot).toBe(true);
    // Высота сетки — ровно сутки: 24 часа по 41.33pt.
    expect(Math.abs(geom!.gridHeight - 24 * HOUR_H)).toBeLessThan(1);

    // Время берём из самой подписи, а не из системных часов: между
    // отрисовкой и замером может пройти смена минуты, и тест падал бы по
    // случайности, а не по делу.
    const [h, m] = geom!.text.split(":").map(Number);
    const expected = (h + m / 60) * HOUR_H;
    expect(
      Math.abs(geom!.centerFromGridTop - expected),
      `подпись «${geom!.text}» стоит на ${geom!.centerFromGridTop.toFixed(1)}px от верха сетки при расчётных ${expected.toFixed(1)}px`,
    ).toBeLessThanOrEqual(1);

    // Перекрёстно, БЕЗ опоры на верх сетки: сколько минут показывает
    // подпись — на столько она и должна отстоять от ближайшей часовой
    // отметки. Это ровно тот замер, которым владелец поймал прежний
    // дефект («19:39 показывалась на 820.7px при расчётных 812.2»).
    const gaps = geom!.hourCenters.map((c) =>
      Math.abs(c - geom!.centerFromGridTop),
    );
    const nearest = Math.min(...gaps);
    const expectedNearest = (Math.min(m, 60 - m) / 60) * HOUR_H;
    expect(Math.abs(nearest - expectedNearest)).toBeLessThanOrEqual(1);

    // И сам шаг шкалы: соседние подписи часов стоят ровно через 41.33pt —
    // без этого предыдущая проверка сошлась бы и на растянутой сетке.
    const steps = geom!.hourCenters
      .slice(1)
      .map((c, i) => c - geom!.hourCenters[i]);
    for (const s of steps) expect(Math.abs(s - HOUR_H)).toBeLessThan(0.5);
  });

  test("плашка задачи в сетке открывает задачу тапом", async ({
    page,
    context,
  }) => {
    await setupApp(context, { today: "hours" });
    await openScreen(page, "/today");

    const blocks = page.locator(TIMED_BLOCK);
    expect(await blocks.count()).toBeGreaterThan(0);

    await blocks.first().click();
    await page.waitForTimeout(900);
    // Короткий тап — «открыть», удержание — «перетащить» (TouchSensor с
    // задержкой 200мс). Здесь проверяется именно первая половина этого
    // договора.
    expect(page.url()).toContain("/task/");
  });

  test("прокрутка сетки не утекает на соседний экран", async ({
    page,
    context,
  }) => {
    // Живой баг 19.08.2026: сетка крутила ОБЩИЙ контейнер контента
    // (Layout.tsx), а он один на всё приложение и при смене маршрута не
    // размонтируется — «Входящие» открывались подъехавшими вверх.
    await setupApp(context, { today: "hours" });
    await openScreen(page, "/today");

    const readScrolls = () =>
      page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>(".overflow-y-auto"),
        ).map((el) => el.scrollTop),
      );

    const onHours = await readScrolls();
    // Предусловие, без которого проверка ниже была бы тавтологией: сетка
    // при открытии действительно прокручивает контейнер к текущему часу.
    expect(Math.max(...onHours)).toBeGreaterThan(0);

    await navigateInApp(page, "Входящие");
    expect(page.url()).toContain("/inbox");

    const onInbox = await readScrolls();
    expect(
      Math.max(...onInbox),
      `после ухода на «Входящие» прокрутка осталась: ${onInbox.join(", ")}`,
    ).toBe(0);
  });
});
