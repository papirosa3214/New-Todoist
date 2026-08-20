// Автопроверка своей экранной клавиатуры (AppKeyboard + KeyboardProvider).
//
// Зачем этот скрипт вообще появился (18.08.2026, прямой упрёк владельца:
// «как ты проверяешь, что ты даже вот это не смог уловить сам, послал меня
// и не проверил»): две подряд поломки клавиатуры были найдены НЕ здесь, а
// вручную на телефоне, хотя обе воспроизводятся в обычном Chrome:
//
//  1) панель не появлялась вовсе — объект React-контекста пересобирался на
//     каждом рендере провайдера, эффект в поле перезапускался, и его cleanup
//     сбрасывал активное поле в том же кадре, в котором фокус его выставил;
//  2) панель закрывалась на первом же нажатии — тап по клавише (настоящая
//     кнопка) уводит фокус с поля, focusout закрывал панель.
//
// Ни то, ни другое не специфично для iOS. Поэтому проверка гоняется на
// собранном бандле в headless Chrome, и посылать человека тапать больше не
// нужно.
//
// Тестируется СОБРАННЫЙ dist, а не dev-сервер: у dev-сервера /api
// проксируется на localhost:3001, которого на Маке нет — сервер живёт на
// .110. Собранный бандл ходит на адрес из VITE_API_URL напрямую.
//
// Использование:
//   VITE_API_URL=http://192.168.1.110:3001 npx vite build
//   node scripts/kb-check.mjs
//
//   APP_BASE — по умолчанию http://127.0.0.1:5180. Порт именно 5180, и это не
//              вкусовщина: сервер держит ЯВНЫЙ список разрешённых CORS-источников
//              (server/src/index.ts) — localhost:5180, 127.0.0.1:5180 и
//              capacitor://localhost. С любого другого порта preflight не
//              отдаёт access-control-allow-origin, браузер режет запрос, и
//              приложение рисует «Нет соединения с сервером» при живом API.
//              Именно HTTP, и именно свой
//              статический сервер вместо `vite preview`: preview поднимается
//              с сертификатом (@vitejs/plugin-basic-ssl), то есть страница
//              идёт по HTTPS, а API — по HTTP на .110. Браузер такой
//              смешанный контент блокирует, и приложение показывало «Нет
//              соединения с сервером» при живом API. Одинаковая схема у
//              страницы и у API снимает вопрос целиком.
//   Аутентификация — токеном из scripts/auth-state.json. Логин по паролю тут
//   намеренно не реализован: пароль в код не зашивается (см. шапку
//   screenshot.mjs), а для проверки клавиатуры хватает сохранённой сессии.
import { chromium } from "playwright";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const APP_BASE = process.env.APP_BASE || "http://127.0.0.1:5180";
const STATE_FILE = path.join(__dirname, "auth-state.json");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function readToken() {
  if (!fs.existsSync(STATE_FILE)) return null;
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  for (const origin of state.origins ?? []) {
    for (const item of origin.localStorage ?? []) {
      if (item.name === "taskflow_token") return item.value;
    }
  }
  return null;
}

const token = readToken();
if (!token) {
  console.error(
    "Нет токена в scripts/auth-state.json — сначала снять сессию через scripts/screenshot.mjs.",
  );
  process.exit(1);
}

// ── статический сервер собранного dist ──
// SPA-фолбэк обязателен: маршруты вида /task/:id на диске не существуют, без
// отдачи index.html они дали бы 404 вместо приложения.
const DIST = path.join(ROOT, "dist");
if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(
    "Нет dist/index.html — сначала собрать: VITE_API_URL=http://192.168.1.110:3001 npx vite build",
  );
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let filePath = path.join(DIST, decodeURIComponent(url.pathname));
  // Защита от выхода за пределы dist — сервер локальный, но правило дешёвое.
  if (!filePath.startsWith(DIST)) filePath = DIST;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, "index.html");
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream",
  });
  fs.createReadStream(filePath).pipe(res);
});

const previewPort = Number(new URL(APP_BASE).port || 4173);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(previewPort, "127.0.0.1", resolve);
});

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  ignoreHTTPSErrors: true,
});
// Токен обязан лежать в localStorage ДО первого рендера приложения, иначе
// оно успеет отправить на /login.
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  ["taskflow_token", token],
);

const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err)));

const KB = "[data-app-keyboard]";

async function open(pathname) {
  await page.goto(`${APP_BASE}${pathname}`, { waitUntil: "networkidle" });
  // react-query дорисовывает данные ещё несколько сотен мс после того, как
  // сеть затихла (урок 2026-08-11).
  await page.waitForTimeout(900);
}

/** Ключевой сценарий: фокус → панель видна → нажатие → текст вырос И панель
    осталась. Именно вторая половина и ловит регресс «прячется при вводе». */
async function typeInto(selector, label) {
  const field = page.locator(selector).first();
  if ((await field.count()) === 0) {
    check(`${label}: поле найдено`, false, `нет ${selector}`);
    return;
  }

  const inputMode = await field.getAttribute("inputmode");
  check(
    `${label}: системная клавиатура погашена (inputmode=none)`,
    inputMode === "none",
    `inputmode=${inputMode}`,
  );

  await field.click();
  const appeared = await page
    .locator(KB)
    .waitFor({ state: "visible", timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check(`${label}: панель появилась по фокусу`, appeared);
  if (!appeared) return;

  const before = await field.inputValue();
  // Кнопка буквы «к» — data-skbtn проставляет сама библиотека.
  await page.locator(`${KB} [data-skbtn="к"]`).first().click();
  await page.waitForTimeout(250);

  const after = await field.inputValue();
  check(
    `${label}: символ дошёл до поля`,
    after === `${before}к`,
    `было "${before}", стало "${after}"`,
  );
  check(
    `${label}: панель НЕ закрылась при вводе`,
    await page.locator(KB).isVisible(),
  );

  // Backspace — вернуть поле в исходное состояние, чтобы проверка не
  // оставляла мусор в данных, если поле связано с сохранением.
  await page.locator(`${KB} [data-skbtn="{bksp}"]`).first().click();
  await page.waitForTimeout(200);
  check(
    `${label}: backspace работает`,
    (await field.inputValue()) === before,
    `стало "${await field.inputValue()}"`,
  );
}

// ── 1. Поиск: самое простое поле, сразу на экране ──
await open("/search");
await typeInto('input[placeholder*="Задачи"]', "Поиск");

// ── 2. Форма задачи: textarea, multiline ──
await open("/task/new");
const titleSel = 'textarea[placeholder="Название задачи"]';
await typeInto(titleSel, "Название задачи (textarea)");
// ── Пробел переживает blur ──
//
// Почему проверка выглядит странно (ручной blur посреди набора): на
// устройстве blur приходит на КАЖДОЕ нажатие — клавиши настоящие кнопки,
// и фокус уходит на них. В обычном Chrome preventMouseDownDefault у
// simple-keyboard фокус в поле удерживает, blur не приходит вовсе, и
// целый класс поломок «что-то на blur переписывает поле» здесь физически
// не воспроизводился. Ровно так 20.08.2026 и ушёл в сборку баг: разбор
// диктовки на onBlur сравнивал разобранный заголовок с сырым, а
// parseDictation обрезает пробелы сам — каждый хвостовой пробел выглядел
// как «разбор что-то изменил», и текст переписывался обрезанным. Владелец
// поймал это пальцем, харнесс — нет. Blur здесь ручной именно поэтому.
{
  const field = page.locator(titleSel).first();
  await field.click();
  await page.locator(`${KB} [data-skbtn="к"]`).first().click();
  await page.waitForTimeout(150);
  await page.locator(`${KB} [data-skbtn="{space}"]`).first().click();
  await page.waitForTimeout(150);
  await field.evaluate((el) => el.blur());
  await page.waitForTimeout(250);
  const afterBlur = await field.inputValue();
  check(
    "хвостовой пробел переживает blur поля",
    afterBlur === "к ",
    `ожидалось "к ", получено ${JSON.stringify(afterBlur)}`,
  );

  // Та же ловушка с другой стороны: разбор не должен и заглавную наводить
  // на ровном месте — capitalizeFirst стоял за тем же сравнением.
  check(
    "разбор не трогает регистр без маркеров",
    afterBlur.startsWith("к"),
    `получено ${JSON.stringify(afterBlur)}`,
  );

  await field.click();
  for (let i = 0; i < 2; i++) {
    await page.locator(`${KB} [data-skbtn="{bksp}"]`).first().click();
    await page.waitForTimeout(120);
  }
}

// {enter} в многострочном обязан вставлять перевод строки, а не закрывать.
{
  const field = page.locator(titleSel).first();
  await field.click();
  const before = await field.inputValue();
  await page.locator(`${KB} [data-skbtn="{enter}"]`).first().click();
  await page.waitForTimeout(250);
  check(
    "textarea: {enter} вставляет перевод строки",
    (await field.inputValue()) === `${before}\n`,
  );
  check(
    "textarea: панель осталась после {enter}",
    await page.locator(KB).isVisible(),
  );
}

// ── 2b. Каретка и поток нажатий ──
// Владелец 18.08.2026: «каретка себя нестабильно ведёт», «зажимаю кнопочку,
// оно всё удаляет, потом лагает и умирает». Причина была в наблюдателе мутаций,
// сканировавшем весь документ на каждую мутацию. Эти проверки существуют, чтобы
// такое не вернулось молча: важна не только правильность значения, но и время.
{
  const field = page.locator(titleSel).first();
  await field.click();
  // Сначала очистим то, что осталось от проверок выше.
  const start = await field.inputValue();
  for (let i = 0; i < start.length; i++) {
    await page.locator(`${KB} [data-skbtn="{bksp}"]`).first().click();
  }
  await page.waitForTimeout(200);

  // Поток нажатий: 20 символов подряд без пауз.
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    await page.locator(`${KB} [data-skbtn="а"]`).first().click();
  }
  const typeMs = Date.now() - t0;
  await page.waitForTimeout(300);
  check(
    "поток из 20 нажатий: все символы дошли",
    (await field.inputValue()) === "а".repeat(20),
    `получилось "${(await field.inputValue()).slice(0, 30)}"`,
  );

  // Каретка: поле всё ещё в фокусе, и она стоит в конце текста. Именно это
  // ломалось от лишних потерь фокуса.
  const caret = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return {
      focused: document.activeElement === el,
      start: el.selectionStart,
      len: el.value.length,
    };
  }, titleSel);
  check("каретка: поле осталось в фокусе после ввода", caret.focused);
  check(
    "каретка: стоит в конце текста",
    caret.start === caret.len,
    `selectionStart=${caret.start}, длина=${caret.len}`,
  );

  // Поток удалений: столько же backspace подряд.
  const t1 = Date.now();
  for (let i = 0; i < 20; i++) {
    await page.locator(`${KB} [data-skbtn="{bksp}"]`).first().click();
  }
  const delMs = Date.now() - t1;
  await page.waitForTimeout(300);
  check(
    "поток из 20 backspace: поле очищено",
    (await field.inputValue()) === "",
    `осталось "${await field.inputValue()}"`,
  );
  // Порог щедрый: важно поймать деградацию в разы, а не микросекунды. До
  // починки наблюдателя каждое нажатие тянуло полный обход DOM.
  check(
    "нажатия не деградируют по времени",
    typeMs / 20 < 250 && delMs / 20 < 250,
    `ввод ${Math.round(typeMs / 20)} мс/клавиша, удаление ${Math.round(delMs / 20)} мс/клавиша`,
  );
  check("панель жива после потока нажатий", await page.locator(KB).isVisible());
}

// ── 2c. НАСТОЯЩЕЕ удержание клавиши ──
// Клики Playwright удержание не воспроизводят: библиотека повторяет нажатие по
// своему таймеру, пока кнопка зажата (handleButtonHold). Именно на этом
// сценарии владелец получил «всё удаляет, потом лагает и умирает», поэтому
// жмём мышью и держим.
{
  const field = page.locator(titleSel).first();
  await field.click();
  for (let i = 0; i < 12; i++) {
    await page.locator(`${KB} [data-skbtn="б"]`).first().click();
  }
  await page.waitForTimeout(200);
  const before = await field.inputValue();

  const bksp = page.locator(`${KB} [data-skbtn="{bksp}"]`).first();
  const box = await bksp.boundingBox();
  const t0 = Date.now();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1500);
  await page.mouse.up();
  const holdMs = Date.now() - t0;
  await page.waitForTimeout(400);

  const after = await field.inputValue();
  check(
    "удержание backspace удаляет несколько символов",
    after.length < before.length,
    `было ${before.length}, стало ${after.length} за ${holdMs} мс`,
  );
  check("удержание: страница отвечает, панель жива", await page.locator(KB).isVisible());
  // Отзывчивость после удержания: если бы поток нажатий подвесил страницу,
  // следующий одиночный клик не дошёл бы за отведённое время.
  const t1 = Date.now();
  await page.locator(`${KB} [data-skbtn="в"]`).first().click();
  await page.waitForTimeout(150);
  check(
    "после удержания ввод продолжает работать",
    (await field.inputValue()).endsWith("в"),
    `клик занял ${Date.now() - t1} мс`,
  );
  const caretAfterHold = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return { focused: document.activeElement === el, start: el.selectionStart, len: el.value.length };
  }, titleSel);
  check("каретка после удержания: в фокусе и в конце", caretAfterHold.focused && caretAfterHold.start === caretAfterHold.len,
    `focused=${caretAfterHold.focused}, selectionStart=${caretAfterHold.start}, длина=${caretAfterHold.len}`);

  // Очистка поля перед следующими блоками.
  const rest = await field.inputValue();
  for (let i = 0; i < rest.length; i++) await bksp.click();
}

// ── 3. Подъём контента: формы не должны уезжать под панель ──
{
  const inset = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--kb-inset").trim(),
  );
  const insetPx = parseFloat(inset) || 0;
  check(
    "--kb-inset поднят на высоту панели",
    insetPx > 100,
    `--kb-inset=${inset}`,
  );
}

// ── 4. Закрытие: клик вне поля убирает панель ──
{
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(400);
  check("панель закрывается по клику вне поля", !(await page.locator(KB).isVisible()));
  const inset = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--kb-inset").trim(),
  );
  check("--kb-inset вернулся к нулю", parseFloat(inset) === 0, `--kb-inset=${inset}`);
}

// ── 5. Опт-аут: на /login своей клавиатуры быть не должно ──
{
  await context.clearCookies();
  await page.goto(`${APP_BASE}/login`, { waitUntil: "networkidle" });
  await page.evaluate(() => window.localStorage.removeItem("taskflow_token"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const email = page.locator('input[type="email"]').first();
  if ((await email.count()) > 0) {
    await email.click();
    await page.waitForTimeout(400);
    check(
      "/login: своя клавиатура НЕ показывается",
      (await page.locator(KB).count()) === 0,
    );
    check(
      "/login: поле не помечено inputmode=none",
      (await email.getAttribute("inputmode")) !== "none",
    );
  } else {
    check("/login: поле email найдено", false);
  }
}

// ── 6. «Сырые» поля, написанные мимо TextField ──
// Ровно на них владелец и ловил СИСТЕМНУЮ клавиатуру 18.08.2026: комментарий
// в задаче и модалка проекта. Делегирование по DOM обязано покрывать и их —
// эти проверки существуют, чтобы регресс тут не прошёл молча.
{
  // Заново кладём токен: предыдущий блок его снёс для проверки /login.
  await page.evaluate(
    ([k, v]) => window.localStorage.setItem(k, v),
    ["taskflow_token", token],
  );

  // Задачу создаём сами и удаляем за собой: /inbox у аккаунта бывает пуст, а
  // проверка не должна зависеть от того, что кто-то оставил в данных.
  const API = process.env.VITE_API_URL || "http://192.168.1.110:3001";
  let taskId = null;
  try {
    const res = await fetch(`${API}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: "kb-check: временная задача" }),
    });
    // Сервер отвечает { task: { id } }, а не плоским объектом.
    if (res.ok) taskId = (await res.json())?.task?.id ?? null;
  } catch {
    /* сеть до API — проверим ниже по taskId */
  }

  if (!taskId) {
    check(
      "создана задача для проверки комментария",
      false,
      `POST ${API}/api/tasks не отдал id`,
    );
  } else {
    await open(`/task/${taskId}`);
    const commentSel =
      'input[placeholder*="омментар"], textarea[placeholder*="омментар"]';
    if ((await page.locator(commentSel).count()) > 0) {
      await typeInto(commentSel, "Комментарий в задаче (сырое поле)");
    } else {
      check(
        "Комментарий в задаче: поле найдено",
        false,
        "нет поля комментария на экране задачи",
      );
    }
    try {
      await fetch(`${API}/api/tasks/${taskId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      console.warn(`не удалось удалить временную задачу ${taskId} — убрать вручную`);
    }
  }

  // Модалка проекта: поле появляется в DOM только после нажатия кнопки —
  // это и проверяет, что MutationObserver подхватывает новые поля.
  await open("/projects");
  const addProject = page.locator('button:has-text("Создать проект")').first();
  if ((await addProject.count()) > 0) {
    await addProject.click();
    await page.waitForTimeout(700);
    await typeInto(
      'input[placeholder="Название проекта"]',
      "Название проекта (модалка, поле создано на ходу)",
    );
  } else {
    check("Кнопка «Создать проект» найдена", false);
  }
}

check("нет исключений на страницах", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} проверок пройдено`,
);
process.exit(failed.length === 0 ? 0 : 1);
