import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Allow overriding the DB file (e.g. for smoke tests / alternate envs) without
// touching the default location the app has always used.
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, "..", "taskflow.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent' CHECK(role IN ('owner','agent','viewer')),
      type TEXT NOT NULL DEFAULT 'human' CHECK(type IN ('human','ai')),
      avatar_color TEXT DEFAULT '#A6A6A6',
      initials TEXT DEFAULT '',
      status TEXT DEFAULT 'offline',
      api_token TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#4A9FD8',
      owner_id TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#FF7A8A',
      owner_id TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      due_date TEXT,
      project_id TEXT REFERENCES projects(id),
      priority INTEGER DEFAULT 1 CHECK(priority BETWEEN 1 AND 4),
      assignee_id TEXT REFERENCES users(id),
      creator_id TEXT REFERENCES users(id),
      status TEXT DEFAULT 'active' CHECK(status IN ('active','completed')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_labels (
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      label_id TEXT REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, label_id)
    );

    CREATE TABLE IF NOT EXISTS subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      type TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id),
      text TEXT NOT NULL,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Additive migration: users.api_token may be missing on a DB created
  // before this column was added to the schema above (CREATE TABLE IF NOT
  // EXISTS is a no-op on an existing table).
  const userCols = db.prepare("PRAGMA table_info(users)").all() as Array<{
    name: string;
  }>;
  if (!userCols.some((c) => c.name === "api_token")) {
    db.exec("ALTER TABLE users ADD COLUMN api_token TEXT");
  }
}

export default db;
