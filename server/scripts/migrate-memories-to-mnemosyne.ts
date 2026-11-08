// Перенос памяти TaskFlow в банки Mnemosyne (владелец 08.11.2026).
//
// Каждая запись таблицы `memories` (кроме файловых) ложится в свой банк:
//   team → tf-team, role → tf-role-<role_key>, project → tf-project-<id>.
// Длинные уроки режутся на части (Mnemosyne отдаёт из поиска ~400 знаков).
// Связь «локальная запись ↔ части в банке» пишется в memory_mnemo_ids, по ней
// вторая половина работы (чтение) узнаёт, какую строку показывать.
//
// Скрипт можно гонять повторно: строки, у которых уже есть связь,
// пропускаются. Порядок обратный по времени, чтобы свежее попало первым.
//
//   npx tsx scripts/migrate-memories-to-mnemosyne.ts --dry-run
//   npx tsx scripts/migrate-memories-to-mnemosyne.ts
import db from "../src/db.js";
import { writeRecord } from "../src/lib/memoryBanks.js";

interface Row {
  id: string;
  scope: string;
  role_key: string | null;
  project_id: string | null;
  kind: string;
  title: string | null;
  text: string;
  pinned: number;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Number.POSITIVE_INFINITY;

function pending(): Row[] {
  return db
    .prepare(
      `SELECT m.id, m.scope, m.role_key, m.project_id, m.kind, m.title, m.text, m.pinned
         FROM memories m
        WHERE m.kind <> 'file'
          AND NOT EXISTS (SELECT 1 FROM memory_mnemo_ids l WHERE l.memory_id = m.id)
        ORDER BY m.created_at DESC`,
    )
    .all() as Row[];
}

function link(memoryId: string, bank: string, ids: string[]): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO memory_mnemo_ids (memory_id, bank, mnemo_id, chunk_no) VALUES (?, ?, ?, ?)`,
  );
  ids.forEach((mnemoId, i) => stmt.run(memoryId, bank, mnemoId, i));
}

async function main(): Promise<void> {
  const rows = pending();
  const work = rows.slice(0, Number.isFinite(limit) ? limit : rows.length);
  console.log(`всего без переноса: ${rows.length}, берём: ${work.length}, режим: ${dryRun ? "проба" : "запись"}`);
  if (dryRun) {
    const byScope = new Map<string, number>();
    for (const row of work) byScope.set(row.scope, (byScope.get(row.scope) ?? 0) + 1);
    console.log("по областям:", JSON.stringify(Object.fromEntries(byScope)));
    return;
  }

  let done = 0;
  const failed: Array<{ id: string; reason: string }> = [];
  const started = Date.now();
  for (const row of work) {
    try {
      const written = await writeRecord({
        text: row.text,
        title: row.title,
        scope: (row.scope === "role" || row.scope === "project" ? row.scope : "team") as
          | "team"
          | "role"
          | "project",
        roleKey: row.role_key,
        projectId: row.project_id,
        kind: row.kind,
        importance: row.pinned ? 0.9 : 0.6,
        memoryId: row.id,
      });
      link(row.id, written.bank, written.ids);
      done += 1;
    } catch (err) {
      failed.push({ id: row.id, reason: err instanceof Error ? err.message : String(err) });
      if (failed.length <= 3) console.error("не перенесено:", row.id, failed[failed.length - 1].reason);
    }
    if (done % 50 === 0 && done) {
      const speed = done / ((Date.now() - started) / 1000);
      console.log(`перенесено ${done}/${work.length}, ошибок ${failed.length}, ${speed.toFixed(2)} записи/с`);
    }
  }
  const left = pending().length;
  console.log(`ГОТОВО: перенесено ${done}, ошибок ${failed.length}, осталось без переноса ${left}`);
  if (failed.length) console.log("первые ошибки:", JSON.stringify(failed.slice(0, 5)));
}

main().catch((err) => {
  console.error("ОШИБКА:", err instanceof Error ? err.message : err);
  process.exit(1);
});
