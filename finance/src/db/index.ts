import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { applySchema, ensureDatabase, DB_PATH } from "./bootstrap";

declare global {
  // eslint-disable-next-line no-var
  var __financeDb: Database.Database | undefined;
}

/**
 * Первый запуск не тупит: каталог и схема создаются при первом подключении,
 * отдельный шаг `npm run db:migrate` больше не обязателен.
 */
const sqlite =
  (globalThis.__financeDb ??
    (ensureDatabase(), new Database(DB_PATH, { fileMustExist: false })));

if (!globalThis.__financeDb) {
  applySchema(sqlite);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  globalThis.__financeDb = sqlite;
}

export const db = drizzle(sqlite, { schema });
export { sqlite, schema };