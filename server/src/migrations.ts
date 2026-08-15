// Версионные миграции — поверх, а не вместо `migrate()` в db.ts.
//
// `migrate()` уже идемпотентна (CREATE TABLE IF NOT EXISTS + проверки
// колонок перед ALTER TABLE) и продолжает выполняться на каждом старте как
// раньше — переписывать её ради красоты не стали («не переписывать
// существующее ради красоты», см. память Максима). Здесь — только то, чего
// в ней не было: явный, пронумерованный, отслеживаемый список изменений
// схемы поверх базовой, с таблицей `schema_migrations`, которая фиксирует,
// что применено и когда. Это и есть разница между «набором ALTER TABLE,
// защищённых проверкой колонки» и версионными миграциями — здесь видно
// историю, а не только текущее состояние.
//
// `001_baseline` не содержит кода — это ярлык на всё, что уже делает
// migrate(), зафиксированный как отправная точка. Каждая следующая
// миграция — новый прирост схемы, который раньше пришлось бы дописывать в
// migrate() тем же наращиваемым стилем; теперь это отдельная, поимённая,
// один раз применяемая запись.
import db from "./db.js";

export type Migration = {
  id: string;
  description: string;
  up: () => void;
};

const migrations: Migration[] = [
  {
    id: "001_baseline",
    description:
      "схема на момент введения versioned migrations — уже применена через migrate() в db.ts, здесь только отметка",
    up: () => {},
  },
  {
    id: "002_indexes",
    description:
      "индексы на внешние ключи, не покрытые PRIMARY KEY — иначе каждый список задач/подзадач/меток был бы полным сканом таблицы",
    up: () => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
        CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
        CREATE INDEX IF NOT EXISTS idx_labels_owner ON labels(owner_id);
        CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
        CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels(label_id);
      `);
      // task_labels(task_id) не добавляется отдельно — это уже левый
      // столбец её собственного PRIMARY KEY (task_id, label_id), SQLite
      // строит по нему неявный индекс сам.
    },
  },
];

/** Применить все ещё не применённые миграции, по одной транзакции на каждую. */
export function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (
      db.prepare("SELECT id FROM schema_migrations").all() as Array<{
        id: string;
      }>
    ).map((r) => r.id),
  );

  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    const txn = db.transaction(() => {
      m.up();
      db.prepare(
        "INSERT INTO schema_migrations (id, description) VALUES (?, ?)",
      ).run(m.id, m.description);
    });
    txn();
  }
}
