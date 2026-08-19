import { test, expect } from "@playwright/test";
import { setupApp, openScreen, collectErrors } from "./helpers";

// Доска задач — вид «доска» на «Входящих» и «Сегодня».
//
// Почему проверки именно такие: доска собирается из ОДНОГО компонента
// (TaskBoard.tsx), но два экрана дают ему разный состав колонок, и почти
// каждая правка доски 17–19.08.2026 приходила от владельца как замечание о
// ГЕОМЕТРИИ («между краем колонки и экраном полоса фона», «хвостики соседних
// плиток вылазят капитально», «посчитай расстояние от верха плашки до
// первого слова и от последней метки до низа»). Такое ловится замером
// прямоугольников, а не проверкой «карточка отрисовалась».
//
// Карточка на доске — button.tap-row с классом bg-card. Пилюля «Добавить
// задачу» в подвале колонки тоже tap-row, но у неё bg-red/5 и пунктирная
// рамка, поэтому .bg-card её отсекает: без этого «карточек больше нуля»
// проходило бы даже на пустой доске.
const CARD = "[data-board-strip] button.tap-row.bg-card";

test.describe("Доска задач", () => {
  test("доска открывается без ошибок консоли, карточки есть и открываются тапом", async ({
    page,
    context,
  }) => {
    await setupApp(context, { inbox: "board" });
    const errors = collectErrors(page);
    await openScreen(page, "/inbox");

    const cards = page.locator(CARD);
    expect(await cards.count()).toBeGreaterThan(0);

    await cards.first().click();
    await page.waitForTimeout(800);
    // Тап по карточке — это «открыть задачу», а не «начать перетаскивание»:
    // перетаскивание живёт только на выделенной ручке (TaskBoard.tsx), и
    // если бы оно перехватывало нажатие на всей карточке, переход бы не
    // случился.
    expect(page.url()).toContain("/task/");
    expect(errors).toEqual([]);
  });

  test("метка проекта — строкой над названием, решётка и цветной текст без заливки", async ({
    page,
    context,
  }) => {
    // Именно «Сегодня», а не «Входящие»: на доске «Входящих» колонка САМА и
    // есть проект, поэтому showProjectBadge там намеренно выключен
    // (InboxScreen.tsx / BoardColumn.showProjectBadge) — метка на каждой
    // карточке дублировала бы заголовок колонки. Колонки «Сегодня» режут
    // проекты поперёк, и метка там единственный источник этого контекста.
    await setupApp(context, { today: "board" });
    const errors = collectErrors(page);
    await openScreen(page, "/today");

    const badge = await page.evaluate((sel) => {
      const cards = Array.from(document.querySelectorAll<HTMLElement>(sel));
      for (const card of cards) {
        // Метка проекта — единственный элемент карточки с leading-none (он
        // там не косметика: без него у строки 10px сверху остаётся ~4pt
        // полулидинга и воздух карточки перекашивается, см. TaskBoard.tsx).
        const el = card.querySelector<HTMLElement>(
          'div[class*="leading-none"]',
        );
        if (!el || !el.querySelector("svg")) continue;
        const cs = getComputedStyle(el);
        const title = card.querySelector<HTMLElement>(
          'div[class*="line-clamp-2"]',
        );
        const badgeRect = el.getBoundingClientRect();
        const titleRect = title?.getBoundingClientRect();
        return {
          text: (el.textContent ?? "").trim(),
          // Решётка рисуется иконкой (svg), а не символом в тексте.
          hasHashIcon: !!el.querySelector("svg"),
          background: cs.backgroundColor,
          color: cs.color,
          titleColor: title ? getComputedStyle(title).color : null,
          aboveTitle: titleRect
            ? badgeRect.bottom <= titleRect.top + 0.5
            : null,
        };
      }
      return null;
    }, CARD);

    expect(
      badge,
      "на доске «Сегодня» не нашлось карточки с меткой проекта",
    ).not.toBeNull();
    expect(badge!.text.length).toBeGreaterThan(0);
    expect(badge!.hasHashIcon).toBe(true);
    // Метка стоит ВЫШЕ названия, а не в подвале карточки: 19.08.2026 её
    // оттуда и перенесли («пусть везде будет решётка и название, в самом
    // верху, без заливки»).
    expect(badge!.aboveTitle).toBe(true);
    // Без заливки — прозрачный фон, а не пилюля с подложкой, какой она была
    // до 19.08.2026.
    expect(badge!.background).toBe("rgba(0, 0, 0, 0)");
    // Цвет — проекта, а не серый по умолчанию: «#A6A6A6» это подставной
    // цвет для проекта без своего, и он же выдал бы «метка есть, но цвет
    // потерялся». Отдельно сверяемся с цветом названия — метка обязана
    // отличаться от обычного текста.
    expect(badge!.color).not.toBe("rgb(166, 166, 166)");
    expect(badge!.color).not.toBe(badge!.titleColor);
    expect(errors).toEqual([]);
  });

  test("вертикальные поля карточки: воздух сверху и снизу совпадает", async ({
    page,
    context,
  }) => {
    // Прямая просьба владельца 19.08.2026: «посчитай расстояние от верха
    // плашки до первого слова и от последней метки до низа — они должны
    // быть одинаковыми». Отступы карточки при этом НАМЕРЕННО разные
    // (pt-2 против pb-3, см. TaskBoard.tsx), поэтому проверять нужно не
    // padding, а фактические прямоугольники содержимого.
    //
    // ⚠️ ПРОВЕРКА КРАСНАЯ, И ЭТО ОГРАНИЧЕНИЕ САМОЙ ПРОВЕРКИ, А НЕ ДЕФЕКТ.
    // Замер по боксам даёт у всех карточек 8px сверху против 12px снизу —
    // но это ровно padding-top против padding-bottom, потому что верхняя
    // строка-обёртка начинается точно на кромке padding, какой бы элемент
    // в ней ни лежал. То есть в такой форме проверка сводится к «pt-2 ≠
    // pb-3», а эта асимметрия в TaskBoard.tsx сделана НАМЕРЕННО.
    //
    // Как оно на самом деле — снято пипеткой со скриншотов карточек
    // (сканирование строк пикселей, экран @3x, значения в pt):
    //   карточка с аватаркой ............ 12.00 сверху / 12.00 снизу
    //   «Календарные виды…», «тест 2» ... 12.00 / 12.00
    //   «тест» (строчные без выносных) .. 14.00 / 12.00
    //   «Личные дела» (метка проекта) ... 15.00 / 12.00
    // Снизу ровно 12.00 всегда: там пилюли с заливкой, их кромка и есть
    // видимая граница. Сверху воздух зависит от начертания первой строки
    // (у «тест» нет ни заглавных, ни выносных — глифы начинаются ниже), и
    // задуманные 12/12 в типовом случае выдержаны.
    //
    // Вывод: инвариант «воздух сверху = воздух снизу» в 2px по боксам
    // недостижим в принципе, а по чернилам зависит от текста задачи.
    // Проверка оставлена как есть — она документирует замер; решение,
    // менять ли что-то, за владельцем.
    await setupApp(context, { today: "board" });
    await openScreen(page, "/today");

    const measures = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll<HTMLElement>(sel)).map(
        (card) => {
          const rect = card.getBoundingClientRect();
          // Содержимое меряется ТОЛЬКО внутри текстовой колонки. Ручка
          // перетаскивания — сосед колонки, и у неё -my-3: её
          // прямоугольник вылезает выше и ниже контентного бокса карточки,
          // так что наивный обход всех детей вернул бы бессмысленные числа.
          const col = card.querySelector<HTMLElement>(":scope > div.min-w-0");
          if (!col) return null;
          let top = Infinity;
          let bottom = -Infinity;
          let topEl = "";
          let bottomEl = "";
          col.querySelectorAll<HTMLElement>("*").forEach((el) => {
            const r = el.getBoundingClientRect();
            // Пустая обёртка аватарки (w-[24px] без исполнителя) рисуется
            // всегда и имеет нулевую высоту — она не содержимое.
            if (r.height <= 0) return;
            const tag = `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 24)}`;
            if (r.top < top) {
              top = r.top;
              topEl = tag;
            }
            if (r.bottom > bottom) {
              bottom = r.bottom;
              bottomEl = tag;
            }
          });
          if (!Number.isFinite(top)) return null;
          return {
            title: (card.textContent ?? "").trim().slice(0, 30),
            padTop: +(top - rect.top).toFixed(2),
            padBottom: +(rect.bottom - bottom).toFixed(2),
            topEl,
            bottomEl,
          };
        },
      );
    }, CARD);

    const cards = measures.filter((m) => m !== null);
    expect(cards.length).toBeGreaterThan(0);
    const offenders = cards
      .filter((m) => Math.abs(m!.padTop - m!.padBottom) > 2)
      .map(
        (m) =>
          `«${m!.title}»: сверху ${m!.padTop}px (${m!.topEl}), снизу ${m!.padBottom}px (${m!.bottomEl})`,
      );
    expect(offenders).toEqual([]);
  });

  test("колонки прокручиваются вбок, страница при этом не уезжает по вертикали", async ({
    page,
    context,
  }) => {
    // «Входящие», а не «Сегодня»: колонок там по числу проектов. У доски
    // «Сегодня» их часто одна, и тогда полоса намеренно НЕ скроллится
    // (single-режим в TaskBoard.tsx растягивает единственную колонку и
    // центрирует её) — проверять на ней горизонтальную прокрутку значило бы
    // требовать от экрана того, чего он не обещает.
    await setupApp(context, { inbox: "board" });
    await openScreen(page, "/inbox");

    const strip = page.locator("[data-board-strip]");
    const box = await strip.boundingBox();
    expect(box).not.toBeNull();

    const before = await page.evaluate(() => {
      const s = document.querySelector<HTMLElement>("[data-board-strip]")!;
      // Тот же обход вверх, что делает findScrollContainer в UI.tsx, —
      // прокручивается общий контейнер контента из Layout.tsx, и мерить
      // надо именно его, а не первый попавшийся .overflow-y-auto.
      let sc: HTMLElement | null = s.parentElement;
      while (sc && sc !== document.body) {
        if (/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) break;
        sc = sc.parentElement;
      }
      return {
        canScrollX: s.scrollWidth > s.clientWidth,
        scrollLeft: s.scrollLeft,
        pageScrollTop: sc?.scrollTop ?? 0,
        pageScrollHeight: sc?.scrollHeight ?? 0,
        pageClientHeight: sc?.clientHeight ?? 0,
      };
    });
    expect(before.canScrollX).toBe(true);

    // Настоящая прокрутка колёсиком по полосе, а не присвоение scrollLeft:
    // у полосы snap-x snap-mandatory, и важно, что жест доводит её до
    // соседней колонки, а не что число можно записать в свойство.
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(400, 0);
    await page.waitForTimeout(700);

    const after = await page.evaluate(() => {
      const s = document.querySelector<HTMLElement>("[data-board-strip]")!;
      let sc: HTMLElement | null = s.parentElement;
      while (sc && sc !== document.body) {
        if (/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) break;
        sc = sc.parentElement;
      }
      return { scrollLeft: s.scrollLeft, pageScrollTop: sc?.scrollTop ?? 0 };
    });

    expect(after.scrollLeft).toBeGreaterThan(before.scrollLeft);
    // Горизонтальный жест по доске не должен утаскивать за собой страницу:
    // полоса — единственный скроллер, который здесь двигается.
    expect(after.pageScrollTop).toBe(before.pageScrollTop);
  });

  // Жалоба владельца 20.08.2026: «хочу свайпнуть, палец, разумеется,
  // попадает на карточку, и как только отжимаю — меня тут же перекидывает в
  // эту карточку». Карточка — обычная кнопка, а браузер шлёт click по
  // отпусканию независимо от того, ехал палец или нет.
  test("палец проехал по карточке — задача не открывается, а тап на месте открывает", async ({
    page,
    context,
  }) => {
    await setupApp(context, { inbox: "board" });
    await openScreen(page, "/inbox");

    const card = page.locator(CARD).first();
    const box = (await card.boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const urlBefore = page.url();

    // Свайп: нажали на карточке и увели палец вбок далеко за порог тапа.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const dx of [-15, -40, -80, -120]) {
      await page.mouse.move(start.x + dx, start.y, { steps: 3 });
      await page.waitForTimeout(50);
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
    expect(page.url()).toBe(urlBefore);

    // А обычный тап по той же карточке по-прежнему открывает задачу —
    // иначе «починка» сводилась бы к тому, что доска перестала работать.
    await page.locator(CARD).first().click();
    await page.waitForTimeout(800);
    expect(page.url()).toContain("/task/");
  });

  // То же самое ПАЛЬЦЕМ, а не мышью: жалоба про телефон, а мышь ведёт себя
  // иначе (она не прокручивает страницу и не отдаёт жест браузеру). Только
  // Chromium — синтетический тач идёт через CDP, которого в WebKit нет
  // (helpers.ts, touchSwipeVertical: та же причина).
  test("палец: свайп по карточке не открывает задачу", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "синтетический тач — только CDP");
    await setupApp(context, { inbox: "board" });
    await openScreen(page, "/inbox");

    const box = (await page.locator(CARD).first().boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const urlBefore = page.url();

    const cdp = await context.newCDPSession(page);
    const send = (type: string, cx: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints:
          type === "touchEnd"
            ? []
            : [{ x: cx, y, radiusX: 12, radiusY: 12, force: 1 }],
      });
    await send("touchStart", x);
    for (const dx of [-20, -60, -110]) {
      await send("touchMove", x + dx);
      await page.waitForTimeout(60);
    }
    await send("touchEnd", x - 110);
    await page.waitForTimeout(700);

    expect(page.url()).toBe(urlBefore);
  });
});
