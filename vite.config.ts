import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// HTTPS на :5180 нужен ради getUserMedia (микрофон): браузер даёт его
// только в secure context, а IP LAN в это исключение не входит.
// Сертификат — локальный CA mkcert на 192.168.1.110 + localhost
// (~/Проекты/Инфраструктура/lan-ca). Корневой CA стоит в связке Mac.
const lanCertDir = "/home/maksim/Проекты/Инфраструктура/lan-ca";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // @capacitor/local-notifications не установлен (нужен только нативной
  // оболочке), но useTaskActivity.ts импортирует его. Направляем и vite, и
  // vitest на локальную заглушку — иначе `npm test` падает на резолве.
  resolve: {
    alias: {
      "@capacitor/local-notifications": path.resolve(
        process.cwd(),
        "src (Временно приостановлена разработка)/lib/localNotifications.stub.ts",
      ),
    },
  },
  server: {
    https: {
      cert: fs.readFileSync(path.join(lanCertDir, "lan.pem")),
      key: fs.readFileSync(path.join(lanCertDir, "lan-key.pem")),
    },
    proxy: {
      "/api": "http://192.168.1.110:3001",
      "/ws": { target: "ws://192.168.1.110:3001", ws: true },
    },
  },
  // Vitest и Playwright — разные раннеры с одинаковым расширением файлов.
  // Без этого исключения `npm test` подхватывал tests/e2e/*.spec.ts и падал
  // на каждом с «Playwright Test did not expect test.describe() to be called
  // here» (19.08.2026, сразу после появления e2e-набора). Юнит-тесты живут
  // в src/ и server/test, e2e гоняется своей командой playwright test.
  test: {
    // server/** — у сервера СВОЙ vitest.config.ts с setupFiles, который
    // выставляет TASKFLOW_ALLOW_REGISTRATION и подменяет путь к базе.
    // Из корня его тесты запускались без этой настройки и падали с 403 на
    // регистрации — то есть «красные» серверные тесты означали неверный
    // запуск, а не дефект. Их команда: cd server && npm test.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/e2e/**",
      "server/**",
      // macOS поверх SMB плодит AppleDouble-файлы (src/lib/._x.test.ts) —
      // vitest подбирает их как тесты и падает на бинарном содержимом.
      "**/._*",
    ],
  },
});
