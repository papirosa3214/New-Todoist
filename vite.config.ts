import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS с самоподписанным сертификатом (не Let's Encrypt — под IP локальной
// сети настоящий сертификат не выпустить) — нужен ради getUserMedia (кнопка
// микрофона, TaskFormScreen): браузер отдаёт доступ к микрофону ТОЛЬКО в
// secure context, а исключение из этого правила — строго localhost/127.0.0.1,
// НЕ вся локальная сеть. На голом http://192.168.1.110:5180 микрофон не
// заработает ни с одного устройства, кроме самой .110. Браузер один раз
// покажет предупреждение «соединение не защищено» на каждом устройстве —
// после подтверждения запоминает. Существующий прокси /api и /ws ниже
// продолжает работать как есть: он выполняется на сервере (сам vite dev
// процесс → :3001), браузер их вообще не видит напрямую, так что HTTPS
// достаточно навесить только здесь.
export default defineConfig({
  // basicSsl() сам включает server.https — отдельно его выставлять не
  // нужно (и с этой версией vite даже не типизируется как `true`, только
  // как объект TLS-опций).
  plugins: [react(), tailwindcss(), basicSsl()],
  // @capacitor/local-notifications не установлен (нужен только нативной
  // оболочке), но useTaskActivity.ts импортирует его. Направляем и vite, и
  // vitest на локальную заглушку — иначе `npm test` падает на резолве.
  resolve: {
    alias: {
      "@capacitor/local-notifications": path.resolve(
        process.cwd(),
        "src/lib/localNotifications.stub.ts",
      ),
    },
  },
  server: {
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
