import crypto from "node:crypto";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { roleTitle } from "../roleRouting.js";
import { ensureTaskArtifactFolder } from "./taskArtifactFolder.js";
import { markdownToTiptap } from "./markdownToTiptap.js";
import { noteSearchText } from "./noteSearchText.js";
import { recordTaskDocument } from "./taskOutcome.js";

export { validateRoleReport } from "./roleReportPolicy.js";
export function saveRoleResultReport(subtaskId: string, markdown: string, actorId: string, noteId = "report_" + crypto.randomUUID()): string {
  return db.transaction(() => {
    const step = db.prepare("SELECT s.task_id,s.title,n.role_key FROM subtasks s LEFT JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key WHERE s.id=?").get(subtaskId) as {task_id:string;title:string;role_key:string|null}|undefined;
    if (!step) throw new Error("Этап не найден");
    const title = (step.role_key ? roleTitle(step.role_key) + " — " : "") + step.title + " · отчёт";
    const body = markdown.replace(/^#[ \t]+[^\n]+\n+/, "");
    const content = markdownToTiptap("# " + title + "\n\n" + body);
    db.prepare("INSERT INTO user_notes(id,title,content,folder_id,updated_by,search_text) VALUES(?,?,?,?,?,?)")
      .run(noteId,title,content,ensureTaskArtifactFolder(step.task_id),actorId,noteSearchText(content));
    recordTaskDocument(step.task_id,noteId,actorId);
    logEvent({taskId:step.task_id,actorId,kind:"role_result_report",field:subtaskId,toValue:noteId});
    return noteId;
  })();
}
export function roleResultDocument(subtaskId: string): {id:string;title:string}|null {
  const row = db.prepare("SELECT n.id,n.title FROM task_events e JOIN user_notes n ON n.id=e.to_value WHERE e.kind='role_result_report' AND e.field=? ORDER BY e.rowid DESC LIMIT 1").get(subtaskId) as {id:string;title:string}|undefined;
  return row ?? null;
}
