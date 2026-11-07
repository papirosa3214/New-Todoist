// Автопроверка экранов с полями ввода — на собранном dist, headless Chrome,
// БЕЗ живого сервера: весь /api/** заглушен прямо здесь.
//
// Зачем ещё один харнесс, когда есть tests/e2e (19.08.2026): тот набор
// ходит в настоящий dev-сервер и настоящий API на .110 (helpers.ts:
// GET-запросы делают route.continue), поэтому с Мака не запускается вовсе.
// Пока это не мешало, но 20.08.2026 в сборку ушёл дефект отправки ответа на
// заблокированный шаг, а «зелёными» перед сборкой были только tsc, линтер и
// юнит-тесты разбора диктовки — то есть ни один экран не открывался. Прямая
// оценка владельца: «куда тесты писались? я же говорил, пройдите тесты там,
// где есть окна для написания текста».
//
// Здесь проверяется ровно то, что дешевле всего сломать и дороже всего
// потерять: НАЖИМАЕМОСТЬ отправки в формах поверх клавиатуры.
//
// Про сам дефект. На iPhone тап по кнопке при открытой клавиатуре сперва
// уводит фокус с поля: клавиатура съезжает, страница вырастает обратно, и
// кнопка физически уезжает из-под пальца между touchstart и touchend —
// click не приходит вовсе. Ни в каком headless Chrome это не
// воспроизводится: там нет ни экранной клавиатуры, ни этого сдвига.
// Поэтому проверяется не симптом, а ИНВАРИАНТ, который его исключает:
// нажатие на кнопку отправки не должно уводить фокус из поля. Держится он
// одним preventDefault на mousedown — если его снимут, проверка падает.
import { chromium } from "playwright";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");
const PORT = 5181; // не 5180: тот занят dev-сервером, если он поднят рядом

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("Нет dist/index.html — сначала собрать: npx vite build");
  process.exit(1);
}

// ── фальшивые данные ──
const ME = { id: "u1", name: "Максим", email: "m@example.com", role: "owner", type: "human" };
const TASK = {
  id: "t1",
  title: "Задача с заблокированным шагом",
  description: null,
  due_date: null,
  project_id: null,
  priority: 1,
  assignee_id: "u1",
  creator_id: "u1",
  status: "active",
  created_at: "2026-08-20T09:00:00.000Z",
  updated_at: "2026-08-20T09:00:00.000Z",
  completed_at: null,
  subtasks: [
    {
      id: "s1",
      task_id: "t1",
      title: "Шаг, на котором агент встал",
      done: false,
      position: 0,
      state: "blocked",
      result: "Нет доступа к репозиторию",
      agent_id: "a1",
    },
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

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 420, height: 912 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
await context.addInitScript(() => localStorage.setItem("taskflow_token", "test-token"));

const posted = [];
await context.route("**/api/**", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  const json = (body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  if (req.method() !== "GET") {
    posted.push({ method: req.method(), path: p, body: (() => { try { return req.postDataJSON(); } catch { return null; } })() });
    return json({ ok: true, id: "new" });
  }
  if (p === "/api/auth/me") return json({ user: ME });
  if (p === "/api/tasks/t1") return json(TASK);
  if (p === "/api/tasks") return json([TASK]);
  if (p.startsWith("/api/users")) return json([ME]);
  // Всё прочее (проекты, метки, уведомления, агенты) — пустые списки:
  // экран задачи от них не зависит, а падать на 404 не должен.
  return json([]);
});

const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(`http://127.0.0.1:${PORT}/task/t1`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

// ── 1. Ответ на заблокированный шаг ──
const step = page.getByText("Шаг, на котором агент встал");
check("экран задачи открылся, шаг виден", (await step.count()) > 0);
if ((await step.count()) > 0) {
  await step.click();
  await page.waitForTimeout(300);

  const replyBtn = page.getByRole("button", { name: "Ответить" });
  check("у заблокированного шага есть «Ответить»", (await replyBtn.count()) > 0);
  if ((await replyBtn.count()) > 0) {
    await replyBtn.click();
    const field = page.locator('textarea[placeholder^="Например"]');
    await field.waitFor({ state: "visible", timeout: 3000 });
    await field.fill("доступ выдал, пробуй ещё раз");

    const send = page.getByRole("button", { name: "Отправить" }).first();
    check("кнопка отправки активна при непустом тексте", !(await send.isDisabled()));

    // Инвариант: нажатие не уводит фокус из поля (см. шапку файла).
    const box = await send.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const focusedAfterDown = await page.evaluate(
      () => document.activeElement?.tagName ?? "нет",
    );
    check(
      "нажатие на «Отправить» не уводит фокус из поля",
      focusedAfterDown === "TEXTAREA",
      `в фокусе ${focusedAfterDown}`,
    );
    await page.mouse.up();
    await page.waitForTimeout(600);

    const sent = posted.find((r) => r.method === "POST" && r.path.includes("/comments"));
    check(
      "ответ ушёл на сервер",
      !!sent,
      sent ? JSON.stringify(sent.body) : `записей POST: ${posted.length}`,
    );
  }
}

// ── 2. Строка комментария внизу карточки ──
{
  const input = page.locator('input[placeholder="Написать комментарий…"]');
  check("поле комментария на месте", (await input.count()) > 0);
  if ((await input.count()) > 0) {
    await input.click();
    await input.fill("проверка");
    const submit = page.locator('form button[type="submit"]').last();
    const box = await submit.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const focused = await page.evaluate(
      () => document.activeElement?.tagName ?? "нет",
    );
    check(
      "нажатие на отправку комментария не уводит фокус из поля",
      focused === "INPUT",
      `в фокусе ${focused}`,
    );
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
}

// ── 3. Порядок секций формы задачи ──
await page.goto(`http://127.0.0.1:${PORT}/task/new`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);
{
  const order = await page.evaluate(() => {
    const wanted = ["Заметка", "Подзадачи", "Файлы"];
    const found = [];
    for (const el of document.querySelectorAll("div, span")) {
      const t = (el.textContent ?? "").trim();
      if (wanted.includes(t) && el.children.length === 0 && !found.includes(t)) {
        found.push(t);
      }
    }
    return found;
  });
  check(
    "порядок секций: заметка → подзадачи → файлы",
    order.join(" → ") === "Заметка → Подзадачи → Файлы",
    order.join(" → ") || "секции не найдены",
  );
}

check("нет исключений на страницах", pageErrors.length === 0, pageErrors[0] ?? "");

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
