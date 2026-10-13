/**
 * Применяет SQL-схему к БД. Идемпотентно: CREATE TABLE IF NOT EXISTS.
 * Запускается как `npm run db:migrate`; при обычном старте схема
 * применяется сама при первом подключении.
 */
import Database from "better-sqlite3";
import { applySchema, DB_PATH } from "../src/db/bootstrap";

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

applySchema(sqlite);

console.log(`[migrate] готово: ${DB_PATH}`);

sqlite.close();