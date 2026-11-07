// Скриншот-харнесс TaskFlow под логином — мобильный вьюпорт, живая
// аутентификация, HTTP или HTTPS.
//
// Перенесено в репозиторий 15.08.2026 (шаг «Перенести тестовый сбор
// скриншотов в репозиторий», задача b376ab48). До этого — сценарий на
// каждую сессию заново: `npm i playwright` в scratchpad конкретного job,
// написать харнесс с нуля, столкнуться с теми же тремя граблями (детали
// ниже), харнесс умирал вместе со scratchpad. Урок
// 2026-08-11-authed-mobile-screenshot-harness-before-fanout прямо
// заканчивался пунктом «стоит положить в репозиторий... не сделали, потому
// что это отдельное решение по зависимостям проекта, а Максима не было» —
// решение теперь принято explicit шагом в задаче, откладывать больше
// незачем. Слит из четырёх ad hoc скриптов одной прошлой сессии
// (shot.mjs + shot-https.mjs + мелочи из shot-interact.mjs) в один общий.
//
// Грабли, из-за которых харнесс выглядит именно так (все живые, не
// теоретические):
//  1. `npx playwright --version` отвечает, а `import { chromium }` падает —
//     это был глобальный/кэшированный CLI, модуля в проекте не было.
//     Раз playwright теперь в devDependencies самого репозитория — больше
//     не актуально, но комментарий оставлен как объяснение, почему пакет
//     именно тут, а не «где получится».
//  2. Скачанные Playwright'ом браузеры не той ревизии (кэш и версия пакета
//     расходятся, "Executable doesn't exist at .../chromium_headless_shell-…").
//     Фикс — не качать сотню МБ через Playwright, а взять системный Chrome:
//     `channel: "chrome"`.
//  3. Все экраны TaskFlow за логином — голый `playwright screenshot <url>`
//     снял бы форму входа. Харнесс сам ловит редирект на /login, логинится,
//     сохраняет storageState рядом, чтобы следующий запуск не логинился
//     заново.
//
// Использование:
//   APP_EMAIL=... APP_PASSWORD=... node scripts/screenshot.mjs <путь> <файл.png> [--mic]
// Пароль — ТОЛЬКО через переменную окружения, без запасного значения в
// коде: это тот же самый принцип, из-за которого из этого репозитория
// убрали зашитый JWT_SECRET (см. server/src/env.ts) — учётный пароль в
// исходниках не более уместен, даже тестовый.
//   APP_BASE   — по умолчанию http://localhost:5180 (для LAN/HTTPS —
//                https://192.168.1.110:5180, самоподписанный сертификат
//                @vitejs/plugin-basic-ssl, ошибки сертификата игнорируются
//                ниже НАМЕРЕННО — это dev-заглушка, не для прод-домена).
//   --mic      — выдать разрешение на микрофон и эмулировать fake-device,
//                для проверки кнопки диктовки (getUserMedia недоступен без
//                этого в headless).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_BASE = process.env.APP_BASE || "http://localhost:5180";
const EMAIL = process.env.APP_EMAIL;
const PASSWORD = process.env.APP_PASSWORD;
const urlPath = process.argv[2];
const outFile = process.argv[3];
const grantMic = process.argv.includes("--mic");

if (!urlPath || !outFile) {
  console.error(
    "Использование: APP_EMAIL=... APP_PASSWORD=... node scripts/screenshot.mjs <путь> <файл.png> [--mic]",
  );
  process.exit(1);
}
// Рядом со скриптом, не в cwd вызывающего — так следующий запуск из
// любого каталога находит ту же сохранённую сессию.
const STATE_FILE = path.join(__dirname, "auth-state.json");

// Логин нужен, только если сохранённой сессии ещё нет. Раньше переменные
// требовались всегда, и это упиралось в стену: пароль владельца агенту не
// выдаётся (vault-policy), то есть снять экран было нечем даже при готовой
// сессии рядом. Требование «пароль только из окружения» при этом в силе —
// просто спрашиваем его тогда, когда он действительно нужен.
if (!fs.existsSync(STATE_FILE) && (!EMAIL || !PASSWORD)) {
  console.error(
    "Сохранённой сессии нет, нужны APP_EMAIL и APP_PASSWORD в окружении —\n" +
      "пароль в код не зашивается.",
  );
  process.exit(1);
}

const browser = await chromium.launch({
  channel: "chrome",
  args: grantMic
    ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
    : [],
});

const contextOpts = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  ignoreHTTPSErrors: true,
};
if (grantMic) contextOpts.permissions = ["microphone"];
if (fs.existsSync(STATE_FILE)) contextOpts.storageState = STATE_FILE;

const context = await browser.newContext(contextOpts);
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(String(err)));

await page.goto(`${APP_BASE}${urlPath}`, { waitUntil: "networkidle" });

if (page.url().includes("/login")) {
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("/login"), {
    timeout: 15000,
  });
  await context.storageState({ path: STATE_FILE });
  await page.goto(`${APP_BASE}${urlPath}`, { waitUntil: "networkidle" });
}

const isSecureContext = await page.evaluate(() => window.isSecureContext);

// Ждать networkidle мало — react-query дорисовывает данные ещё несколько
// сотен мс после того, как сеть затихла (урок 2026-08-11).
await page.waitForTimeout(900);
await page.screenshot({ path: outFile });

console.log("URL:", page.url());
console.log("isSecureContext:", isSecureContext);
console.log("Консольные ошибки:", consoleErrors.length ? consoleErrors : "нет");

await browser.close();
