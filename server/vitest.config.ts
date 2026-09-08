import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // macOS поверх SMB плодит рядом с исходниками AppleDouble-файлы
    // (test/._agent-inbox.test.ts и т.п.) — vitest подбирает их как тесты
    // и падает на «Invalid Character». Исключаем.
    exclude: ["**/node_modules/**", "**/._*"],
    // setupFiles грузится и выполняется ПОЛНОСТЬЮ раньше, чем vitest
    // импортирует сам файл теста — это единственный надёжный момент,
    // чтобы выставить DB_PATH до того, как db.ts (модульный синглтон,
    // открывает `new Database(DB_PATH)` на верхнем уровне при импорте —
    // см. db.ts) откроет хоть что-то. Поставить DB_PATH в самом файле
    // теста НЕ сработает: `import` в ES-модулях поднимается наверх при
    // разборе файла, раньше любого кода теста, который стоял бы над ним.
    setupFiles: ["./test/setup.ts"],
  },
});
