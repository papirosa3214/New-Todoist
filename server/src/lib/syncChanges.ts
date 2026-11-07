/**
 * Общий журнал синхронизации — `sync_changes`.
 *
 * Зачем. Журнал карточек (`lib/taskChanges.ts`) покрывает только tasks и его
 * десять дочерних таблиц. Проекты, метки, заметки, дневник, рутины и
 * вложения в него не пишутся, а события сокета (сигнал «что-то изменилось»)
 * в разрыв связи не доходят: правка рутины или заметки на сервере оставалась
 * на телефоне до перезагрузки экрана (разбор 02.11.2026, заметка Архитектора
 * «Техническое решение и риски», раздел 2).
 *
 * Как устроено. Таблица `sync_changes` — append-only журнал: одна строка на
 * изменение, с монотонным `seq`. Наполняют её ТРИГГЕРЫ SQLite, а не код
 * приложения: тогда в журнал попадает ЛЮБАЯ запись в эти таблицы, включая
 * те, что делают агенты и фоновые службы (рутины пишет
 * `runtime/schedules/store.ts`, минуя маршруты).
 *
 * Курсор — `seq` (монотонный номер), а не время: окно чтения по времени
 * даёт пропуски и дубли на границе секунды. Формат курсора — `s:<seq>`.
 * Старый временной курсор карточек (`YYYY-MM-DD HH:MM:SS`) сюда не
 * относится: у карточек свой журнал и свой курсор.
 *
 * Границы:
 *   - журнал живёт 7 дней и обрезается по числу строк (как `task_changes`);
 *   - курсор старше границы хранения → сервер отвечает `full: true`, клиент
 *     делает полную перечитку этих типов;
 *   - удаление едет тем же потоком, что и правка: `deleted = 1`.
 *
 * Видимость. В журнал пишется снимок владельца (`owner_id`) и признак
 * приватности (`flags`), потому что удалённой записи уже нет и проверить её
 * видимость по живой таблице нельзя. Сама фильтрация видимости — на сервере,
 * до выдачи (риск R3 архитектурной заметки): клиент не должен получать то,
 * что не имеет права видеть.
 */
import db from "../db.js";

/** Типы сущностей в общем журнале. */
export type SyncEntityType = "projects" | "labels" | "notes" | "schedules";

export const SYNC_ENTITY_TYPES: SyncEntityType[] = [
  "projects",
  "labels",
  "notes",
  "schedules",
];

/** Сколько дней живут записи журнала. */
const RETENTION_DAYS = 7;
/** Аварийный предел размера журнала (строк). */
const MAX_ROWS = 200_000;

export type SyncChangeRow = {
  seq: number;
  entity_type: SyncEntityType;
  entity_id: string;
  changed_at: string;
  deleted: number;
  owner_id: string | null;
  parent_id: string | null;
  flags: string | null;
};

let installed = false;
let pruneTimer: NodeJS.Timeout | null = null;

/**
 * Создаёт журнал и триггеры. Вызывается один раз при старте сервера (из
 * регистрации маршрутов синхронизации).
 */
export function ensureSyncChangesLedger(): void {
  if (installed) return;
  installed = true;
  installSyncChangesLedger();
}

/**
 * Пересоздать журнал и его триггеры, даже если они уже стоят.
 *
 * Старое определение триггера переживает правку кода
 * (`CREATE TRIGGER IF NOT EXISTS` не заменяет определение) — так сломался
 * счётчик сдач 25.10.2026. Поэтому DROP перед CREATE.
 */
export function reinstallSyncChangesLedger(): void {
  installSyncChangesLedger();
}

/** Таблицы, за которыми следит журнал, и где брать снимок видимости. */
const WATCHED: Array<{
  type: SyncEntityType;
  table: string;
  /** Выражение снимка владельца (NULL — у сущности нет владельца). */
  owner?: (row: "OLD" | "NEW") => string | null;
  /** Выражение родителя (для вложений — карточка). */
  parent?: (row: "OLD" | "NEW") => string | null;
  /** Выражение приватности (только проекты). */
  flags?: (row: "OLD" | "NEW") => string | null;
}> = [
  {
    type: "projects",
    table: "projects",
    owner: (r) => `${r}.owner_id`,
    flags: (r) => `CASE WHEN ${r}.is_private = 1 THEN 'private' ELSE '' END`,
  },
  { type: "labels", table: "labels", owner: (r) => `${r}.owner_id` },
  { type: "notes", table: "user_notes" },
  { type: "schedules", table: "task_schedules", owner: (r) => `${r}.created_by` },
];

function installSyncChangesLedger(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted INTEGER NOT NULL DEFAULT 0,
    owner_id TEXT,
    parent_id TEXT,
    flags TEXT
  )`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sync_changes_type_seq ON sync_changes(entity_type, seq)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sync_changes_entity ON sync_changes(entity_type, entity_id)`,
  );

  for (const watched of WATCHED) {
    const cols = (
      db.prepare(`PRAGMA table_info(${watched.table})`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    // Таблицы могли не появиться (миграция не применена в старой базе) —
    // тогда триггер ставить не на что.
    if (!cols.length) continue;
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      const row = op === "DELETE" ? "OLD" : "NEW";
      const name = `tf_sync_changes_${watched.table}_${op.toLowerCase()}`;
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      const owner = watched.owner ? watched.owner(row) : "NULL";
      const parent = watched.parent ? watched.parent(row) : "NULL";
      const flags = watched.flags ? watched.flags(row) : "NULL";
      db.exec(`CREATE TRIGGER ${name} AFTER ${op} ON ${watched.table} BEGIN
        INSERT INTO sync_changes(entity_type, entity_id, deleted, owner_id, parent_id, flags)
        VALUES ('${watched.type}', ${row}.id, ${op === "DELETE" ? 1 : 0}, ${owner}, ${parent}, ${flags});
      END;`);
    }
  }

  pruneSyncChanges();
  if (!pruneTimer) {
    pruneTimer = setInterval(pruneSyncChanges, 10 * 60 * 1000);
    pruneTimer.unref?.();
  }
}

/** Убирает старые записи журнала, чтобы он не рос без границ. */
export function pruneSyncChanges(): void {
  try {
    db.prepare(
      `DELETE FROM sync_changes WHERE changed_at < datetime('now', ?)`,
    ).run(`-${RETENTION_DAYS} days`);
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM sync_changes").get() as { n: number }
    ).n;
    if (count > MAX_ROWS) {
      db.prepare(
        `DELETE FROM sync_changes WHERE seq IN (SELECT seq FROM sync_changes ORDER BY seq LIMIT ?)`,
      ).run(count - Math.floor(MAX_ROWS / 2));
    }
  } catch {
    // Обрезка журнала — фоновая гигиена. Не срываем из-за неё работу.
  }
}

/**
 * Разбор курсора клиента.
 *
 * Поддерживается формат `s:<seq>` (монотонный номер). Голое число тоже
 * принимается — клиент может хранить курсор как строку без префикса.
 * Возвращает null, если разобрать не удалось: тогда клиенту нужна полная
 * перечитка.
 */
export function parseSyncCursor(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = trimmed.startsWith("s:") ? trimmed.slice(2) : trimmed;
  if (!/^\d+$/.test(value)) return null;
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

/** Текущий курсор журнала — максимальный выданный `seq`. */
export function syncCursor(): string {
  const row = db
    .prepare("SELECT MAX(seq) AS m FROM sync_changes")
    .get() as { m?: number | null };
  return `s:${row?.m ?? 0}`;
}

/**
 * Записи журнала новее курсора.
 *
 * `full: true` — журнал не покрывает запрошенный момент (курсор старше
 * границы хранения или не задан): клиенту нужна полная перечитка этих типов.
 */
export function listSyncChanges(since: string | null): {
  rows: SyncChangeRow[];
  full: boolean;
} {
  const cursor = parseSyncCursor(since);
  if (cursor === null) return { rows: [], full: true };

  const bounds = db
    .prepare("SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM sync_changes")
    .get() as { lo?: number | null; hi?: number | null };
  // Курсор старше самой ранней сохранившейся записи — часть изменений уже
  // обрезана, догонять по ним нельзя: клиент перечитывает всё.
  if (bounds?.lo != null && cursor < bounds.lo - 1) {
    return { rows: [], full: true };
  }
  // Курсор ВПЕРЕДИ журнала (журнал пересоздан, база откатилась) — догонять
  // нечего, но и «пустой» ответ был бы враньём: клиент решил бы, что
  // изменений не было, и остался бы со старым кэшем. Полная перечитка.
  if (bounds?.hi != null && cursor > bounds.hi) {
    return { rows: [], full: true };
  }

  const rows = db
    .prepare(
      `SELECT seq, entity_type, entity_id, changed_at, deleted, owner_id, parent_id, flags
         FROM sync_changes WHERE seq > ? ORDER BY seq`,
    )
    .all(cursor) as SyncChangeRow[];
  return { rows, full: false };
}
