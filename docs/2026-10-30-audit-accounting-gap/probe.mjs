// Проверка сторожа учёта отказов на КОПИИ базы (живая база не трогается).
// 1) здоровый прибор: проба пишет строку и счётчик → ok=true
// 2) сломанный прибор: триггер RAISE(ABORT) на role_tool_audit → ok=false + тревога
process.env.DB_PATH = "/tmp/audit_probe_test.db";
process.env.TASKFLOW_QA_SANDBOX = "1";

const SERVER = "/home/maksim/Проекты/New-Todoist/server";
const Database = (await import(`${SERVER}/node_modules/better-sqlite3/lib/index.js`)).default;

const mod = await import(`${SERVER}/dist/runtime/toolErrorAccountingWatcher.js`);
const { checkToolErrorAccounting, alertToolErrorAccounting } = mod;

const db = new Database("/tmp/audit_probe_test.db");
db.pragma("journal_mode = WAL");

function counts() {
  const rows = db
    .prepare(
      `SELECT COUNT(*) AS n FROM role_tool_audit WHERE role='tool_audit_watch_probe'`,
    )
    .get();
  const c = db
    .prepare(
      `SELECT COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(errors),0) AS errors
         FROM role_tool_audit_counters WHERE role='tool_audit_watch_probe'`,
    )
    .get();
  return { probeRows: rows.n, probeCalls: c.calls, probeErrors: c.errors };
}

console.log("=== 1. здоровый прибор ===");
const before = counts();
const r1 = await checkToolErrorAccounting();
const after = counts();
console.log("ok:", r1.ok);
console.log("problems:", JSON.stringify(r1.problems));
console.log("probes:", JSON.stringify(r1.probes));
console.log("следы пробы до:", JSON.stringify(before));
console.log("следы пробы после (до уборки сторожа — их уже чистит сам сторож):", JSON.stringify(after));

console.log("\n=== 2. сломанный прибор (триггер RAISE ABORT на role_tool_audit) ===");
db.exec(
  `CREATE TRIGGER IF NOT EXISTS probe_break_audit BEFORE INSERT ON role_tool_audit
     BEGIN SELECT RAISE(ABORT, 'тест: запись отказа запрещена'); END;`,
);
const r2 = await checkToolErrorAccounting();
console.log("ok:", r2.ok);
console.log("problems:", JSON.stringify(r2.problems));
console.log("faults:", JSON.stringify(r2.faults));

console.log("\n=== 3. тревога при поломке ===");
const owners = db
  .prepare("SELECT id FROM users WHERE role='owner' LIMIT 3")
  .all();
console.log("получателей тревоги в копии:", owners.length);
const written = alertToolErrorAccounting(r2.faults);
console.log("тревога записана:", written);
const notif = db
  .prepare(
    `SELECT type, substr(text,1,260) AS text FROM notifications
      WHERE type='tool_error_accounting_watch' ORDER BY created_at DESC LIMIT 2`,
  )
  .all();
console.log("уведомление в копии:", JSON.stringify(notif, null, 1));

db.exec("DROP TRIGGER IF EXISTS probe_break_audit");
console.log("\nготово");
process.exit(0);
