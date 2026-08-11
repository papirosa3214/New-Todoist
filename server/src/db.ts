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
      is_system_bot INTEGER DEFAULT 0,
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

  // Additive migration: notifications.actor_id may be missing on a DB created
  // before this column was added. actor_id tracks who performed the action.
  const notifCols = db
    .prepare("PRAGMA table_info(notifications)")
    .all() as Array<{
    name: string;
  }>;
  if (!notifCols.some((c) => c.name === "actor_id")) {
    db.exec(
      "ALTER TABLE notifications ADD COLUMN actor_id TEXT REFERENCES users(id)",
    );
  }

  // Additive migration: users.is_system_bot may be missing on a DB created
  // before this column was added. This flag marks the seeded system agents
  // (Claude_Bot, Hermes) — it is set only here and in seed.ts, never via
  // /api/auth/register, so a registered account can never grant itself
  // "system bot" status.
  if (!userCols.some((c) => c.name === "is_system_bot")) {
    db.exec("ALTER TABLE users ADD COLUMN is_system_bot INTEGER DEFAULT 0");
  }
  // Unconditional (idempotent) so u2/u3 get flagged even on a DB that
  // already had this column from an earlier partial migration.
  db.exec("UPDATE users SET is_system_bot = 1 WHERE id IN ('u2','u3')");

  // Additive migration: tasks.completed_at may be missing on a DB created
  // before this column was added. Unlike updated_at (touched on every
  // PATCH), completed_at is set only on the active→completed transition and
  // cleared back to NULL on completed→active — see PATCH /api/tasks/:id.
  // It exists so a future "Activity" screen can group completed tasks by
  // day without a later edit (e.g. changing the description) bumping a
  // task that was actually finished yesterday into "today".
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
    name: string;
  }>;
  if (!taskCols.some((c) => c.name === "completed_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN completed_at TEXT");
  }
  // Backfill, unconditional (idempotent) — same precedent as the
  // is_system_bot UPDATE above. Any task that is 'completed' but still has
  // completed_at IS NULL (a pre-existing completed task from before this
  // column existed, on either a DB that just got the ALTER TABLE above or
  // one that already had the column from an earlier partial migration) has
  // no way to know its true completion time — updated_at is the closest
  // approximation available.
  db.exec(
    "UPDATE tasks SET completed_at = updated_at WHERE status = 'completed' AND completed_at IS NULL",
  );

  // Additive migration: tasks.agent_state / tasks.agent_heartbeat_at may be
  // missing on a DB created before the agent-work protocol (AGENT-PROTOCOL.md)
  // was added. Deliberately no CHECK constraint on agent_state — valid values
  // (NULL | 'in_progress' | 'blocked' | 'review') are enforced in
  // agentState.ts, not in the schema, so the transition matrix can evolve
  // without another SQLite table-rebuild migration (see AGENT-PROTOCOL.md,
  // "Решение о хранении"). agent_state is orthogonal to `status`: a task
  // stays status='active' the whole time an agent works on it, so it never
  // disappears from the eight status==='active' filters across the frontend.
  const taskCols2 = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
    name: string;
  }>;
  if (!taskCols2.some((c) => c.name === "agent_state")) {
    db.exec("ALTER TABLE tasks ADD COLUMN agent_state TEXT");
  }
  if (!taskCols2.some((c) => c.name === "agent_heartbeat_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN agent_heartbeat_at TEXT");
  }

  // Fresh table — the agent-work journal. Only ever INSERTed and SELECTed:
  // there is no PATCH/DELETE endpoint for individual events, which is what
  // makes the journal tamper-proof from the API side (see AGENT-PROTOCOL.md,
  // "Журнал задачи"). actor_id NULL means the server itself made the entry
  // (e.g. a future lease-expired marker), not a specific user.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id),
      actor_id TEXT REFERENCES users(id),
      kind TEXT NOT NULL,
      field TEXT,
      from_value TEXT,
      to_value TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task_created
      ON task_events(task_id, created_at);
  `);
}

export default db;
