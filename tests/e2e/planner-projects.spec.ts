import { test, expect } from "@playwright/test";
import { setupApp, openScreen, collectErrors } from "./helpers";

// Шаг 3 (feature/projects-decouple-planner-merge): регрессионная защита
// CRITICAL-бага Шага 2.
//
// Суть бага (см. коммит 276864e): при тапе по [+] в PlannerProjectChips
// шторка фильтра открывалась, но секция «Показывать в разделе» оставалась
// свёрнутой. Юзер делал лишний тап, чтобы её раскрыть.
//
// Корневая причина была в useState-инициализаторе openSection: useEffect
// на [open] срабатывал на первом монтировании с open=true и затирал
// значение до null, до того как пользователь успевал увидеть секцию.
//
// Тест фиксирует ровно наблюдаемый симптом: после тапа по [+] секция
// «Показывать в разделе» РАСКРЫТА, и в DOM видны её свитчеры проектов
// (role="switch"). Если фикс из 276864e сломается снова — секция останется
// свёрнутой, свитчеры не отрисуются, тест упадёт.
//
// Связанные коммиты:
// - 46ea4c2 (Шаг 2): ввёл defaultOpenSection и [+] в PlannerProjectChips
// - 276864e (Шаг 2 follow-up A): починил useState-init/useEffect
// - 92ae50d (Шаг 3, Коммит A): выпилил legacy hiddenDailyPlannerProjects
//   (не затрагивает этот сценарий, но в одной ветке)

test.describe("«Сегодня»: [+] в PlannerProjectChips раскрывает секцию", () => {
  test("тап по [+] → секция «Показывать в разделе» раскрыта", async ({
    page,
    context,
  }) => {
    // Подменяем GET /api/projects, чтобы чипы и picker видели стабильный
    // набор из двух проектов. Без мока фронт пойдёт в живые данные через
    // setupApp.route.continue() — а нам нужно предсказуемое окружение.
    await context.route("**/api/projects", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "p-project",
            name: "Работа",
            color: "#3B82F6",
            owner_id: "e2e-fixture-owner",
            task_count: 0,
          },
          {
            id: "p-personal",
            name: "Личное",
            color: "#34C759",
            owner_id: "e2e-fixture-owner",
            task_count: 0,
          },
        ]),
      });
    });
    // Безхозная задача (project_id=null) — нужна для чипа «Входящие» в
    // PlannerProjectChips. После миграции 041 все живые задачи имеют
    // проект, поэтому без мока чип не отрисуется.
    await context.route("**/api/tasks**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "t-inbox",
            title: "Входящая задача",
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
            labels: [],
            subtasks: [],
            comments: [],
            events: [],
            attachments: [],
          },
        ]),
      });
    });

    await setupApp(context, { today: "list" });
    const errors = collectErrors(page);
    await openScreen(page, "/today");

    // Маркер того, что экран смонтирован и useProjects отдал непустой
    // массив: чип «Входящие» виден. Если его нет — Projects не загрузились
    // и секция вообще не отрисуется (plannerProjects.projects.length === 0),
    // что для бага defaultOpenSection не имеет смысла проверять.
    await expect(page.getByLabel("Входящие")).toBeVisible();

    // Тапаем по [+] — он же aria-label="Добавить проект".
    await page.getByLabel("Добавить проект").click();

    // Главная проверка: после тапа в DOM появились role="switch" для
    // проектов из picker'а. Они рендерятся только когда openSection === "planner"
    // (см. TaskFilterSheet.tsx, секция «Показывать в разделе»).
    //
    // Ищем именно в шторке — data-overlay — чтобы не путать со
    // свитчерами в других местах экрана.
    const overlay = page.locator("div[data-overlay]");
    await expect(overlay).toBeVisible();
    await expect(
      overlay.getByRole("switch").filter({ hasText: "Работа" }),
    ).toBeVisible();
    await expect(
      overlay.getByRole("switch").filter({ hasText: "Личное" }),
    ).toBeVisible();

    // Дополнительная проверка: поясняющий текст picker'а виден — это
    // тоже зависит от openSection === "planner" и заодно подтверждает,
    // что мы смотрим на раскрытую секцию, а не на артефакт.
    await expect(
      overlay.getByText(
        "Выбери проекты, задачи которых показывать в этом разделе",
      ),
    ).toBeVisible();

    // Никаких падений и ошибок в консоли — экран и шторка не сломались
    // из-за тестовой среды. «Экран не упал» — это тоже проверка.
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("повторное открытие шторки по [+] снова раскрывает секцию", async ({
    page,
    context,
  }) => {
    // Тот же путь, но проверяет вторую половину фикса 276864e:
    // регрессия проявлялась не только при первом открытии, но и при
    // закрытии → повторном открытии (useEffect на [open] стирал
    // openSection на КАЖДЫЙ переход open: false→true).
    await context.route("**/api/projects", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "p-project",
            name: "Работа",
            color: "#3B82F6",
            owner_id: "e2e-fixture-owner",
            task_count: 0,
          },
        ]),
      });
    });
    // Безхозная задача для чипа «Входящие» (см. причину в первом тесте).
    await context.route("**/api/tasks**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "t-inbox",
            title: "Входящая задача",
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
            labels: [],
            subtasks: [],
            comments: [],
            events: [],
            attachments: [],
          },
        ]),
      });
    });

    await setupApp(context, { today: "list" });
    const errors = collectErrors(page);
    await openScreen(page, "/today");
    await expect(page.getByLabel("Входящие")).toBeVisible();

    // Первое открытие.
    await page.getByLabel("Добавить проект").click();
    const overlay = page.locator("div[data-overlay]");
    await expect(
      overlay.getByRole("switch").filter({ hasText: "Работа" }),
    ).toBeVisible();

    // Закрываем шторку тапом по оверлею (вне листа — кликаем по scrim).
    // Селектор scrim — первый абсолютный div внутри data-overlay.
    await page.locator("div[data-overlay] > div").first().click();

    // Ждём, пока шторка спрячется — sheet.mounted стал false.
    await expect(overlay).toBeHidden();

    // Повторный тап по [+] — секция снова раскрыта.
    await page.getByLabel("Добавить проект").click();
    await expect(overlay).toBeVisible();
    await expect(
      overlay.getByRole("switch").filter({ hasText: "Работа" }),
    ).toBeVisible();

    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test.describe("«Проекты»: раздел «Без проекта»", () => {
  test("считает только активные задачи без проекта и открывает их список", async ({
    page,
    context,
  }) => {
    await setupApp(context);
    await context.route("**/api/projects", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "p-work",
            name: "Работа",
            color: "#3B82F6",
            owner_id: "e2e-fixture-owner",
            task_count: 1,
          },
        ]),
      });
    });
    await context.route("**/api/tasks**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "t-without-project",
            title: "Активная без проекта",
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
            labels: [],
            subtasks: [],
            comments: [],
            events: [],
            attachments: [],
          },
          {
            id: "t-completed-without-project",
            title: "Завершённая без проекта",
            description: null,
            due_date: null,
            project_id: null,
            priority: 4,
            assignee_id: null,
            creator_id: "e2e-fixture-owner",
            status: "completed",
            created_at: "2026-08-20T00:00:00.000Z",
            updated_at: "2026-08-20T00:00:00.000Z",
            completed_at: "2026-08-21T00:00:00.000Z",
            labels: [],
            subtasks: [],
            comments: [],
            events: [],
            attachments: [],
          },
          {
            id: "t-in-project",
            title: "Активная в проекте",
            description: null,
            due_date: null,
            project_id: "p-work",
            priority: 4,
            assignee_id: null,
            creator_id: "e2e-fixture-owner",
            status: "active",
            created_at: "2026-08-20T00:00:00.000Z",
            updated_at: "2026-08-20T00:00:00.000Z",
            completed_at: null,
            labels: [],
            subtasks: [],
            comments: [],
            events: [],
            attachments: [],
          },
        ]),
      });
    });

    const errors = collectErrors(page);
    await openScreen(page, "/projects");

    const noProject = page.getByRole("button", { name: "Без проекта 1" });
    await expect(noProject).toBeVisible();
    await noProject.click();
    await expect(page).toHaveURL(/\/projects\/no-project$/);
    await expect(page.getByText("Активная без проекта")).toBeVisible();
    await expect(page.getByText("Завершённая без проекта")).toBeHidden();
    await expect(page.getByText("Активная в проекте")).toBeHidden();
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
