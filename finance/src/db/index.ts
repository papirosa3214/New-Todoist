import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "node:path";

const DB_PATH =
  process.env.FINANCE_DB_PATH ?? path.resolve(process.cwd(), "data", "finance.sqlite");

declare global {
  // eslint-disable-next-line no-var
  var __financeDb: Database.Database | undefined;
}

const sqlite =
  globalThis.__financeDb ??
  new Database(DB_PATH, { fileMustExist: false });

if (!globalThis.__financeDb) {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  globalThis.__financeDb = sqlite;
}

export const db = drizzle(sqlite, { schema });
export { sqlite, schema };