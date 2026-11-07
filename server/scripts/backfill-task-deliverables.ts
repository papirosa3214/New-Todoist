// Разовый перенос (05.11.2026): уже сданным карточкам — их документы результата
// и новые названия отчётов. Повторный запуск ничего не меняет.
// Запуск из server/: npx tsx scripts/backfill-task-deliverables.ts [--dry-run]
import db from "../src/db.js";
import { importTaskDeliverables } from "../src/lib/taskDeliverables.js";
import { noteSearchText } from "../src/lib/noteSearchText.js";
import { roleReportTitle } from "../src/lib/roleResultReport.js";

const dryRun = process.argv.includes("--dry-run");
const reports = db.prepare(
  `SELECT n.id, n.title, n.content, s.title AS step_title, p.role_key
     FROM task_events e
     JOIN user_notes n ON n.id = e.to_value
     JOIN subtasks s ON s.id = e.field
     LEFT JOIN task_collaboration_plan_nodes p ON p.plan_id = s.collaboration_plan_id AND p.slot_key = s.plan_node_key
    WHERE e.kind = 'role_result_report' AND n.title LIKE '% · отчёт'`,
).all() as Array<{ id: string; title: string; content: string | null; step_title: string; role_key: string | null }>;

let renamed = 0;
const update = db.prepare("UPDATE user_notes SET title = ?, content = ?, search_text = ? WHERE id = ?");
for (const report of reports) {
  const title = roleReportTitle(report.role_key, report.step_title);
  const escape = (text: string) => JSON.stringify(text).slice(1, -1);
  const content = (report.content ?? "").replace(escape(report.title), escape(title));
  if (!dryRun) update.run(title, content, noteSearchText(content), report.id);
  renamed += 1;
}

const tasks = db.prepare("SELECT DISTINCT task_id FROM task_events WHERE kind = 'role_result_report'").all() as Array<{ task_id: string }>;
let imported = 0;
let failed = 0;
for (const { task_id } of tasks) {
  if (dryRun) continue;
  try {
    const notes = importTaskDeliverables(task_id, null);
    imported += notes.length;
    if (notes.length) console.log(`${task_id.slice(0, 8)}: документов ${notes.length}`);
  } catch (error) {
    failed += 1;
    console.warn(`${task_id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(JSON.stringify({ dryRun, reportsRenamed: renamed, tasks: tasks.length, documentsImported: imported, failed }));
