// Проверка ротации против работающего сервера на копии.
// Подкладывает 200-дневную запись в server_events, вызывает prune через
// тот же модуль, что и планировщик, и проверяет, что запись удалилась.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const requireFromHere = createRequire(
  path.join(__dirname, "package.json") + "?probe",
);

const ROOT = path.resolve(__dirname, "..");
const db = requireFromHere(pathToFileURL(path.join(ROOT, "src", "db.ts")).pathname);
const se = requireFromHere(pathToFileURL(path.join(ROOT, "src", "lib", "serverEvents.ts")).pathname);

let ok = true;
const fail = (m: string) => { console.log("FAIL:", m); ok = false; };
const pass = (m: string) => console.log("PASS:", m);

function insertEvent(ageDays: number, kind: string, message: string) {
  const id = `live-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const past = new Date(Date.now() - ageDays * 24 * 3600_000).toISOString();
  db.default
    .prepare(
      `INSERT INTO server_events
         (id, scope, kind, message, created_at, outcome)
       VALUES (?, 'system', ?, ?, ?, 'ok')`,
    )
    .run(id, kind, message, past);
  return id;
}

function count() {
  const r = db.default.prepare("SELECT COUNT(*) AS n FROM server_events").get() as { n: number };
  return Number(r.n ?? 0);
}

const before = count();
console.log("Было строк в таблице:", before);

const old = insertEvent(200, "process_boot", "200-day-old event with secret api_key=ABCDEFGHIJ12345");
const fresh = insertEvent(0, "process_boot", "fresh event with no secrets");
console.log("Подложено: 200d=" + old + ", 0d=" + fresh);
console.log("Стало строк:", count());

// Это тот же вызов, который делает планировщик
const res = se.pruneServerEvents();
console.log(
  "pruneServerEvents: removed=" + res.removed +
  " remaining=" + res.remaining +
  " retentionDays=" + res.retentionDays +
  " threshold=" + res.threshold,
);

if (res.removed < 1) {
  fail("Ожидал удалить как минимум 1 (200-дневную), removed=" + res.removed);
} else {
  pass("Удалено " + res.removed + " строк (включая 200-дневную)");
}

const left = db.default
  .prepare("SELECT id, kind, message, created_at FROM server_events ORDER BY created_at ASC")
  .all() as { id: string; kind: string; message: string; created_at: string }[];

const oldStill = left.find((r) => r.id === old);
const freshStill = left.find((r) => r.id === fresh);

if (oldStill) {
  fail("200-дневная запись осталась в таблице: " + JSON.stringify(oldStill));
} else {
  pass("200-дневная запись удалена из таблицы");
}

if (!freshStill) {
  fail("Свежая запись исчезла — ротация удалила лишнее");
} else {
  pass("Свежая запись осталась (created_at=" + freshStill.created_at + ")");
}

console.log("==Итог: " + (ok ? "OK" : "FAIL") + "==");
process.exit(ok ? 0 : 1);
