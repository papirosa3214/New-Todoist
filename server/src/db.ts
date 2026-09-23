import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Отпечаток ключа агента. В базе хранится только он — сам ключ существует
 * ровно один раз, в момент выдачи, и дальше живёт у владельца в хранилище.
 *
 * SHA-256 без соли здесь намеренно: ключ — 256 случайных бит, его нельзя ни
 * подобрать, ни встретить в радужной таблице, а детерминированный отпечаток
 * позволяет найти пользователя одним запросом (с солёным bcrypt пришлось бы
 * перебирать всю таблицу на каждом обращении).
 */
export function hashApiToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Allow overriding the DB file (e.g. for smoke tests / alternate envs) without
// touching the default location the app has always used.
// Экспортируется, чтобы всё, что должно лежать РЯДОМ с базой (папка
// вложений — routes/attachments.ts), считало путь отсюда же, а не строило
// свой: собственный fallback уже дал папку не в том месте, потому что
// вычислялся от текущего каталога процесса, а не от файла базы.
export const DB_PATH = process.env.DB_PATH
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
      role TEXT NOT NULL DEFAULT 'agent' CHECK(role IN ('owner','agent','viewer','orchestrator','service')),
      -- Таблица roles появляется только в versioned migration 056. FK здесь
      -- сделал бы невозможными INSERT в users из более ранних миграций:
      -- при foreign_keys=ON SQLite требует уже существующую parent table.
      -- Связь role_key с roles и канонической role_<key> account закрепляет
      -- migration 058 триггерами после создания roles.
      role_key TEXT,
      type TEXT NOT NULL DEFAULT 'human' CHECK(type IN ('human','ai')),
      avatar_color TEXT DEFAULT '#A6A6A6',
      initials TEXT DEFAULT '',
      status TEXT DEFAULT 'offline',
      api_token TEXT,
      is_system_bot INTEGER DEFAULT 0,
      reviewer INTEGER NOT NULL DEFAULT 0,
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
      updated_at TEXT DEFAULT (datetime('now')),
      parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE
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

    -- Вложения комментариев. Сам файл лежит на диске (server/uploads), в
    -- базе только запись о нём: имя, тип, размер и имя файла в хранилище.
    -- Держать байты в самой базе сознательно не стали (решение Максима
    -- 14.08.2026): пара десятков скриншотов раздули бы файл базы с нынешних
    -- 176 КБ до десятков мегабайт, а это вес при каждом чтении задач и при
    -- каждой резервной копии. Плата за это — бэкап теперь из двух частей,
    -- база и папка; учтено в шаге «автобэкап» того же проекта.
    --
    -- comment_id NULL — файл уже загружен, но комментарий, к которому он
    -- прикрепляется, ещё не отправлен (человек выбрал файл и пишет текст).
    -- Такие записи привязываются при создании комментария.
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
      -- kind ('task' — файл самой задачи, 'comment' — файл ленты) добавлен
      -- миграцией 006_attachment_kind и живёт ТОЛЬКО там: колонки
      -- версионных миграций здесь не дублируются, иначе на свежей базе
      -- ALTER TABLE упадёт на «duplicate column» (так же устроены
      -- tasks.start_time и tasks.agent_session_id).
      user_id TEXT REFERENCES users(id),
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      stored_name TEXT NOT NULL,
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

    -- Per-user системные промпты для AI (extract-tasks, journal-assist и т.п.).
    -- Карточка 04c916c8, владелец 13.09.2026: «хочу в настройках править
    -- системный промпт, чтобы разбор диктовки был по моим правилам». Один
    -- пользователь — много scope'ов; PRIMARY KEY (user_id, scope) исключает
    -- дубль и упрощает upsert в обработчике PUT.
    CREATE TABLE IF NOT EXISTS user_ai_prompts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, scope)
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
  // Reviewer — отдельное узкое полномочие, а не новая роль. users.role —
  // только системная authority; business role AI-исполнителя хранится в
  // users.role_key. reviewer=1 открывает только review -> in_progress через
  // специальную проверку.
  if (!userCols.some((c) => c.name === "reviewer")) {
    db.exec("ALTER TABLE users ADD COLUMN reviewer INTEGER NOT NULL DEFAULT 0");
  }
  // Unconditional (idempotent) so u2/u3 get flagged even on a DB that
  // already had this column from an earlier partial migration.
  db.exec("UPDATE users SET is_system_bot = 1 WHERE id IN ('u2','u3')");

  // Ключи агентов хранятся ОТПЕЧАТКОМ, а не открытым текстом (15.08.2026).
  //
  // Было: в users.api_token лежал сам ключ вида «tf_<64 hex>», и сверка шла
  // прямым сравнением. Пароль человека рядом хранился хэшем, а ключ агента —
  // как есть: кто получил файл базы, тот получил и доступ агента.
  //
  // Почему SHA-256, а не bcrypt (которым хэшируются пароли): ключ — случайные
  // 256 бит, перебрать его нельзя, а замедление хэша тут только мешает. Плюс
  // bcrypt солёный, по нему не найти строку одним запросом; отпечаток же
  // детерминирован — WHERE api_token = sha256(предъявленный).
  //
  // Переход без простоя: existing открытый ключ заменяется своим отпечатком,
  // поэтому УЖЕ ВЫДАННЫЕ ключи продолжают работать — перевыпускать и
  // разносить их по конфигам не нужно. Признак «ещё не переведён» — префикс
  // «tf_», у отпечатка его нет.
  const plainTokens = db
    .prepare("SELECT id, api_token FROM users WHERE api_token LIKE 'tf_%'")
    .all() as Array<{ id: string; api_token: string }>;
  if (plainTokens.length) {
    const upd = db.prepare("UPDATE users SET api_token = ? WHERE id = ?");
    for (const row of plainTokens) {
      upd.run(hashApiToken(row.api_token), row.id);
    }
  }

  // Additive migration: users.created_by — кто завёл этого агента кнопкой
  // «Пригласить агента» (POST /api/agents). Нужен ровно для видимости:
  // список агентов намеренно не отдаёт всю таблицу пользователей, поэтому
  // без этой связи только что заведённый агент пропадал бы из списка у
  // того, кто его и создал, — до первой общей задачи. Системные боты
  // (is_system_bot = 1) видны всем и в этой колонке не нуждаются.
  if (!userCols.some((c) => c.name === "created_by")) {
    db.exec(
      "ALTER TABLE users ADD COLUMN created_by TEXT REFERENCES users(id)",
    );
  }

  // Additive migration: users.avatar_url — картинка вместо инициалов+цвета
  // (routes/avatars.ts). Колонка уже была на живой базе (кто-то добавил
  // руками, мимо migrate()) — весь код, что её читает/пишет (auth.ts,
  // projects.ts и т.д.), фактически на неё опирался ещё до этой миграции,
  // но на чистой БД с нуля упал бы на "no such column". Добавлено
  // 17.08.2026 при реализации загрузки аватарок, задним числом.
  if (!userCols.some((c) => c.name === "avatar_url")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT NULL");
  }

  // Additive migration: users.avatar_url_working / avatar_url_blocked —
  // «живая» аватарка агента (27.08.2026, просьба владельца: пусть краб
  // ведёт себя по активности, не одна статичная картинка). avatar_url
  // остаётся дефолтом (простаивает); эти два — необязательные варианты на
  // agent_state='in_progress'/'blocked' (см. computeActivity в
  // routes/projects.ts, GET /api/agents). NULL — просто нет своего
  // варианта, рендерится дефолт, ничего не падает.
  if (!userCols.some((c) => c.name === "avatar_url_working")) {
    db.exec(
      "ALTER TABLE users ADD COLUMN avatar_url_working TEXT DEFAULT NULL",
    );
  }
  if (!userCols.some((c) => c.name === "avatar_url_blocked")) {
    db.exec(
      "ALTER TABLE users ADD COLUMN avatar_url_blocked TEXT DEFAULT NULL",
    );
  }

  // Additive migration: users.profile — профиль исполнителя для матрицы прав
  // (задача b6b57092, 1-й шаг). Ортогональное users.role поле: role остаётся
  // глобальной ролью в системе (owner | agent | viewer | orchestrator), а
  // profile хранит имя профиля из server/scripts/team_catalog.json и
  // используется серверной проверкой прав (шаг 3 той же карточки).
  //
  // Без CHECK — те же причины, что и у tasks.agent_state: расширять CHECK
  // у users.role нельзя без пересборки таблицы (SQLite, миграция
  // 016_orchestrator_role — это и есть дорогая пересборка); вместо этого
  // новая колонка и валидация значений в коде. NULL — значение ещё не
  // проставлено (старые учётки без соответствия, в т.ч. «Секретарь»).
  if (!userCols.some((c) => c.name === "profile")) {
    db.exec("ALTER TABLE users ADD COLUMN profile TEXT");
  }

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

  // Additive migration: tasks.position may be missing on a DB created before
  // drag-and-drop reordering was added (TaskBoard.tsx). NULL means "never
  // manually reordered by dragging" — the frontend sorts a column's cards by
  // position when set and falls back to that view's existing default order
  // (created_at DESC / due_date ASC / etc., unchanged) for the rest, so no
  // backfill is needed here: a fresh NULL row just renders wherever it
  // already would have. Position is a per-task integer, not scoped to any
  // one column/project in the schema — two different columns' cards can
  // legitimately share the same value, which is fine (see TaskBoard.tsx
  // comment on why cross-column ties never cause a visible ordering bug).
  const taskCols3 = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
    name: string;
  }>;
  if (!taskCols3.some((c) => c.name === "position")) {
    db.exec("ALTER TABLE tasks ADD COLUMN position INTEGER");
  }

  // Additive migration (20.08.2026): pinned — «закрепить наверх», отдельно
  // от position (ручной порядок среди остальных). Владелец хочет и то, и
  // другое сразу: переставлять местами свободно, но у части задач/проектов
  // всегда быть сверху независимо от порядка. Булево, не встроено в
  // position (например «отрицательный position = закреплено») — так
  // закрепление/снятие не трогает соседние position у остальных строк, и
  // сортировка на клиенте/сервере читается прямо: `pinned DESC, position
  // ASC`. Тот же столбец нужен и projects (см. ниже) — заводится тем же
  // паттерном, что и tasks.position выше.
  if (!taskCols3.some((c) => c.name === "pinned")) {
    db.exec("ALTER TABLE tasks ADD COLUMN pinned INTEGER DEFAULT 0");
  }

  // projects.position/pinned — тот же смысл, что у tasks (см. коммент
  // выше), для блока «Мои проекты» на «Обзоре»: владелец 20.08.2026 хочет
  // сам переставлять проекты местами и закреплять важные наверх. NULL
  // position — «никогда не переставляли вручную», как и у задач.
  const projectCols = db.prepare("PRAGMA table_info(projects)").all() as Array<{
    name: string;
  }>;
  if (!projectCols.some((c) => c.name === "position")) {
    db.exec("ALTER TABLE projects ADD COLUMN position INTEGER");
  }
  if (!projectCols.some((c) => c.name === "pinned")) {
    db.exec("ALTER TABLE projects ADD COLUMN pinned INTEGER DEFAULT 0");
  }

  // Fresh table — the agent-work journal. Only ever INSERTed and SELECTed:
  // there is no PATCH/DELETE endpoint for individual events, which is what
  // makes the journal tamper-proof from the API side (see AGENT-PROTOCOL.md,
  // "Журнал задачи"). actor_id NULL means the server itself made the entry,
  // not a specific user — e.g. kind='lease_expired' (agent-state.ts): the
  // caller whose request surfaced it didn't cause the silence, so it isn't
  // credited as their action.
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

    -- Отчёты по задаче. Сам артефакт живёт документом в доках проекта
    -- (note_id), а карточка показывает его «зеркалом» — секцией «Отчёты».
    -- html_path/pdf_path — собранные файлы на диске (uploads/reports).
    CREATE TABLE IF NOT EXISTS task_reports (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      note_id TEXT,
      title TEXT NOT NULL,
      author_id TEXT REFERENCES users(id),
      author_name TEXT,
      html_path TEXT,
      pdf_path TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_reports_task
      ON task_reports(task_id, created_at DESC);
  `);

  // Токены Live Activity (Dynamic Island). Один живой островок = одна строка:
  // ключ по задаче, потому что и активность на устройстве заводится по задаче
  // (TaskActivityAttributes.taskId). Токен выдаёт сама iOS и со временем
  // меняет, поэтому строка перезаписывается по task_id, а не копится.
  //
  // Хранить их вечно нельзя и не нужно: как только активность погашена,
  // APNs отвечает на такой токен отказом, и apns.ts строку убирает.
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_activity_tokens (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id),
      token TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Момент, с которого островок считает время работы. Живёт здесь, а не в
  // приложении: пуш перезаписывает карточку целиком, и если сервер не будет
  // знать точку отсчёта, счётчик будет прыгать в ноль на каждом обновлении.
  const latCols = db
    .prepare("PRAGMA table_info(live_activity_tokens)")
    .all() as any[];
  if (!latCols.some((c) => c.name === "started_at")) {
    db.exec("ALTER TABLE live_activity_tokens ADD COLUMN started_at TEXT");
  }

  // Заполнение users.profile из server/scripts/team_catalog.json (задача
  // b6b57092, шаг 1). Идемпотентно: при перезапуске UPDATE проставит те же
  // значения, ничего не задвоится. Файл читается по id профиля: profiles.*.id
  // совпадает с users.id (проверено 11.09.2026 на живой базе), а в profile
  // пишется ключ профиля (claude_bot / hermes / reviewer / ...), чтобы по
  // нему доставать свойства из team_catalog.json в шаге 3.
  //
  // Файл может не найтись (dev-сборка без scripts/), JSON может быть
  // повреждён — миграция не падает, profile остаётся NULL. Предупреждение в
  // лог достаточно: это не та ошибка, из-за которой нужно ронять старт.
  try {
    const catalogPath = path.join(
      __dirname,
      "..",
      "scripts",
      "team_catalog.json",
    );
    const catalogRaw = fs.readFileSync(catalogPath, "utf-8");
    const catalog = JSON.parse(catalogRaw) as {
      profiles?: Record<string, { id?: string }>;
    };
    const upd = db.prepare("UPDATE users SET profile = ? WHERE id = ?");
    for (const [name, profile] of Object.entries(catalog.profiles ?? {})) {
      if (!profile?.id) continue;
      upd.run(name, profile.id);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      "users.profile: не удалось заполнить из team_catalog.json —",
      msg,
    );
  }

  // Попытка исполнения (attempt) — задача 8ca87c61, шаг 1. Отдельная
  // сущность со своим жизненным циклом «создана → работает → завершена»,
  // привязанная к задаче или подзадаче. Аренда и heartbeat переедут сюда
  // в шаге 2, а пока таблица-скелет с минимальным набором полей, чтобы
  // инвариант «не более одной действующей попытки» уже enforced на БД.
  //
  // outcome/reason/cost — текст, потому что SQLite не имеет JSON-типа
  // (есть json1, но проект на него не подписан, расширение аддитивное и
  // лёгкое). Сериализация в коде через JSON.stringify/parse. Проверка
  // допустимых значений `outcome` — в коде (в CHECK не завернём, чтобы
  // будущие значения не требовали пересборки таблицы, см. tasks.agent_state
  // для того же приёма).
  db.exec(`
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      subtask_id TEXT REFERENCES subtasks(id) ON DELETE CASCADE,
      executor_id TEXT NOT NULL REFERENCES users(id),
      runner TEXT,
      model TEXT,
      routing_role TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      outcome TEXT,
      reason TEXT,
      cost TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_task_started
      ON attempts(task_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_attempts_subtask_started
      ON attempts(subtask_id, started_at);
    -- Инвариант C1: «на один исполняемый элемент работы — не более одной
    -- действующей попытки». Для задачи целиком это «не более одной
    -- попытки с ended_at IS NULL И subtask_id IS NULL»; параллельные
    -- подзадачи живут на своих строках с тем же ограничением по
    -- subtask_id. Partial index в SQLite поддерживает WHERE, и NULL-ы
    -- трактуются как distinct — это то, что нужно (ended_at NULL = «в работе»).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_active_per_task
      ON attempts(task_id) WHERE ended_at IS NULL AND subtask_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_active_per_subtask
      ON attempts(subtask_id) WHERE ended_at IS NULL AND subtask_id IS NOT NULL;
  `);

  // Привязка задачи к текущей действующей попытке (задача 8ca87c61, шаг 2).
  // Аддитивная миграция: NULL у существующих строк (на момент 11.09.2026 у
  // всех задач ещё нет attempt, ретроактивно создавать не нужно — старая
  // модель с tasks.agent_state продолжает жить, attempts создаётся только
  // для новых claim'ов).
  const taskCols5 = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
    name: string;
  }>;
  if (!taskCols5.some((c) => c.name === "current_attempt_id")) {
    db.exec(
      "ALTER TABLE tasks ADD COLUMN current_attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL",
    );
  }
  // heartbeat попытки — отдельное поле, чтобы аренда переехала с tasks
  // на attempts. Старое tasks.agent_heartbeat_at не трогаем в этой миграции
  // (обратная совместимость с существующим кодом), обновляются оба.
  const attCols1 = db.prepare("PRAGMA table_info(attempts)").all() as Array<{
    name: string;
  }>;
  if (!attCols1.some((c) => c.name === "heartbeat_at")) {
    db.exec("ALTER TABLE attempts ADD COLUMN heartbeat_at TEXT");
  }
  if (!attCols1.some((c) => c.name === "routing_role")) {
    db.exec("ALTER TABLE attempts ADD COLUMN routing_role TEXT");
  }
  // Спек 1.2, 1.2.7 — пометка «consultation_suggested» (R7). Храним JSON-
  // массив причин: 'diff_size' (>300 строк) и/или 'edits_no_tests' (>2
  // правок в одном файле без зелёных тестов). Множество, не счётчик:
  // один раз зашли — и до конца попытки причина остаётся (агент сам
  // решает, идти ли за консультацией).
  if (!attCols1.some((c) => c.name === "consultation_suggested_reasons")) {
    db.exec("ALTER TABLE attempts ADD COLUMN consultation_suggested_reasons TEXT");
  }

  // Блокер 3 карточки 8ca87c61 (ревью 11.09.2026): подзадача получает
  // собственную попытку, а не наследует current_attempt_id родительской
  // задачи. Инвариант «не более одной действующей попытки на подзадачу»
  // (partial unique index idx_attempts_one_active_per_subtask) уже enforced;
  // current_subtask_attempt_id — это просто обратная ссылка, чтобы
  // /subtasks/:id/work знал, какую попытку продлевать.
  const subCols1 = db.prepare("PRAGMA table_info(subtasks)").all() as Array<{
    name: string;
  }>;
  if (!subCols1.some((c) => c.name === "current_attempt_id")) {
    db.exec(
      "ALTER TABLE subtasks ADD COLUMN current_attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL",
    );
  }

  // Enricher/пул задач: зависимости и отдельный журнал эскалаций.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, depends_on_task_id),
      CHECK (task_id <> depends_on_task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_task
      ON task_dependencies(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_parent
      ON task_dependencies(depends_on_task_id);

    CREATE TABLE IF NOT EXISTS enrichment_escalations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      input_text TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      final_label_ids_json TEXT,
      run_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_enrichment_escalations_status
      ON enrichment_escalations(status);
  `);
}

export default db;
