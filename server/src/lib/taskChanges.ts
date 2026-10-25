/**
 * Журнал изменений задач — основа для ДЕЛЬТ (вариант B трафика iOS-клиента,
 * владелец 25.10.2026).
 *
 * Зачем. Полный список задач — 127 карточек, 1,83 МБ без сжатия и 402 КБ в
 * gzip. Клиент тянул его целиком на КАЖДЫЙ разрыв связи (30 675 реконнектов
 * за неделю) — то есть платил полную цену за то, чтобы узнать, что изменилось
 * одна-две карточки. Дельта отвечает на вопрос «что изменилось с моего
 * прошлого раза» и стоит килобайты.
 *
 * Как устроено. Таблица `task_changes` — append-only журнал: одна строка на
 * изменение. Наполняют её ТРИГГЕРЫ SQLite, а не код приложения: так в журнал
 * попадает ЛЮБАЯ запись в tasks и в дочерние таблицы (subtasks, comments,
 * task_events, task_labels) — включая те, что делают агенты и фоновые службы.
 * Писать в журнал из кода значило бы забыть про какой-нибудь путь записи и
 * однажды отдать клиенту неполную дельту.
 *
 * Формат курсора — время UTC в формате SQLite `datetime('now')`
 * (`ГГГГ-ММ-ДД ЧЧ:ММ:СС`). Курсор клиента — это время последней выданной
 * дельты; следующий запрос читает всё, что не старше него.
 *
 * Границы (решения архитектора, 25.10.2026):
 *   - журнал хранит 7 дней; если курсор клиента старше — сервер отвечает
 *     `full: true` и клиент делает полную перечитку;
 *   - удаление задачи тоже попадает в журнал (`deleted = 1`), иначе клиент
 *     навсегда оставил бы у себя исчезнувшую карточку;
 *   - сервер отдаёт курсор с запасом в 2 секунды: граница секунды не должна
 *     ронять изменения, записанные в ту же секунду.
 */
import db from "../db.js";

/** Сколько дней живут записи журнала. */
const RETENTION_DAYS = 7;
/** Аварийный предел размера журнала (строк). */
const MAX_ROWS = 200_000;
/** Запас на границу секунды при чтении дельты. */
const CURSOR_MARGIN_SECONDS = 2;

/**
 * Колонки tasks, которые НЕ считаются изменением карточки. Их дёргает
 * constantly-агент (heartbeat, аренда) — по ним список задач не меняется.
 * Тот же набор, что и в `lib/realtimeInvalidation.ts`.
 */
const IGNORED_TASK_COLUMNS = [
  "updated_at",
  "agent_heartbeat_at",
  "agent_lease_until",
  "composed_prompt_snapshot",
];

export type TaskChangeRow = {
  task_id: string;
  changed_at: string;
  deleted: number;
  creator_id: string | null;
  assignee_id: string | null;
  project_id: string | null;
};

let installed = false;
let pruneTimer: NodeJS.Timeout | null = null;

/**
 * Создаёт журнал и триггеры. Вызывается один раз при старте сервера (из
 * регистрации маршрутов задач) — до этого журнала нет, и клиент, который
 * пришёл с курсором, получает `full: true` и перечитывает список целиком.
 */
export function ensureTaskChangesLedger(): void {
  if (installed) return;
  installed = true;

  db.exec(`CREATE TABLE IF NOT EXISTS task_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0,
    creator_id TEXT,
    assignee_id TEXT,
    project_id TEXT
  )`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_task_changes_changed_at ON task_changes(changed_at)`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_changes_task ON task_changes(task_id)`);

  const taskColumns = (
    db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  const meaningful = taskColumns.filter(
    (c) => !IGNORED_TASK_COLUMNS.includes(c),
  );
  const changedCond = meaningful
    .map((c) => `NEW."${c}" IS NOT OLD."${c}"`)
    .join(" OR ");

  db.exec(`CREATE TRIGGER IF NOT EXISTS tf_task_changes_ins AFTER INSERT ON tasks BEGIN
    INSERT INTO task_changes(task_id, changed_at, creator_id, assignee_id, project_id)
    VALUES (new.id, datetime('now'), new.creator_id, new.assignee_id, new.project_id);
  END;`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS tf_task_changes_upd AFTER UPDATE ON tasks
    WHEN ${changedCond || "1 = 1"} BEGIN
    INSERT INTO task_changes(task_id, changed_at, creator_id, assignee_id, project_id)
    VALUES (new.id, datetime('now'), new.creator_id, new.assignee_id, new.project_id);
  END;`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS tf_task_changes_del AFTER DELETE ON tasks BEGIN
    INSERT INTO task_changes(task_id, changed_at, deleted, creator_id, assignee_id, project_id)
    VALUES (old.id, datetime('now'), 1, old.creator_id, old.assignee_id, old.project_id);
  END;`);

  // Дочерние таблицы. Их правка меняет карточку (счётчик подзадач, лента
  // комментариев, метки), но строку tasks не трогает — без этих триггеров
  // дельта «потеряла» бы такие изменения.
  const children: Array<[string, string]> = [
    ["subtasks", "task_id"],
    ["comments", "task_id"],
    ["task_events", "task_id"],
    ["task_labels", "task_id"],
  ];
  for (const [table, key] of children) {
    const cols = (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!cols.length) continue;
    const cond = cols.map((c) => `NEW."${c}" IS NOT OLD."${c}"`).join(" OR ");
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      const row = op === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TRIGGER IF NOT EXISTS tf_task_changes_${table}_${op.toLowerCase()}
        AFTER ${op} ON ${table}
        WHEN ${cond || "1 = 1"} BEGIN
          INSERT INTO task_changes(task_id, changed_at) VALUES (${row}.${key}, datetime('now'));
        END;`);
    }
  }

  pruneTaskChanges();
  if (!pruneTimer) {
    pruneTimer = setInterval(pruneTaskChanges, 10 * 60 * 1000);
    pruneTimer.unref?.();
  }
}

/** Убирает старые записи журнала, чтобы он не рос без границ. */
export function pruneTaskChanges(): void {
  try {
    db.prepare(`DELETE FROM task_changes WHERE changed_at < datetime('now', ?)`).run(
      `-${RETENTION_DAYS} days`,
    );
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM task_changes").get() as { n: number }
    ).n;
    if (count > MAX_ROWS) {
      db.prepare(
        `DELETE FROM task_changes WHERE seq IN (SELECT seq FROM task_changes ORDER BY seq LIMIT ?)`,
      ).run(count - Math.floor(MAX_ROWS / 2));
    }
  } catch {
    // Обрезка журнала — фоновая гигиена. Не срываем из-за неё работу.
  }
}

/** Текущий курсор журнала: время последней записи (UTC, формат SQLite). */
export function ledgerCursor(): string {
  const row = db.prepare("SELECT MAX(changed_at) AS m FROM task_changes").get() as {
    m?: string | null;
  };
  if (row?.m) return row.m;
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** Порядковый номер последней записи журнала — часть ETag списка. */
export function ledgerSeq(): number {
  const row = db.prepare("SELECT MAX(seq) AS m FROM task_changes").get() as {
    m?: number | null;
  };
  return row?.m ?? 0;
}

/**
 * Приводит курсор к формату SQLite (`ГГГГ-ММ-ДД ЧЧ:ММ:СС`). Принимает и
 * `2026-10-25 18:30:00`, и ISO `2026-10-25T18:30:00Z` — клиент может прислать
 * любой. Возвращает null, если разобрать не удалось.
 */
export function normalizeCursor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  const parsed = Date.parse(trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T") + "Z");
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Записи журнала не старше курсора (с запасом на границу секунды).
 * `full: true` — журнал не покрывает запрошенный момент, клиенту нужна
 * полная перечитка.
 */
export function listTaskChanges(since: string | null): {
  rows: TaskChangeRow[];
  full: boolean;
} {
  const cursor = normalizeCursor(since);
  if (!cursor) return { rows: [], full: true };

  const oldest = db
    .prepare("SELECT MIN(changed_at) AS m FROM task_changes")
    .get() as { m?: string | null };
  if (oldest?.m && cursor < oldest.m) return { rows: [], full: true };

  const from = new Date(
    Date.parse(cursor.replace(" ", "T") + "Z") - CURSOR_MARGIN_SECONDS * 1000,
  )
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  const rows = db
    .prepare(
      `SELECT task_id, changed_at, deleted, creator_id, assignee_id, project_id
         FROM task_changes WHERE changed_at >= ? ORDER BY seq`,
    )
    .all(from) as TaskChangeRow[];
  return { rows, full: false };
}
