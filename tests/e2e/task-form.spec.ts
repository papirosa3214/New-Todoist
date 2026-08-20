import { test, expect, type Page } from "@playwright/test";
import { setupApp, openScreen, collectErrors, type Written } from "./helpers";

// Карточка задачи и форма её редактирования.
//
// 19.08.2026 у задачи появились время начала и продолжительность, и владелец
// сразу поставил условие на то, КАК они показываются: «пиши прям тот период,
// который выбран, чтобы мне не нужно было потом высчитывать, во сколько я
// освобожусь». Поэтому время везде печатается интервалом «13:45—14:30», а не
// «13:45 · 45 мин» — это и проверяется ниже, вместе с формой, где интервал
// набирается барабаном и лентой продолжительности (замеры с присланного
// скриншота, см. TaskFields.tsx).
//
// Разделитель интервала — длинное тире U+2014, а не дефис: formatTimeRange в
// lib/date.ts клеит именно его, и проверка с дефисом падала бы впустую.
const RANGE_RE = /\d{2}:\d{2}—\d{2}:\d{2}/;
// Шаг центров строк барабана (95px замера / 3) — им же прокручиваем.
const WHEEL_STEP = 95 / 3;
const TIME_SCROLLER = '[aria-label="Время начала"]';

interface PickedTask {
  id: string;
  title: string;
  start_time: string | null;
  duration_min: number | null;
  project_name: string | null;
}

/** Задача-подопытная берётся ЗАПРОСОМ к API, а не тапом по первой строке
 *  списка: нужна конкретная — с проектом, временем и длительностью разом,
 *  иначе половина проверок ниже нечего было бы проверять. GET-запросы
 *  заглушка setupApp пропускает как есть, так что база при этом не
 *  трогается. */
async function pickTask(page: Page): Promise<PickedTask | null> {
  return page.evaluate(async () => {
    const token = localStorage.getItem("taskflow_token");
    const res = await fetch("/api/tasks", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const tasks = (await res.json()) as PickedTask[] &
      { status: string; project_id: string | null }[];
    const fit = (tasks as any[]).find(
      (t) =>
        t.status === "active" &&
        t.project_id &&
        t.start_time &&
        t.duration_min != null,
    );
    return fit
      ? {
          id: fit.id,
          title: fit.title,
          start_time: fit.start_time,
          duration_min: fit.duration_min,
          project_name: fit.project_name,
        }
      : null;
  });
}

test.describe("Карточка задачи", () => {
  test("строка срока печатает время интервалом, метка проекта — без заливки", async ({
    page,
    context,
  }) => {
    await setupApp(context);
    const errors = collectErrors(page);
    await openScreen(page, "/inbox");

    const task = await pickTask(page);
    test.skip(
      !task,
      "в базе нет активной задачи с проектом, временем и длительностью разом — интервал показывать не на чем",
    );

    await openScreen(page, `/task/${task!.id}`);

    const card = await page.evaluate(() => {
      const h1 = document.querySelector<HTMLElement>("h1")!;
      // Строка срока — единственная плашка с иконкой календаря в блоке
      // метаданных.
      const dueRow = Array.from(
        document.querySelectorAll<HTMLElement>("div.bg-card.rounded-xl"),
      ).find((el) => /\d{1,2} [а-я]{3}/.test(el.textContent ?? ""));
      // Метка проекта стоит НАД заголовком, отдельной строкой.
      const badge = Array.from(
        document.querySelectorAll<HTMLElement>("span.inline-flex"),
      ).find(
        (el) =>
          !!el.querySelector("svg") &&
          el.getBoundingClientRect().bottom <= h1.getBoundingClientRect().top,
      );
      return {
        due: dueRow ? (dueRow.textContent ?? "").trim() : null,
        badge: badge
          ? {
              text: (badge.textContent ?? "").trim(),
              hasHashIcon: !!badge.querySelector("svg"),
              background: getComputedStyle(badge).backgroundColor,
              color: getComputedStyle(badge).color,
              titleColor: getComputedStyle(h1).color,
            }
          : null,
      };
    });

    expect(card.due, "строка срока не найдена").not.toBeNull();
    // Интервал, а не «начало + отдельная длительность»: у выбранной задачи
    // длительность есть, значит конец обязан быть посчитан за владельца.
    expect(card.due!, `в строке срока нет интервала: «${card.due}»`).toMatch(
      RANGE_RE,
    );
    // И конец интервала действительно равен началу плюс длительность.
    const [, sh, sm, eh, em] = card.due!.match(
      /(\d{2}):(\d{2})—(\d{2}):(\d{2})/,
    )!;
    const start = Number(sh) * 60 + Number(sm);
    const end = Number(eh) * 60 + Number(em);
    expect((end - start + 1440) % 1440).toBe(task!.duration_min);

    expect(
      card.badge,
      "метка проекта над заголовком не найдена",
    ).not.toBeNull();
    expect(card.badge!.text).toBe(task!.project_name);
    expect(card.badge!.hasHashIcon).toBe(true);
    // «Она не должна иметь заливку, просто цветной текст с решёткой»
    // (владелец 19.08.2026) — до этого метка была пилюлей с подложкой.
    expect(card.badge!.background).toBe("rgba(0, 0, 0, 0)");
    expect(card.badge!.color).not.toBe(card.badge!.titleColor);

    expect(errors).toEqual([]);
  });
});

test.describe("Форма задачи: срок и время", () => {
  /** Открывает форму нужной задачи и раскрывает поле «Срок и время».
   *  Возвращает список того, что «ушло бы» на сервер, — им же в конце
   *  проверяется, что просмотр формы ничего не записывает. */
  async function openTimeField(
    page: Page,
    context: import("@playwright/test").BrowserContext,
  ): Promise<{ written: Written[]; task: PickedTask }> {
    const written = await setupApp(context);
    await openScreen(page, "/inbox");
    const task = await pickTask(page);
    test.skip(
      !task,
      "в базе нет активной задачи с проектом, временем и длительностью разом",
    );

    await openScreen(page, `/task/${task!.id}/edit`);
    const row = page.locator("button", { hasText: "Срок и время" });
    await expect(row).toHaveCount(1);
    // До тапа поле свёрнуто: барабана на экране нет.
    await expect(page.locator(TIME_SCROLLER)).toHaveCount(0);
    await row.click();
    await page.waitForTimeout(400);
    await expect(page.locator(TIME_SCROLLER)).toBeVisible();
    return { written, task: task! };
  }

  test("форма открывается, поле «Срок и время» раскрывается по тапу", async ({
    page,
    context,
  }) => {
    const errors = collectErrors(page);
    const { written, task } = await openTimeField(page, context);

    // Заголовок задачи подставлен в форму — это и есть признак, что
    // открылась именно эта задача, а не пустая форма создания.
    await expect(page.locator("textarea, input").first()).toHaveValue(
      new RegExp(
        task.title.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
    // Раскрытая панель несёт и календарь, и время: их объединили в одно
    // поле 19.08.2026 («логично как-то это совместить»).
    await expect(page.getByText("Во сколько")).toBeVisible();
    await expect(page.getByText("Продолжительность")).toBeVisible();

    expect(errors).toEqual([]);
    expect(written, "открытие формы не должно ничего писать").toEqual([]);
  });

  test("барабан времени: шаг 15 минут, выбранное значение в пилюле", async ({
    page,
    context,
  }) => {
    const { written } = await openTimeField(page, context);

    const wheel = await page.evaluate((sel) => {
      const scroller = document.querySelector<HTMLElement>(sel)!;
      const box = scroller.parentElement!;
      const pill = box.querySelector<HTMLElement>("div.bg-red")!;
      const layer = box.querySelector<HTMLElement>(
        "div.pointer-events-none.absolute.inset-0",
      )!;
      const rows = Array.from(layer.children as HTMLCollectionOf<HTMLElement>)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            text: (el.textContent ?? "").trim(),
            center: r.top + r.height / 2,
            height: r.height,
            bold: getComputedStyle(el).fontWeight,
          };
        })
        .sort((a, b) => a.center - b.center);
      const pr = pill.getBoundingClientRect();
      return {
        rows,
        pillTop: pr.top,
        pillBottom: pr.bottom,
        pillCenter: pr.top + pr.height / 2,
        pillHeight: +pr.height.toFixed(1),
        pillWidth: +pr.width.toFixed(1),
      };
    }, TIME_SCROLLER);

    // Рисуются не все 96 значений суток, а только видимая часть цилиндра
    // (дальше строки погашены до нуля) — поэтому шаг проверяем по
    // соседним отрисованным строкам, а не по полному списку.
    expect(wheel.rows.length).toBeGreaterThan(2);
    const minutes = wheel.rows.map((r) => {
      const m = r.text.match(/^(\d{2}):(\d{2})/)!;
      return Number(m[1]) * 60 + Number(m[2]);
    });
    for (let i = 1; i < minutes.length; i++) {
      expect(
        minutes[i] - minutes[i - 1],
        `строки барабана идут не через 15 минут: ${wheel.rows.map((r) => r.text).join(" / ")}`,
      ).toBe(15);
    }

    // Выделена ровно ОДНА строка, и это та, что стоит в пилюле. Размеры
    // пилюли — замер эталона: 518×122px @3x = 172.67×40.67pt.
    const bold = wheel.rows.filter((r) => Number(r.bold) >= 600);
    expect(bold.length).toBe(1);
    expect(Math.abs(wheel.pillHeight - 122 / 3)).toBeLessThanOrEqual(1);
    expect(Math.abs(wheel.pillWidth - 518 / 3)).toBeLessThanOrEqual(1);

    // Строка лежит ВНУТРИ пилюли целиком, а не наполовину высунувшись.
    expect(bold[0].center - bold[0].height / 2).toBeGreaterThanOrEqual(
      wheel.pillTop,
    );
    expect(bold[0].center + bold[0].height / 2).toBeLessThanOrEqual(
      wheel.pillBottom,
    );

    // И она заметно ближе к центру пилюли, чем к соседним строкам. Допуск
    // — четверть шага (7.9pt), и он не «на всякий случай»: строки стоят на
    // цилиндре, y = R·sin(kΔ), а k считается из scrollTop, который браузер
    // в покое кладёт на ЦЕЛОЕ число пикселей. Шаг строки дробный (95/3 =
    // 31.67pt), поэтому в точке залипания scrollTop оказывается 1709 при
    // идеальных 1710, k = 0.032 и строка стоит на R·sin(0.032·25.5°) =
    // 1.03pt ниже центра. Это округление раскладки, а не перекос: тот
    // дефект, что владелец ловил глазами, был в полстроки (8.5pt).
    expect(
      Math.abs(bold[0].center - wheel.pillCenter),
      `строка «${bold[0].text}» стоит на ${(bold[0].center - wheel.pillCenter).toFixed(2)}pt от центра пилюли`,
    ).toBeLessThan(95 / 3 / 4);

    expect(written).toEqual([]);
  });

  test("прокрутка барабана меняет выбранное время", async ({
    page,
    context,
  }) => {
    const { written } = await openTimeField(page, context);

    const rowValue = () =>
      page.locator("button", { hasText: "Срок и время" }).innerText();
    const before = await rowValue();

    // Крутим НЕВИДИМЫЙ слой прокрутки — именно он ловит палец, а видимые
    // строки лежат отдельным pointer-events-none слоем (так барабану
    // достаётся нативная инерция и залипание, см. TaskFields.tsx).
    await page.evaluate(
      ({ sel, step }) => {
        const el = document.querySelector<HTMLElement>(sel)!;
        el.scrollTop += step * 4; // ровно четыре шага = час
      },
      { sel: TIME_SCROLLER, step: WHEEL_STEP },
    );
    // Значение применяется не на каждый пиксель, а после успокоения (90мс).
    await page.waitForTimeout(500);

    const after = await rowValue();
    expect(after).not.toBe(before);
    expect(after).toMatch(/\d{2}:\d{2}/);

    // Ровно час вперёд — прокрутка на четыре шага по 15 минут.
    const pick = (s: string) => {
      const m = s.match(/(\d{2}):(\d{2})/)!;
      return Number(m[1]) * 60 + Number(m[2]);
    };
    expect((pick(after) - pick(before) + 1440) % 1440).toBe(60);

    // Правка в форме до нажатия «Сохранить» на сервер не уходит.
    expect(written).toEqual([]);
  });

  test("лента продолжительности: выбор подсвечивает капсулу и даёт интервал в пилюле", async ({
    page,
    context,
  }) => {
    const { written } = await openTimeField(page, context);

    // «2ч» — заведомо не то значение, что стоит у задачи (у подопытной
    // длительность 15–45 минут), поэтому выбор реально что-то меняет.
    const btn = page.getByRole("button", { name: "2ч", exact: true });
    await expect(btn).toHaveCount(1);
    await btn.click();
    await page.waitForTimeout(400);

    const state = await page.evaluate((sel) => {
      const scroller = document.querySelector<HTMLElement>(sel)!;
      const box = scroller.parentElement!;
      const layer = box.querySelector<HTMLElement>(
        "div.pointer-events-none.absolute.inset-0",
      )!;
      const center = Array.from(
        layer.children as HTMLCollectionOf<HTMLElement>,
      ).find((el) => Number(getComputedStyle(el).fontWeight) >= 600);
      // Лента — соседний блок под барабаном; активная капсула это
      // aria-hidden подложка bg-red внутри кнопки.
      const caps = Array.from(
        document.querySelectorAll<HTMLElement>("button"),
      ).filter((b) =>
        /^(15м|30м|45м|1ч|2ч|3ч)$/.test((b.textContent ?? "").trim()),
      );
      return {
        pillText: center ? (center.textContent ?? "").trim() : null,
        strip: caps.map((b) => ({
          label: (b.textContent ?? "").trim(),
          highlighted: !!b.querySelector("span.bg-red"),
        })),
      };
    }, TIME_SCROLLER);

    // Подсвечена ровно одна капсула — та, что выбрали.
    const lit = state.strip.filter((s) => s.highlighted);
    expect(lit.map((s) => s.label)).toEqual(["2ч"]);

    // В пилюле барабана — интервал, конец считается из длительности
    // («изначально выбираешь интервал, а потом мотаешь один барабан»).
    expect(state.pillText, "в пилюле барабана нет интервала").toMatch(RANGE_RE);
    const [, sh, sm, eh, em] = state.pillText!.match(
      /(\d{2}):(\d{2})—(\d{2}):(\d{2})/,
    )!;
    const start = Number(sh) * 60 + Number(sm);
    const end = Number(eh) * 60 + Number(em);
    expect((end - start + 1440) % 1440).toBe(120);

    expect(written).toEqual([]);
  });
});

test.describe("Форма задачи: набор названия", () => {
  // ХВОСТОВОЙ ПРОБЕЛ ПЕРЕЖИВАЕТ ПОТЕРЮ ФОКУСА.
  //
  // Жалоба владельца 20.08.2026: «нажимаю пробел — каретка тут же
  // возвращается назад». Причина была в applyDictationParse: он висит на
  // onBlur названия и сравнивал разобранный заголовок с СЫРЫМ, а
  // parseDictation обрезает пробелы сам — значит любой хвостовой пробел
  // выглядел как «разбор что-то изменил», заголовок переписывался
  // обрезанным и заодно получал заглавную от capitalizeFirst.
  //
  // Проверка жила в scripts/kb-check.mjs — харнессе своей экранной
  // клавиатуры, который умел слать blur на каждое нажатие. Клавиатуру
  // отключили 20.08.2026, харнесс удалён вместе с ней, и весь класс
  // «что-то на blur переписывает поле» остался бы без автопроверки —
  // поэтому она перенесена сюда. Blur здесь ручной: с нативной
  // клавиатурой он приходит не на каждое нажатие, а при уходе с поля, но
  // ломается от него ровно то же самое.
  test("пробел в конце названия не съедается на blur", async ({
    page,
    context,
  }) => {
    const written = await setupApp(context);
    const errors = collectErrors(page);
    await openScreen(page, "/task/new");

    const title = page.locator('textarea[placeholder="Название задачи"]');
    await title.click();
    await title.pressSequentially("кот ", { delay: 30 });
    await title.evaluate((el) => el.blur());
    await page.waitForTimeout(300);

    // Именно «кот » — не «кот» (обрезан) и не «Кот» (плюс capitalizeFirst).
    await expect(title).toHaveValue("кот ");
    expect(errors).toEqual([]);
    expect(written).toEqual([]);
  });
});
