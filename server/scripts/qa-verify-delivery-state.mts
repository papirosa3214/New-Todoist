// Вспомогательный скрипт для проверки применения миграции и схемы.
// Запускать: npx tsx scripts/qa-verify-delivery-state.mts /tmp/qa-copy.db
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";

const target = process.argv[2] || process.env.DB_PATH;
if (target) process.env.DB_PATH = target;

migrate();
runMigrations();

const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{
  name: string;
}>;
const has = cols.find((c) => c.name === "delivery_state");
console.log(
  has
    ? `OK: chat_messages.delivery_state=${has.name} present`
    : "FAIL: delivery_state отсутствует",
);
const sm = db
  .prepare("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 5")
  .all() as Array<{ id: string }>;
console.log("последние миграции:", sm.map((r) => r.id).join(", "));
