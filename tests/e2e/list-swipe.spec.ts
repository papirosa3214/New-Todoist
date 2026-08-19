import { test, expect } from "@playwright/test";
import {
  setupApp,
  openScreen,
  collectErrors,
  dragBy,
  rowGeometry,
  touchSwipeVertical,
} from "./helpers";

// Список задач и жест свайпа. Все проверки ниже написаны по живым жалобам
// владельца 19.08.2026 — каждая из них дошла до него потому, что прежние
// ручные проверки смотрели результат, а не ход жеста.

test.describe("Список задач", () => {
  test("экран открывается без ошибок и строки кликабельны", async ({
    page,
    context,
  }) => {
    await setupApp(context, { inbox: "list" });
    const errors = collectErrors(page);
    await openScreen(page, "/inbox");

    const rows = page.locator("button.tap-row");
    expect(await rows.count()).toBeGreaterThan(0);

    await rows.first().click();
    await page.waitForTimeout(800);
    expect(page.url()).toContain("/task/");
    expect(errors).toEqual([]);
  });

  test("тап без движения НЕ сдвигает строку", async ({ page, context }) => {
    // Жалоба: «мне достаточно просто нажать у краешка — и происходит сразу
    // же сдвиг карточки».
    await setupApp(context, { inbox: "list" });
    await openScreen(page, "/inbox");

    const before = await rowGeometry(page);
    expect(before).not.toBeNull();

    const box = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll("div")).find((d) =>
        d.className.includes("-mx-4 border-b"),
      )!;
      const r = wrap.getBoundingClientRect();
      // Правый краешек — ровно та зона, на которую жаловался владелец.
      return { x: r.right - 6, y: r.top + r.height / 2 };
    });

    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.waitForTimeout(300);
    const during = await rowGeometry(page);
    await page.mouse.up();

    expect(during!.sliderX).toBe(0);
  });

  test("строка едет РОВНО в своих границах, не залезая на соседей", async ({
    page,
    context,
  }) => {
    // Жалоба: «она едет не по разделителю, а по какой-то другой траектории,
    // чуть ниже — как будто подпрыгивает».
    await setupApp(context, { inbox: "list" });
    await openScreen(page, "/inbox");

    const start = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll("div")).find((d) =>
        d.className.includes("-mx-4 border-b"),
      )!;
      const r = wrap.getBoundingClientRect();
      return { x: r.right - 20, y: r.top + r.height / 2 };
    });

    const offenders: string[] = [];
    await dragBy(page, start, [-8, -20, -40, -70, -100], async (dx) => {
      const g = await rowGeometry(page);
      if (!g?.slider) return;
      // Едущий слой обязан оставаться в вертикальных границах своей
      // обёртки на КАЖДОМ кадре жеста, иначе строка «прыгает».
      const outTop = +(g.wrap.top - g.slider.top).toFixed(1);
      const outBottom = +(g.slider.bottom - g.wrap.bottom).toFixed(1);
      if (outTop > 0.5 || outBottom > 0.5)
        offenders.push(`dx=${dx}: сверху ${outTop}, снизу ${outBottom}`);
    });

    expect(offenders).toEqual([]);
  });

  test("кнопка действия не выходит за разделитель и открывается по мере сдвига", async ({
    page,
    context,
  }) => {
    // Жалоба: «на синем видно разделительную линию и потом ещё пару
    // пикселей черноты» + «уже всё прозрачное, уже всё показывается, хотя
    // ещё не сдвинулось».
    await setupApp(context, { inbox: "list" });
    await openScreen(page, "/inbox");

    const start = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll("div")).find((d) =>
        d.className.includes("-mx-4 border-b"),
      )!;
      const r = wrap.getBoundingClientRect();
      return { x: r.right - 20, y: r.top + r.height / 2 };
    });

    const problems: string[] = [];
    await dragBy(page, start, [-6, -30, -92], async (dx) => {
      const g = await rowGeometry(page);
      if (!g?.action || !g.slider) return;
      // Кнопка не должна вылезать за нижнюю кромку обёртки (там линия).
      if (g.action.bottom > g.wrap.bottom + 0.5)
        problems.push(
          `dx=${dx}: кнопка ниже обёртки на ${(g.action.bottom - g.wrap.bottom).toFixed(1)}`,
        );

      // Сколько синего ВИДНО на самом деле — считаем по пикселям кадра, а
      // не по координатам кнопки: кнопка стоит справа всегда, её просто
      // закрывает строка, и геометрия одна ничего не доказывает (первая
      // версия этой проверки именно на этом и ошиблась, объявив дефектом
      // нормальное положение).
      const shot = await page.screenshot({
        clip: {
          x: 0,
          y: Math.round(g.wrap.top + 4),
          width: 420,
          height: Math.max(8, Math.round(g.wrap.bottom - g.wrap.top - 8)),
        },
      });
      const blueWidth = await page.evaluate(async (bytes) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        const bmp = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0);
        const y = Math.floor(bmp.height / 2);
        const row = ctx.getImageData(0, y, bmp.width, 1).data;
        let count = 0;
        // Только правая треть кадра: слева живут синие метки задач
        // («Приложение» и подобные), и первая версия проверки считала
        // синим именно их — тест падал на здоровом экране.
        const from = Math.floor(bmp.width * 0.62);
        for (let x = from; x < bmp.width; x++) {
          const r = row[x * 4],
            g2 = row[x * 4 + 1],
            b = row[x * 4 + 2];
          // Синий акцент: синего заметно больше красного.
          if (b > 120 && b - r > 40 && g2 > 80) count++;
        }
        return count / (bmp.width / 420); // назад в логические px
      }, Array.from(shot));

      const shift = Math.abs(g.sliderX ?? 0);
      // Открылось ровно на сдвиг (± пара пикселей на сглаживание).
      if (blueWidth > shift + 4)
        problems.push(
          `dx=${dx}: синего видно ${blueWidth.toFixed(1)}px при сдвиге ${shift.toFixed(1)}px`,
        );
    });

    expect(problems).toEqual([]);
  });

  test("свайп открывает кнопку, а действие выполняет только нажатие", async ({
    page,
    context,
  }) => {
    await setupApp(context, { inbox: "list" });
    await openScreen(page, "/inbox");

    const start = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll("div")).find((d) =>
        d.className.includes("-mx-4 border-b"),
      )!;
      const r = wrap.getBoundingClientRect();
      return { x: r.right - 20, y: r.top + r.height / 2 };
    });

    await dragBy(page, start, [-40, -110]);
    // Свайп сам по себе никуда не уводит.
    expect(page.url()).not.toContain("/edit");

    const g = await rowGeometry(page);
    expect(Math.abs(g!.sliderX ?? 0)).toBeGreaterThan(60);
    expect(g!.action!.pointerEvents).toBe("auto");

    await page.locator("button[aria-label='Изменить задачу']").first().click();
    await page.waitForTimeout(800);
    expect(page.url()).toContain("/edit");
  });

  test("короткое движение не оставляет строку открытой", async ({
    page,
    context,
  }) => {
    await setupApp(context, { inbox: "list" });
    await openScreen(page, "/inbox");

    const start = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll("div")).find((d) =>
        d.className.includes("-mx-4 border-b"),
      )!;
      const r = wrap.getBoundingClientRect();
      return { x: r.right - 20, y: r.top + r.height / 2 };
    });

    await dragBy(page, start, [-12, -20]);
    const g = await rowGeometry(page);
    expect(Math.abs(g!.sliderX ?? 0)).toBeLessThan(2);
  });

  test("вертикальный жест по строке прокручивает список, а не свайпает", async ({
    page,
    context,
    browserName,
  }) => {
    await setupApp(context, { inbox: "list" });
    await openScreen(page, "/inbox");

    const scrollBefore = await page.evaluate(
      () => document.querySelector(".overflow-y-auto")!.scrollTop,
    );
    const start = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll("div")).find((d) =>
        d.className.includes("-mx-4 border-b"),
      )!;
      const r = wrap.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    // Только Chromium: жест пальцем шлётся через CDP, а в WebKit его нет —
    // ни CDP, ни конструктора Touch («Illegal constructor»), синтетический
    // тач туда не доставить. Мышью проверять нельзя: перетаскивание мышью
    // страницу не прокручивает вовсе. На Safari этот сценарий остаётся за
    // ручной приёмкой владельца.
    test.skip(
      browserName !== "chromium",
      "жест пальцем недоставим в WebKit: нет CDP и конструктора Touch",
    );
    await touchSwipeVertical(page, start, [-40, -120, -220]);
    await page.waitForTimeout(500);

    // Главное здесь — строка НЕ поехала вбок: это проверяется на обоих
    // движках.
    const g = await rowGeometry(page);
    expect(Math.abs(g?.sliderX ?? 0)).toBeLessThan(2);

    // А вот «страница при этом прокрутилась» честно проверяется только в
    // Chromium: там жест идёт через CDP и браузер обрабатывает его как
    // настоящий. Синтетические TouchEvent, которыми приходится обходиться
    // в WebKit, нативную прокрутку не запускают вовсе — проверка там
    // говорила бы о движке, а не о приложении.
    if (browserName === "chromium") {
      const scrollAfter = await page.evaluate(
        () => document.querySelector(".overflow-y-auto")!.scrollTop,
      );
      expect(scrollAfter).not.toBe(scrollBefore);
    }
  });
});
