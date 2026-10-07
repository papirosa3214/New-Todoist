import db from "../db.js";

export const SUBMISSION_POLICY = "Сдавай результат только через taskflow_subtask_done основного TaskFlow. QA-копия служит для проверки продукта и не принимает сдачу рабочих этапов. Завершай работу только после confirmed=true в серверной submission_receipt; слова агента и HTTP-успех другой системы не подтверждают сдачу. При ошибке подтверждения сохрани результат и сообщи: сдача не подтверждена.";
export function sandboxSubmissionError() {
 return process.env.TASKFLOW_QA_SANDBOX === "1" ? {code:"sandbox_submission_forbidden",error:"Это тестовая QA-копия. Сдача этапа здесь запрещена; используй taskflow_subtask_done основного TaskFlow."} : null;
}
export function submissionReceipt(subtaskId:string) {
 const authority=process.env.TASKFLOW_QA_SANDBOX === "1" ? "sandbox" : "primary";
 const step=db.prepare("SELECT task_id,done FROM subtasks WHERE id=?").get(subtaskId) as any;
 const artifact=db.prepare("SELECT id,note_id,created_at,status FROM subtask_artifact_versions WHERE subtask_id=? ORDER BY version_no DESC LIMIT 1").get(subtaskId) as any;
 const report=db.prepare("SELECT e.to_value AS id,e.created_at FROM task_events e JOIN user_notes n ON n.id=e.to_value WHERE e.kind='role_result_report' AND e.field=? ORDER BY e.rowid DESC LIMIT 1").get(subtaskId) as any;
 const closed=db.prepare("SELECT created_at FROM task_events WHERE kind='subtask_submission_confirmed' AND field=? ORDER BY rowid DESC LIMIT 1").get(subtaskId) as any;
 const persisted=artifact ? ["submitted","accepted"].includes(artifact.status) : Boolean(report || closed);
 const confirmed=authority==="primary" && Boolean(step?.done && persisted);
 return {confirmed,authority,task_id:step?.task_id??null,subtask_id:subtaskId,artifact_id:confirmed ? artifact?.id??null : null,document_id:confirmed ? artifact?.note_id??report?.id??null : null,confirmed_at:confirmed ? artifact?.created_at??report?.created_at??closed?.created_at??null : null};
}
export function requireSubmissionReceipt(receipt:any,subtaskId:string,artifactId?:string) {
 if(!receipt?.confirmed || receipt.authority!=="primary" || receipt.subtask_id!==subtaskId || !receipt.confirmed_at || (artifactId && receipt.artifact_id!==artifactId)) throw new Error("Сдача не подтверждена основным TaskFlow. Сохрани результат и проверь состояние этапа; не сообщай, что работа сдана.");
 return receipt;
}
