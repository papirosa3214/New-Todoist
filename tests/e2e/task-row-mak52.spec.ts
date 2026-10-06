import { test, expect } from "@playwright/test";
import type { Page, BrowserContext } from "@playwright/test";
import { setupApp, collectErrors } from "./helpers";

// Строка задачи как TFTaskRow — Linear MAK-52, DESIGN-SYSTEM.md §2.5.
//
// Меряем то, что в карточке названо числом: отступы строки (9px сверху при
// нижнем 12px), радиус индикаторов 4 на плашке `card`, прогресс «N из M» со
// значком (дети или шаги), статус агента цветом отдельной строкой, чекбокса
// завершения нет, свайп открывается от 36px и закрывается встречным движением
// от 25px при панели действия 84px. Всё это геометрия одного компонента
// (src/components/TaskRow.tsx), поэтому проверки снимают замер с живой
// строки, а не сверяют строки кода.
//
// Экран — список задач проекта (/projects/:id): единственный живой список
// TaskRow, где состав строк предсказуем. /inbox в наборе больше не существует
// (маршрут снят 30.08.2026, коммит 0cc4d0f1) — проверка по несуществующему
// адресу молча краснеет на «Страница не найдена», и её нельзя выдать за
// проверку строки. id проекта берётся из живого GET /api/tasks, чтение
// ничего не пишет (setupApp глушит все не-GET, кроме авторизации).
//
// ВАЖНО про адрес: общий baseURL набора (https://localhost:5180) обслуживает
// ОСНОВНУЮ копию проекта, а не этот worktree — без переопределения проверки
// меряли бы код ветки main и молча «не видели» правку (ровно так падали
// первые прогоны этого файла). Свой dev-сервер поднимают на другом порту:
//   npx vite --host 0.0.0.0 --port 5252 --strictPort
// адрес берётся из E2E_BASE_URL, дефолт 5252.

const BASE = process.env.E2E_BASE_URL ?? "https://localhost:5252";

/** Открыть экран своего dev-сервера и дождаться отрисовки списка. */
async function openOwnScreen(page: Page, path: string) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
}

/** Первая строка TaskRow экрана — её геометрия и состав бейджей.

 *  Про page.evaluate: колбэк исполняется в браузере изолированно, поэтому
 *  селекторы и регулярные выражения повторяются литералами внутри него —
 *  внешние константы (ROW, пороги свайпа) из этой функции не видны. */
async function firstRow(page: Page) {
  return page.evaluate(() => {
    const wrap = document.querySelector<HTMLDivElement>("div.-mx-4.border-b");
    if (!wrap) return null;
    const btn = wrap.querySelector<HTMLButtonElement>("button.tap-row")!;
    const cs = getComputedStyle(btn);
    // Все span'ы строки: меряем радиус каждого, а не выбираем по классу —
    // в собранном Tailwind v4 порядок утилит в class отличается от
    // исходника, и «span.r-pill» молча дал бы пусто (тогда проверка
    // говорила бы о селекторе, а не о приложении).
    const pills = Array.from(wrap.querySelectorAll<HTMLElement>("span")).map(
      (p) => ({
        text: (p.textContent ?? "").trim().slice(0, 24),
        radius: getComputedStyle(p).borderRadius,
        cls: p.className,
      }),
    );
    const content = btn.querySelector<HTMLElement>("div > div")!;
    const br = btn.getBoundingClientRect();
    const cr = content.getBoundingClientRect();
    return {
      padTop: cs.paddingTop,
      padBottom: cs.paddingBottom,
      padX: cs.paddingLeft,
      inkTop: +(cr.top - br.top).toFixed(1),
      pills,
      hasCheckbox: !!wrap.querySelector('input[type="checkbox"]'),
    };
  });
}

/** Все плашки прогресса на экране: «N из M» или «a/b». */
async function progressPills(page: Page) {
  return page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLDivElement>("div.-mx-4.border-b"),
    );
    const out: {
      text: string;
      radius: string;
      icon: boolean;
      verbose: boolean;
    }[] = [];
    for (const r of rows) {
      // Плашка прогресса — та, что с числом внутри: «N из M» или «a/b».
      // Ищем по тексту, а не по классу: тег статуса агента тоже tf-caption,
      // и в собранном CSS порядок утилит может отличаться от исходника.
      const pill = Array.from(r.querySelectorAll<HTMLElement>("span")).find(
        (el) =>
          /^\d+\s*(?:из|\/)\s*\d+$/.test((el.textContent ?? "").trim()),
      );
      if (!pill) continue;
      const text = (pill.textContent ?? "").trim();
      const m = text.match(/(\d+)\s*(из|\/)\s*(\d+)/);
      if (!m) continue;
      out.push({
        text,
        radius: getComputedStyle(pill!).borderRadius,
        icon: !!pill!.querySelector("svg"),
        verbose: m[2] === "из",
      });
    }
    return out;
  });
}

/** Карточка-фикстура для теста прогресса: обязательные поля ApiTask с
 *  заглушками, как TASK_DEFAULTS в helpers.ts. */
const FIXTURE_BASE = {
  description: null,
  due_date: null,
  project_id: null,
  priority: 4,
  assignee_id: null,
  creator_id: "e2e-fixture-owner",
  status: "active",
  created_at: "2026-10-06T00:00:00.000Z",
  updated_at: "2026-10-06T00:00:00.000Z",
  completed_at: null,
  position: null,
  labels: [],
  subtasks: [],
  parent_id: null,
};

/** Два ряда: родитель-зонтик (дети) и задача с планом (шаги). */
function MAK52_FIXTURES(projectId: string | null) {
  return [
    {
      ...FIXTURE_BASE,
      id: "e2e-mak52-kids",
      title: "MAK-52 родитель с детьми",
      project_id: projectId,
      project_name: "MAK-52",
      project_color: "#4A9FD8",
      children_total: 3,
      children_done: 1,
    },
    {
      ...FIXTURE_BASE,
      id: "e2e-mak52-plan",
      title: "MAK-52 план из трёх шагов",
      project_id: projectId,
      project_name: "MAK-52",
      project_color: "#4A9FD8",
      subtasks: [
        { id: "s1", title: "Раз", done: true },
        { id: "s2", title: "Два", done: false },
        { id: "s3", title: "Три", done: false },
      ],
    },
  ];
}

/** Подменяет GET /api/tasks фикстурами; запись по-прежнему заглушает setupApp. */
async function mockTasksList(context: BrowserContext, tasks: unknown[]) {
  await context.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(tasks),
    });
  });
}

test.describe("Строка задачи (TFTaskRow, MAK-52)", () => {
  let projectId: string | null = null;

  test.beforeEach(async ({ page, context }) => {
    await setupApp(context, { today: "list" });
    if (!projectId) {
      // Живой проект с задачами — чтобы список был непустым независимо от
      // того, что владелец сегодня закрыл или завёл.
      await openOwnScreen(page, "/overview");
      projectId = await page.evaluate(async () => {
        const r = await fetch("/api/tasks");
        if (!r.ok) return null;
        const tasks: any[] = await r.json();
        const counts = new Map<string, number>();
        for (const t of tasks) {
          if (t.status !== "active" || !t.project_id) continue;
          counts.set(t.project_id, (counts.get(t.project_id) ?? 0) + 1);
        }
        let best: string | null = null;
        let max = 0;
        for (const [id, n] of counts)
          if (n > max) {
            max = n;
            best = id;
          }
        return max > 0 ? best : null;
      });
    }
    expect(projectId, "нет ни одного проекта с активными задачами").toBeTruthy();
  });

  test("отступы строки, радиус индикаторов и отсутствие чекбокса", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openOwnScreen(page, `/projects/${projectId}`);

    const g = await firstRow(page);
    expect(g, "в списке проекта нет ни одной строки TaskRow").toBeTruthy();

    // 9px сверху / 12px снизу: пилюли прижаты к своей кромке, выравнивание
    // по нижней части (владелец 19.08.2026); горизонталь экрана — 16px.
    expect(g!.padTop).toBe("9px");
    expect(g!.padBottom).toBe("12px");
    expect(g!.padX).toBe("16px");

    // Чекбокса завершения в строке нет (§2.5): статус меняют в карточке.
    expect(g!.hasCheckbox).toBe(false);

    // Индикаторы ряда — радиус 4 (§2.5), не capsule-full. Селектор по
    // классу НЕ использую: в собранном Tailwind v4 порядок утилит в class
    // может отличаться от исходника, и «span.r-pill» молча даёт пусто —
    // проверка тогда говорит о селекторе, а не о приложении. Меряем все
    // span'ы строки; свои углы есть только у пилюль и шевронов приоритета,
    // заголовок/описание — прямоугольные.
    const nonSquare = g!.pills.filter(
      (p) => !/^0px/.test(p.radius) && p.radius !== "4px",
    );
    expect(nonSquare, "индикатор с радиусом вне шкалы").toEqual([]);

    expect(errors).toEqual([]);
  });

  test("статус агента — своей строкой, цветным словом без плашки", async ({
    page,
  }) => {
    await openOwnScreen(page, `/projects/${projectId}`);
    const found = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLDivElement>("div.-mx-4.border-b"),
      );
      for (const r of rows) {
        const line = Array.from(r.querySelectorAll<HTMLElement>("div")).find(
          (d) =>
            d.querySelector("svg") &&
            /в работе|на проверк|заблокиров|пропал/.test(d.textContent ?? ""),
        );
        if (!line) continue;
        const tag = line.querySelector<HTMLElement>("span")!;
        return {
          text: (tag.textContent ?? "").trim().slice(0, 30),
          color: getComputedStyle(tag).color,
          bg: getComputedStyle(tag).backgroundColor,
          radius: getComputedStyle(tag).borderRadius,
        };
      }
      return null;
    });
    expect(found, "в этом списке нет задачи в агентском состоянии").toBeTruthy();
    // Цвет есть, плашки-фона нет (§2.5: «статус агента цветом»).
    expect(found!.color).toMatch(/^rgb/);
    expect(found!.bg).toBe("rgba(0, 0, 0, 0)");
    expect(found!.radius).toBe("0px");
  });

  test("прогресс основного списка читается «N из M» со значком", async ({
    page,
    context,
  }) => {
    // Живой список подменяем своей фикстурой: проверка должна видеть
    // именно родителя с дочерними задачами (значок дерева) и задачу с
    // планом (значок списка), а не то, что лежит в базе владельца сегодня.
    // Данные только читаются — серверных записей тест не делает.
    await mockTasksList(context, MAK52_FIXTURES(projectId));
    await openOwnScreen(page, `/projects/${projectId}`);
    const pills = await progressPills(page);
    expect(pills.length, "в списке нет задачи с планом или детьми").toBeGreaterThan(
      0,
    );
    // ProjectTasksScreen передаёт verboseProgress (§2.5 требует «N из M»),
    // значок говорит, чего счётчик: детей (дерево) или шагов плана (список).
    for (const p of pills) {
      expect(p.verbose).toBe(true);
      expect(p.radius).toBe("4px");
      expect(p.icon).toBe(true);
    }
  });

  test("свайп: панель 84px, открытие от 36px, закрытие встречным от 25px", async ({
    page,
    context,
  }) => {
    await mockTasksList(context, MAK52_FIXTURES(projectId));
    await openOwnScreen(page, `/projects/${projectId}`);

    // Якорь жеста — середина строки (x≈200), а не край: при открытом
    // «Изменить» правый край уходит за 336px на саму кнопку действия, а
    // левый — за ноль вьюпорта, и Chromium перестаёт слать pointermove.
    // Тогда тест мерил бы молчание браузера, а не физику строки.
    const geom = await page.evaluate(() => {
      const wrap = document.querySelector<HTMLDivElement>(
        "div.-mx-4.border-b",
      )!;
      const r = wrap.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });

    const sliderX = () =>
      page.evaluate(() => {
        const wrap = document.querySelector<HTMLDivElement>(
          "div.-mx-4.border-b",
        )!;
        const slider = wrap.querySelector<HTMLElement>(
          ":scope > div:not([aria-label])",
        )!;
        const m = new DOMMatrixReadOnly(getComputedStyle(slider).transform);
        return +m.m41.toFixed(1);
      });

    const actionGeom = () =>
      page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>(
          "div.-mx-4.border-b button[aria-label='Изменить задачу']",
        )!;
        return {
          width: +btn.getBoundingClientRect().width.toFixed(1),
          pointerEvents: getComputedStyle(btn).pointerEvents,
        };
      });

    // Медленный сдвиг на 30px — ниже порога 36: строка обязана вернуться.
    await dragFrom(page, geom.x, [-8, -20, -30]);
    expect(await sliderX()).toBeCloseTo(0, 1);

    // Бросок влево (без пауз между кадрами) — выше порога: открывается
    // ровно на панель действия 84px, кнопка становится кликабельной.
    await dragFrom(page, geom.x, [-10, -30, -60, -100], { settle: 0, perMove: 1 });
    expect(await sliderX()).toBe(-84);
    const opened = await actionGeom();
    expect(opened.width).toBeCloseTo(84, 1);
    expect(opened.pointerEvents).toBe("auto");

    // Закрытие встречным движением. Открыто «Изменить» (x<0) — значит
    // закрывать надо тянуть вправо: dx от новой точки pointerdown, и цель
    // держим внутри слайдера (после раскрытия он занимает 0..336), иначе
    // попадём под палец синей кнопкой и тест уйдёт на /edit вместо жеста.
    // 20px — меньше порога 25px: строка остаётся открытой.
    await dragFrom(page, geom.x, [10, -5, 20]);
    expect(await sliderX()).toBe(-84);

    // 60px встречного — порог пройден: закрывается.
    await dragFrom(page, geom.x, [10, -5, 60]);
    expect(await sliderX()).toBeCloseTo(0, 1);
  });
});

/** Жест мышью от якоря x с указанными смещениями; settle=0 — бросок. */
async function dragFrom(
  page: Page,
  fromX: number,
  deltas: number[],
  { settle = 90, perMove = 3 }: { settle?: number; perMove?: number } = {},
) {
  const y = await page.evaluate(() => {
    const w = document.querySelector<HTMLDivElement>("div.-mx-4.border-b")!;
    return Math.round(w.getBoundingClientRect().top + w.getBoundingClientRect().height / 2);
  });
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  for (const d of deltas) {
    await page.mouse.move(fromX + d, y, { steps: perMove });
    if (settle) await page.waitForTimeout(settle);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
}

