// Скриншоты веба для MAK-53 (чекбокс и статусы подзадач, DESIGN-SYSTEM §2.6).
//
// Что снимаем — лента подзадач карточки задачи со всеми пятью состояниями
// кольца (готово / выполняется / ожидает / заблокировано / на проверке) и
// оба состояния простого чекбокса (отмечен / не отмечен):
//   docs/2026-10-06-subtasks-mak-53/web/{light,dark}/01-subtask-feed.png
//   docs/2026-10-06-subtasks-mak-53/web/{light,dark}/02-reduced-motion.png
//
// Снимаем на СОБРАННОМ dist (npx vite build), без живого сервера: весь
// /api/** заглушен прямо здесь тем же приёмом, что в scripts/ui-check.mjs.
// Так кадр детерминирован — не зависим от того, какие задачи есть в базе.
//
// Запуск: npx vite build && node scripts/screenshot-mak53.mjs

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUT_DIR = path.join(ROOT, "docs/2026-10-06-subtasks-mak-53", "web");
const PORT = 5182;

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("Нет dist/index.html — сначала собрать: npx vite build");
  process.exit(1);
}

const ME = { id: "u1", name: "Максим", email: "m@example.com", role: "owner", type: "human" };
const TASK = {
  id: "t1",
  title: "Чекбокс и статусы подзадач",
  description: null,
  due_date: null,
  project_id: null,
  priority: 1,
  assignee_id: "u1",
  creator_id: "u1",
  status: "active",
  created_at: "2026-10-06T09:00:00.000Z",
  updated_at: "2026-10-06T09:00:00.000Z",
  completed_at: null,
  subtasks: [
    { id: "s1", task_id: "t1", title: "Готово", done: true, position: 0, state: "done", result: "Сделано", agent_id: "a1" },
    { id: "s2", task_id: "t1", title: "Выполняется", done: false, position: 1, state: "running", agent_id: "a1" },
    { id: "s3", task_id: "t1", title: "Ожидает", done: false, position: 2, state: "pending", agent_id: "a1" },
    { id: "s4", task_id: "t1", title: "Заблокировано", done: false, position: 3, state: "blocked", result: "Нет доступа", agent_id: "a1" },
    { id: "s5", task_id: "t1", title: "На проверке", done: false, position: 4, state: "review", result: "Проверьте", agent_id: "a1" },
    { id: "s6", task_id: "t1", title: "Простой чекбокс — не отмечен", done: false, position: 5 },
    { id: "s7", task_id: "t1", title: "Простой чекбокс — отмечен", done: true, position: 6 },
  ],
  comments: [],
  attachments: [],
  events: [],
  labels: [],
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let f = path.join(DIST, decodeURIComponent(url.pathname));
  if (!f.startsWith(DIST)) f = DIST;
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const PERSIST = (theme) => ({
  state: {
    settings: { theme, calendarView: "month" },
    taskLayout: { inbox: "list", today: "list" },
    upcomingLayout: "month",
    collapsedInboxProjects: {},
    plannerVisibleProjects: {},
    aiProvider: "local",
    localOllamaModel: "qwen3.6-27b-iq4-16k:latest",
    antigravityModel: "gemini-3.7-flash-high",
    claudeModel: "claude-sonnet-4.6",
    hermesModel: "nous-hermes-3-405b",
    deepseekModel: "deepseek-r1",
  },
  version: 4,
});

async function shoot(page, file, settle = 700) {
  await page.waitForTimeout(settle);
  await page.screenshot({ path: file, fullPage: false });
  console.log("wrote", file);
}

async function runTheme(theme) {
  const dir = path.join(OUT_DIR, theme);
  await mkdir(dir, { recursive: true });

  for (const reducedMotion of [false, true]) {
    const browser = await chromium.launch({ channel: "chrome" });
    const context = await browser.newContext({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    await context.addInitScript(
      ({ persist, token }) => {
        localStorage.setItem("taskflow-ui", JSON.stringify(persist));
        localStorage.setItem("taskflow_token", token);
      },
      { persist: PERSIST(theme), token: "test-token" },
    );

    await context.route("**/api/**", async (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (req.method() !== "GET") return json({ ok: true, id: "new" });
      if (p === "/api/auth/me") return json({ user: ME });
      if (p === "/api/tasks/t1") return json(TASK);
      if (p === "/api/tasks") return json([TASK]);
      if (p.endsWith("/collaboration-plans")) return json({ plans: [] });
      if (p.endsWith("/role-slots")) return json({ slots: [] });
      if (p === "/api/roles") return json({ roles: [] });
      if (p.startsWith("/api/users")) return json([ME]);
      return json([]);
    });

    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("pageerror:", e.message));

    await page.goto(`http://127.0.0.1:${PORT}/task/t1`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);

    const name = reducedMotion ? "02-reduced-motion.png" : "01-subtask-feed.png";
    await shoot(page, path.join(dir, name), reducedMotion ? 400 : 900);
    await browser.close();
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const theme of ["light", "dark"]) {
    console.log(`\n=== theme: ${theme} ===`);
    await runTheme(theme);
  }
  server.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
