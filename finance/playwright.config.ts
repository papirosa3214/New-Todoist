import { defineConfig, devices } from "@playwright/test";

/**
 * E2E приложения учёта финансов.
 *
 * Отдельный конфиг от корневого набора TaskFlow (тот ходит в приложение на
 * 5180 по https). Здесь своя машина: две копии приложения — по http и за
 * https-прокси, чтобы проверить обе схемы настоящим браузером.
 *
 * Сервер поднимается в production-режиме (`next build` + `next start`):
 * именно в нём NODE_ENV=production, и именно там старый дефект был виден —
 * в dev-режиме флаг Secure не выставлялся и баг не воспроизводился.
 *
 * База тестовая (data/e2e.sqlite) и пересоздаётся на каждый прогон, живая
 * БД приложения на 3011 тест не трогает.
 */
// Порт от 3012: на хосте там уже крутится чужой сервис (отдаёт 401).
// Тесты всё равно бьют по адресу хоста, поэтому важно только не пересечься.
const APP_PORT = Number(process.env.FINANCE_E2E_PORT ?? 3931);
const HTTPS_PORT = APP_PORT + 1;
// Именно сетевой адрес, а НЕ 127.0.0.1: браузеры считают loopback
// «безопасным контекстом» и принимают Secure-cookie по http. На localhost
// дефект не воспроизводится — владелец заходит с телефона по локальной
// сети, и там Secure-cookie действительно выбрасывается.
const HOST = process.env.FINANCE_E2E_HOST ?? "192.168.1.110";
// package.json помечен как ESM, __dirname здесь недоступен.
const financeDir = import.meta.dirname;

/** Тестовый пользователь, которого создаёт seed (см. env ниже). */
export const E2E_CREDENTIALS = { username: "e2e-owner", password: "e2e-password" };

export default defineConfig({
  testDir: "./e2e",
  // Последовательно: тесты ходят в один живой сервер с общей базой.
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://${HOST}:${APP_PORT}`,
    // Самоподписанный сертификат тестового прокси.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // WebKit — браузер владельца (вход с телефона проверяется в первую
    // очередь), Chromium — второй, для быстрой прогонистой проверки.
    { name: "webkit", use: { ...devices["iPhone 14"] } },
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: [
        "rm -f data/e2e.sqlite data/e2e.sqlite-shm data/e2e.sqlite-wal",
        "npm run db:migrate",
        "npm run db:seed",
        "npm run build",
        `npx next start -p ${APP_PORT}`,
      ].join(" && "),
      cwd: financeDir,
      url: `http://${HOST}:${APP_PORT}/login`,
      // Сборка Next не мгновенная.
      timeout: 300_000,
      reuseExistingServer: false,
      stdout: "pipe",
      env: {
        FINANCE_DB_PATH: "./data/e2e.sqlite",
        FINANCE_INITIAL_USER: E2E_CREDENTIALS.username,
        FINANCE_INITIAL_PASSWORD: E2E_CREDENTIALS.password,
        FINANCE_SESSION_SECRET: "e2e-session-secret-32-bytes-of-data",
      },
    },
    {
      command: `node e2e/https-proxy.mjs ${HTTPS_PORT} ${APP_PORT} ${HOST}`,
      cwd: financeDir,
      url: `https://${HOST}:${HTTPS_PORT}/login`,
      ignoreHTTPSErrors: true,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});

