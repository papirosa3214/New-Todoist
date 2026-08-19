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
  {
    id: "003_subtask_work",
    description:
      "подзадача как единица работы: кто её ведёт, когда подал сигнал, и краткий итог — чтобы в ленте было видно, ГДЕ агент внутри задачи, а не только «взял» и «сдал»",
    up: () => {
      // Состояния намеренно те же, что у задачи (agentState.ts): NULL —
      // никто не ведёт, in_progress — ведут сейчас, blocked — упёрлись.
      // Отдельного «done» здесь нет: готовность подзадачи как была, так и
      // осталась в поле done — не заводим второй источник правды о том же.
      db.exec(`
        ALTER TABLE subtasks ADD COLUMN agent_state TEXT;
        ALTER TABLE subtasks ADD COLUMN agent_id TEXT REFERENCES users(id);
        ALTER TABLE subtasks ADD COLUMN agent_heartbeat_at TEXT;
        ALTER TABLE subtasks ADD COLUMN result TEXT;
      `);
      // Индекс под «покажи, что сейчас в работе» — выборка идёт по
      // состоянию, а не по задаче.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_subtasks_agent_state ON subtasks(agent_state)",
      );
    },
  },
  {
    id: "004_agent_session_id",
    description:
      "чей это claim физически: несколько параллельных сессий Claude Code делят один и тот же учётный аккаунт-агента (Claude_Bot) в TaskFlow, поэтому agent_state/assignee_id одни не отличают «эту сессию ведёт мой процесс» от «ведёт кто-то ещё под тем же ботом» — понадобилось после того, как taskflow-progress-gate.py (Stop-хук) начал блокировать сессии чужой незавершённой работой того же бота (18.08.2026)",
    up: () => {
      db.exec("ALTER TABLE tasks ADD COLUMN agent_session_id TEXT;");
    },
  },
  {
    id: "005_task_time_of_day",
    description:
      "час начала и длительность задачи — под календарную развёртку в разделе «День» (18.08.2026). Оба поля НЕОБЯЗАТЕЛЬНЫЕ и по умолчанию пустые: задача без них остаётся обычной задачей списка, поведение существующих 106 задач не меняется. Хранение намеренно симметрично due_date: там голая дата «ГГГГ-ММ-ДД» без времени и часового пояса, здесь — голое местное время «ЧЧ:ММ» тем же текстом, без даты и пояса. Держать время внутри due_date (ISO-таймстамп) было бы дороже: пришлось бы переписать все существующие сравнения дат на фронте и сервере и завести работу с поясами ради поля, которое у 90 задач из 106 пустое.",
    up: () => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN start_time TEXT;
        ALTER TABLE tasks ADD COLUMN duration_min INTEGER;
      `);
      // Выборка календаря — «что на этот день, по порядку часов»: сначала
      // отсекается дата, потом сортируется время. Индекс по паре, а не по
      // одному start_time, иначе он этой выборке не поможет.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_tasks_due_start ON tasks(due_date, start_time)",
      );
    },
  },
  {
    id: "006_attachment_kind",
    description:
      "вид вложения: 'comment' (файл в ленте, у своего комментария — единственное поведение до 19.08.2026) или 'task' (файл приложен к самой задаче, в её заметке). Понадобилось, чтобы файлы можно было прикладывать ПРИ СОЗДАНИИ задачи, а не только комментарием после (просьба Максима 19.08.2026). Отличить одним comment_id нельзя: у комментарийного вложения он тоже NULL всё время, пока комментарий не отправлен, — брошенный черновик после перезагрузки страницы выглядел бы вложением задачи. Все существующие записи получают 'comment' — это про них правда, других вложений до сих пор не было.",
    up: () => {
      // DEFAULT 'comment' в ALTER TABLE проставляет значение и уже
      // существующим строкам — отдельный UPDATE не нужен.
      db.exec(
        "ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment';",
      );
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
