import db from "../db.js";
import { isOwner } from "../access.js";
import { logEvent } from "../agentState.js";

/** Only an explicit owner entrypoint may recover execution state. */
export async function prepareOwnerManualRun(taskId: string, actorId: string, subtaskId?: string): Promise<void> {
  if (!isOwner(actorId)) throw new Error("Ручной обход ограничений — только владелец");
  const {interruptOwnerRun}=await import("./inProcessRun.js");
  await interruptOwnerRun(taskId, subtaskId);
  db.transaction(() => {
    db.prepare("UPDATE role_run_jobs SET status='cancelled',finished_at=datetime('now'),lease_owner=NULL,lease_expires_at=NULL,last_error='Новый ручной запуск владельца' WHERE task_id=? AND status IN ('queued','retry_wait','running')").run(taskId);
    db.prepare("UPDATE attempts SET ended_at=datetime('now'),outcome='interrupted',reason='Новый ручной запуск владельца' WHERE task_id=? AND ended_at IS NULL AND (? IS NULL OR subtask_id=?)").run(taskId,subtaskId??null,subtaskId??null);
    db.prepare("UPDATE tasks SET status='active',completed_at=NULL,archived_at=NULL,agent_state=NULL,block_type=NULL,blocked_reason=NULL,blocked_at=NULL,current_attempt_id=NULL,agent_heartbeat_at=NULL,updated_at=datetime('now') WHERE id=?").run(taskId);
    if(subtaskId) {
      db.prepare("UPDATE subtasks SET done=0,agent_state=NULL,block_type=NULL,blocked_at=NULL,current_attempt_id=NULL,agent_heartbeat_at=NULL WHERE id=? AND task_id=?").run(subtaskId,taskId);
      db.prepare("UPDATE task_collaboration_plan_nodes SET skipped_at=NULL,skip_reason=NULL WHERE plan_id=(SELECT collaboration_plan_id FROM subtasks WHERE id=?) AND slot_key=(SELECT plan_node_key FROM subtasks WHERE id=?)").run(subtaskId,subtaskId);
      db.prepare("UPDATE task_collaboration_plans SET status='approved' WHERE id=(SELECT collaboration_plan_id FROM subtasks WHERE id=?)").run(subtaskId);
    }
    logEvent({taskId,actorId,kind:"owner_manual_run",field:subtaskId??null,toValue:"explicit"});
  })();
}
