// Скриншоты веба для MAK-52 (строка задачи как TFTaskRow, §2.5).
//
// Layout 402×874, свет/тьма через persist-стейт (taskflow-ui, v4). Кадры:
//   docs/2026-10-06-task-row-mak-52/web/{light,dark}/01-today.png
//                                            /02-inbox.png (если маршрут жив)
//                                            /03-project.png
//
// Перед запуском поднимите СВОЙ dev-сервер на ЭТОМ worktree:
//   npx vite --host 0.0.0.0 --port 5253 --strictPort
//   node scripts/screenshot-mak52.mjs
//
// Требует backend на :3001 с TASKFLOW_LAN_NO_AUTH=1 — RequireAuth сам
// залогинится через POST /api/auth/lan (нужен настоящий chromium с
// UA Mozilla/*, иначе looksLikeBrowser() режет).

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_BASE = join(ROOT, "docs/2026-10-06-task-row-mak-52", "web");

const VIEWPORT = { width: 402, height: 874 };
const BASE = process.env.BASE_URL ?? "https://localhost:5253";

const PERSIST = (theme) => ({
  state: {
    settings: { theme, calendarView: "month" },
    taskLayout: { inbox: "list", today: "list" },
    upcomingLayout: "list",
    collapsedInboxProjects: {},
    plannerVisibleProjects: {},
  },
  version: 4,
});

async function shoot(page, url, file) {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 8000 });
  } catch (e) {
    console.log(`navigate ${url} failed: ${e.message}; capturing anyway`);
  }
  // Анимации входа + сетка часов + отрисовка строк.
  await page.waitForTimeout(1100);
  await page.screenshot({ path: file, fullPage: false });
  console.log("wrote", file);
}

async function main() {
  for (const theme of ["light", "dark"]) {
    const OUT = join(OUT_BASE, theme);
    await mkdir(OUT, { recursive: true });
    const browser = await chromium.launch({
      headless: true,
      args: ["--ignore-certificate-errors"],
    });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
      ignoreHTTPSErrors: true,
    });
    await context.addInitScript((persist) => {
      localStorage.setItem("taskflow-ui", JSON.stringify(persist));
    }, PERSIST(theme));

    const page = await context.newPage();
    page.on("pageerror", (e) => console.log(`pageerror[${theme}]:`, e.message));

    // 1. Сегодня — основной список с TaskRow.
    await shoot(page, `${BASE}/today`, join(OUT, "01-today.png"));

    // 2. Входящие — если маршрут жив. /inbox снят 30.08.2026
    //    (коммит 0cc4d0f1), но E2E-тест в этом worktree жмёт на
    //    /projects/:id, не /inbox. Безопаснее: пробуем оба, при
    //    404 идём дальше.
    await shoot(page, `${BASE}/inbox`, join(OUT, "02-inbox.png"));

    // 3. Проект — список задач, где TaskRow виден с verboseProgress.
    // Подменяем /api/tasks на фикстуру: владелец в живой базе сегодня
    // мог не иметь «сегодня-задач» (Today пустой) или нужного проекта.
    // Здесь три фикстуры — родитель-зонтик (3 ребёнка, 1 закрыт),
    // задача с планом (2/3 шага), просроченная. Поля совпадают с
    // ApiTask, чтобы TaskRow их принял без исключений.
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const tasks = [
      {
        id: "shot-kids",
        title: "MAK-52 родитель с детьми",
        description: "§2.5: значок дерева, N из M",
        due_date: today,
        // project_id=null — задача из Входящих, она видна на Today
        // независимо от picker проектов (TodayScreen фильтрует
        // plannerTasks по visibleProjectIds, а нулёвый project_id
        // пропускает безусловно). Так прогресс «N из M» видно
        // в кадре 04-today-fixture.png.
        project_id: null,
        project_name: null,
        project_color: null,
        priority: 1,
        assignee_id: "shot-1",
        assignee_initials: "АИ",
        assignee_color: "#e44332",
        assignee_avatar_url: null,
        creator_id: "shot-owner",
        status: "active",
        created_at: "2026-10-06T00:00:00.000Z",
        updated_at: "2026-10-06T00:00:00.000Z",
        completed_at: null,
        position: null,
        labels: [],
        subtasks: [],
        parent_id: null,
        children_total: 3,
        children_done: 1,
        agent_state: "in_progress",
        agent_stale: false,
        agent_heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
        ready_for_pickup: false,
        needs_research: false,
      },
      {
        id: "shot-plan",
        title: "MAK-52 задача с планом",
        description: "§2.5: значок списка, 2 из 3",
        due_date: today,
        project_id: "shot-project",
        project_name: "MAK-52",
        project_color: "#4A9FD8",
        priority: 2,
        assignee_id: null,
        creator_id: "shot-owner",
        status: "active",
        created_at: "2026-10-06T00:00:00.000Z",
        updated_at: "2026-10-06T00:00:00.000Z",
        completed_at: null,
        position: null,
        labels: [
          { id: "l1", name: "важно", color: "#e44332" },
          { id: "l2", name: "фронт", color: "#4a9fd8" },
        ],
        subtasks: [
          { id: "s1", title: "Раз", done: true },
          { id: "s2", title: "Два", done: true },
          { id: "s3", title: "Три", done: false },
        ],
        parent_id: null,
        agent_state: "review",
        agent_stale: false,
        agent_heartbeat_at: null,
        ready_for_pickup: false,
        needs_research: true,
      },
      {
        id: "shot-overdue",
        title: "MAK-52 просроченная",
        description: null,
        due_date: yesterday,
        project_id: null,
        project_name: null,
        project_color: null,
        priority: 3,
        assignee_id: "shot-2",
        assignee_initials: "МК",
        assignee_color: "#15937e",
        creator_id: "shot-owner",
        status: "active",
        created_at: "2026-10-06T00:00:00.000Z",
        updated_at: "2026-10-06T00:00:00.000Z",
        completed_at: null,
        position: null,
        labels: [],
        subtasks: [],
        parent_id: null,
        agent_state: null,
        ready_for_pickup: true,
        needs_research: false,
      },
    ];
    await context.route("**/api/tasks", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(tasks),
      });
    });
    await context.route("**/api/projects/shot-project", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "shot-project",
          name: "MAK-52",
          color: "#4A9FD8",
        }),
      });
    });
    await context.route("**/api/tasks/shot-*/agent", (route) => route.fallback());
    await shoot(
      page,
      `${BASE}/projects/shot-project`,
      join(OUT, "03-project.png"),
    );

    // 4. Сегодня с фикстурами — чтобы было видно verboseProgress на Today.
    await shoot(page, `${BASE}/today`, join(OUT, "04-today-fixture.png"));

    await browser.close();
  }
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
