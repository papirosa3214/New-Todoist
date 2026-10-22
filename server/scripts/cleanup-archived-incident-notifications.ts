// Разовая зачистка легаси: уведомления типа `incident` у архивных карточек.
//
// Зачем. Правка ef62ab79 (архив карточки починки удаляет её уведомление о
// поломке) работает только в момент архивирования. Карточки, отправленные в
// архив ДО выкладки этой правки, сохранили своё уведомление `incident`: запись
// поломки продолжала висеть в базе, и критерий «архив → запись исчезает» на
// такой карточке не сходился. Обратного заполнения правка не делала — нужен
// отдельный разовый проход по уже накопленным остаткам.
//
// Что делает. Находит уведомления `type = 'incident'`, чья карточка уже в
// архиве (`tasks.archived_at IS NOT NULL`), показывает их списком и — только с
// флагом `--apply` — удаляет. Правило «одна поломка — одна карточка» живёт по
// открытым карточкам (`incidents.ts`, `openIncidentTaskId`), поэтому удаление
// остатка у архивной карточки повторное возникновение поломки не блокирует:
// новая карточка и новое уведомление появятся как обычно.
//
// Границы. Трогаем только `notifications` типа `incident` у архивных карточек.
// Уведомления живых поломок, карточки, задачи, лента событий и всё остальное в
// базе остаются как есть. Перед записью снимается полная резервная копия базы
// (better-sqlite3 backup — корректно и при работающем сервере, база в WAL).
//
// Использование (из каталога server):
//   npx tsx scripts/cleanup-archived-incident-notifications.ts           # сухой прогон
//   npx tsx scripts/cleanup-archived-incident-notifications.ts --apply   # бэкап + удаление
// Другой файл базы — переменной DB_PATH (тот же путь, что у сервера, см.
// src/db.ts). Модуль db.ts здесь намеренно не импортируется: он при импорте
// прогоняет миграции схемы, а разовой уборке это не нужно.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, "..", "taskflow.db");
const BACKUP_DIR = path.join(path.dirname(DB_FILE), "backups");
const apply = process.argv.includes("--apply");

interface Row {
  notification_id: string;
  task_id: string;
  incident_key: string | null;
  title: string;
  archived_at: string | null;
  read: number | null;
  created_at: string;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main(): Promise<void> {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`база не найдена: ${DB_FILE}`);
    process.exit(1);
  }

  console.log(`база: ${DB_FILE}`);
  console.log(`режим: ${apply ? "УДАЛЕНИЕ (--apply)" : "сухой прогон (без изменений)"}`);

  const db = new Database(DB_FILE, { readonly: !apply });
  try {
    // Остатки: уведомление-поломка, чья карточка уже в архиве.
    const leftovers = db
      .prepare(
        `SELECT n.id AS notification_id, n.task_id AS task_id, t.incident_key AS incident_key,
                t.title AS title, t.archived_at AS archived_at, n.read AS read,
                n.created_at AS created_at
           FROM notifications n
           JOIN tasks t ON t.id = n.task_id
          WHERE n.type = 'incident' AND t.archived_at IS NOT NULL
          ORDER BY t.archived_at, n.created_at`,
      )
      .all() as Row[];

    // Уведомление-поломка без карточки (task_id NULL) — тоже легаси, но
    // отдельным случаем: такая запись ни к какой карточке не привязана.
    const orphan = db
      .prepare(
        `SELECT id FROM notifications WHERE type = 'incident' AND task_id IS NULL`,
      )
      .all() as Array<{ id: string }>;

    const live = db
      .prepare(
        `SELECT COUNT(*) AS c FROM notifications n JOIN tasks t ON t.id = n.task_id
          WHERE n.type = 'incident' AND t.archived_at IS NULL`,
      )
      .get() as { c: number };

    console.log(`уведомлений incident у архивных карточек: ${leftovers.length}`);
    console.log(`уведомлений incident без карточки: ${orphan.length}`);
    console.log(`уведомлений incident у живых карточек (не трогаем): ${live.c}`);

    for (const r of leftovers) {
      console.log(
        `  ${r.task_id}  key=${r.incident_key ?? "—"}  архив ${r.archived_at}  уведомление ${r.notification_id}  «${r.title.slice(0, 60)}»`,
      );
    }

    if (!leftovers.length && !orphan.length) {
      console.log("чистить нечего");
      return;
    }
    if (!apply) {
      console.log("для удаления запусти с --apply");
      return;
    }

    // Бэкап до записи: полная копия средствами SQLite, а не cp — при WAL
    // файл базы сам по себе неполон, а backup() даёт согласованный снимок.
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupFile = path.join(BACKUP_DIR, `taskflow.db.backup-pre-incident-cleanup-${stamp()}`);
    await db.backup(backupFile);
    console.log(`бэкап: ${backupFile}`);

    db.pragma("foreign_keys = ON");
    const del = db.prepare("DELETE FROM notifications WHERE id = ?");
    const run = db.transaction((rows: Row[], orphans: Array<{ id: string }>) => {
      let n = 0;
      for (const r of rows) n += del.run(r.notification_id).changes;
      for (const o of orphans) n += del.run(o.id).changes;
      return n;
    });
    const deleted = run(leftovers, orphan);
    console.log(`удалено уведомлений: ${deleted}`);

    const left = db
      .prepare(
        `SELECT COUNT(*) AS c FROM notifications n JOIN tasks t ON t.id = n.task_id
          WHERE n.type = 'incident' AND t.archived_at IS NOT NULL`,
      )
      .get() as { c: number };
    console.log(`проверка после удаления — осталось у архивных карточек: ${left.c}`);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error("ошибка:", e instanceof Error ? e.message : e);
  process.exit(1);
});
