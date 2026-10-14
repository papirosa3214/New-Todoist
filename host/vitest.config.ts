import { defineConfig } from "vitest/config";

// Тесты хоста живут своей папкой: в server/ их быть не должно, хост ставится
// на маку отдельным пакетом и по чужому vitest-конфигу не запускается.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Тест против фейкового шлюза поднимает сокет и ждёт обрыва/переподключения —
    // дефолтных 5 секунд ему мало.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});