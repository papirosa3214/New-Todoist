import db from "../db.js";
/** One folder per task; older cards acquire it on their first document write. */
export function ensureTaskArtifactFolder(taskId: string): number {
  return db.transaction(() => {
    const task = db.prepare("SELECT title, project_id, artifact_folder_id FROM tasks WHERE id=?").get(taskId) as {title:string;project_id:string|null;artifact_folder_id:number|null}|undefined;
    if (!task) throw new Error("Задача не найдена");
    if (task.artifact_folder_id && db.prepare("SELECT 1 FROM journal_folders WHERE id=?").get(task.artifact_folder_id)) return task.artifact_folder_id;
    const project = task.project_id ? db.prepare("SELECT notes_folder_id FROM projects WHERE id=?").get(task.project_id) as {notes_folder_id:number|null}|undefined : undefined;
    const id = Number(db.prepare("INSERT INTO journal_folders(parent_id,name,position) VALUES(?,?,0)").run(project?.notes_folder_id ?? null,task.title.slice(0,100)).lastInsertRowid);
    db.prepare("UPDATE tasks SET artifact_folder_id=? WHERE id=?").run(id,taskId);
    return id;
  })();
}
