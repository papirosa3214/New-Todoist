import betterSqlite3 from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const db = betterSqlite3(':memory:');
db.pragma('foreign_keys = ON');

// Воссоздаём минимальный DDL task_collaboration_plans по образцу server/src/migrations.ts (стр. ~170)
db.exec(`
  CREATE TABLE task_collaboration_plans (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    profile TEXT NOT NULL CHECK (profile IN ('single_executor','research','delivery','full_cycle','manual','product_feature')),
    rationale TEXT NOT NULL DEFAULT '',
    context_version INTEGER,
    created_by TEXT NOT NULL,
    approved_by TEXT,
    approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_task_collaboration_plans_task ON task_collaboration_plans(task_id, revision DESC);
`);

console.log('Исходный DDL:');
console.log(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_collaboration_plans'").get().sql);

// Вставляем строку с product_feature
db.prepare(`INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,context_version,created_by) VALUES ('p1','t1',1,'draft','product_feature','test',1,'ops')`).run();

// Копия тела addBugRegressionProfile
function addBugRegressionProfile() {
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_collaboration_plans'").get().sql ?? '';
  if (!ddl || ddl.includes("'bug_regression'")) return 'noop (already applied)';
  const newDdl = ddl
    .replace(/CHECK\s*\(\s*profile\s+IN\s*\(([^)]*)\)\s*\)/i, (_m, list) => `CHECK (profile IN (${list},'bug_regression'))`)
    .replace(/CREATE TABLE\s+"?task_collaboration_plans"?/i, 'CREATE TABLE "task_collaboration_plans_new"');
  if (newDdl === ddl || !newDdl.includes('CREATE TABLE "task_collaboration_plans_new"') || !newDdl.includes("'bug_regression'")) {
    throw new Error('regex mismatch');
  }
  db.pragma('foreign_keys = OFF');
  try {
    const rebuild = db.transaction(() => {
      db.exec(newDdl);
      db.exec('INSERT INTO "task_collaboration_plans_new" SELECT * FROM task_collaboration_plans');
      db.exec('DROP TABLE task_collaboration_plans');
      db.exec('ALTER TABLE "task_collaboration_plans_new" RENAME TO task_collaboration_plans');
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_collaboration_plans_task ON task_collaboration_plans(task_id, revision DESC)');
    });
    rebuild();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return 'migrated';
}

console.log('Прогон 1:', addBugRegressionProfile());
console.log('DDL после 1:');
console.log(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_collaboration_plans'").get().sql);
console.log('Прогон 2:', addBugRegressionProfile());
console.log('Вставка bug_regression:', (() => {
  try {
    db.prepare(`INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,context_version,created_by) VALUES ('p2','t1',2,'draft','bug_regression','t',1,'ops')`).run();
    return 'ok';
  } catch (e) { return 'FAIL ' + e.message; }
})());
console.log('Защита CHECK всё ещё работает:', (() => {
  try {
    db.prepare(`INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,context_version,created_by) VALUES ('p3','t1',3,'draft','whatever','t',1,'ops')`).run();
    return 'NO — CHECK не отбивает';
  } catch (e) { return 'ok (' + e.code + ')'; }
})());
console.log('Строка product_feature жива:', db.prepare("SELECT count(*) c FROM task_collaboration_plans WHERE profile='product_feature'").get().c);
console.log('Строка bug_regression жива:', db.prepare("SELECT count(*) c FROM task_collaboration_plans WHERE profile='bug_regression'").get().c);
