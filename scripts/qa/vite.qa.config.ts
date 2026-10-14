// Конфиг vite для копии приложения роли QA (scripts/qa/up.sh).
// Отдельный, а не правка корневого vite.config.ts: рабочий каталог шага
// может быть старой ветки, а конфиг берётся отсюда. Отличия от основного:
// обычный http на 127.0.0.1 (без самоподписанного TLS) и прокси на копию
// API, порт которой приходит в QA_API_PORT.
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.QA_API_PORT;
if (!api) throw new Error("QA_API_PORT не задан — запускай через scripts/qa/up.sh");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@capacitor/local-notifications": path.resolve(
        process.cwd(),
        "src/lib/localNotifications.stub.ts",
      ),
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": `http://127.0.0.1:${api}`,
      "/ws": { target: `ws://127.0.0.1:${api}`, ws: true },
    },
  },
});
