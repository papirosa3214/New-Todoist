/**
 * Применяет SQL-схему к БД. Идемпотентно: CREATE TABLE IF NOT EXISTS.
 * Запускается при dev-старте и как `npm run db:migrate`.
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_PATH =
  process.env.FINANCE_DB_PATH ?? path.resolve(process.cwd(), "data", "finance.sqlite");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const schema = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  opening_balance REAL NOT NULL DEFAULT 0,
  opening_date TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  external_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  icon TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  description TEXT NOT NULL,
  merchant TEXT,
  category_id TEXT,
  source TEXT NOT NULL,
  external_id TEXT,
  imported_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS operations_import_key
  ON operations(account_id, source, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS operations_account_date_idx
  ON operations(account_id, date);

CREATE INDEX IF NOT EXISTS operations_date_idx
  ON operations(date);

CREATE INDEX IF NOT EXISTS operations_category_idx
  ON operations(category_id);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT
);

CREATE TABLE IF NOT EXISTS operation_tags (
  operation_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (operation_id, tag_id)
);

CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS balance_snapshots_account_date
  ON balance_snapshots(account_id, date);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx
  ON sessions(user_id);
`;

sqlite.exec(schema);

console.log(`[migrate] готово: ${DB_PATH}`);

sqlite.close();