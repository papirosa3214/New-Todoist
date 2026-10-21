import db from "../db.js";
import { logEvent } from "../agentState.js";
import { broadcastTaskEvent } from "../ws.js";
import { getFullTask } from "../routes/subtasks.js";

export const MAX_REVIEW_RUNS = 3;
export type ReviewRunTicket = { taskId: string; cycle: string; versionId: string | null; number: number };

export function reviewCycleFor(taskId: string) {
  const version = db.prepare("SELECT id FROM artifact_versions WHERE task_id=? ORDER BY version_no DESC LIMIT 1").get(taskId) as {id:string}|undefined;
  const step = db.prepare(`SELECT s.id FROM subtasks s JOIN task_collaboration_plan_nodes n
    ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
    WHERE s.task_id=? AND s.done=0 AND n.instructions LIKE '[taskflow:final-review]%'
    ORDER BY s.position DESC LIMIT 1`).get(taskId) as {id:string}|undefined;
  return {versionId:version?.id ?? null, cycle:JSON.stringify([version?.id ?? null,step?.id ?? null])};
}

/** Events are the durable budget: new queue jobs and process restarts cannot reset it. */
export function blockReviewRun(taskId: string, reason: string): void {
  const blocked=db.transaction(() => {
    const previous=db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(taskId) as {agent_state:string}|undefined;
    const changed=db.prepare(`UPDATE tasks SET agent_state='blocked',block_type='needs_input',blocked_reason=?,
      blocked_at=datetime('now'),agent_heartbeat_at=NULL,updated_at=datetime('now')
      WHERE id=? AND status='active' AND agent_state IN ('review','in_progress')`).run(reason,taskId).changes;
    if(!changed)return false;
    db.prepare(`UPDATE subtasks SET agent_state='blocked',block_type='needs_input',blocked_at=datetime('now'),
      agent_heartbeat_at=NULL WHERE task_id=? AND done=0 AND EXISTS(
        SELECT 1 FROM task_collaboration_plan_nodes n WHERE n.plan_id=subtasks.collaboration_plan_id
        AND n.slot_key=subtasks.plan_node_key AND n.role_key='critic_verifier'
        AND (n.instructions LIKE '[taskflow:final-review]%' OR subtasks.agent_state='in_progress'))`).run(taskId);
    db.prepare(`UPDATE role_run_jobs SET status='cancelled',last_error=?,finished_at=datetime('now'),
      updated_at=datetime('now') WHERE task_id=? AND status IN ('queued','retry_wait')`).run(reason,taskId);
    logEvent({taskId,actorId:null,kind:"state_changed",field:"agent_state",fromValue:previous?.agent_state ?? null,toValue:"blocked"});
    logEvent({taskId,actorId:null,kind:"review_run_blocked",toValue:reason});
    db.prepare(`INSERT INTO notifications(id,user_id,type,task_id,text,actor_id)
      SELECT lower(hex(randomblob(16))),id,'agent_blocked',?,?,NULL FROM users WHERE role='owner'`).run(taskId,reason);
    return true;
  })();
  if(blocked){
    const task=getFullTask(taskId);
    broadcastTaskEvent([task.creator_id,task.assignee_id],{type:'task:updated',task});
  }
}

export function reserveReviewRun(taskId: string): ReviewRunTicket {
  return db.transaction(() => {
    const task=db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(taskId) as {agent_state:string}|undefined;
    if(task?.agent_state==='blocked')throw new Error("Проверка заблокирована; нужно решение владельца");
    const {cycle,versionId}=reviewCycleFor(taskId);
    const count=(db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND kind='review_run_started' AND field=?").get(taskId,cycle) as {n:number}).n;
    if(count>=MAX_REVIEW_RUNS) {
      // Block outside this transaction: throwing would roll the block back.
      return {taskId,cycle,versionId,number:count+1};
    }
    logEvent({taskId,actorId:null,kind:"review_run_started",field:cycle,toValue:String(count+1)});
    return {taskId,cycle,versionId,number:count+1};
  })();
}

export function assertReviewRunAllowed(ticket: ReviewRunTicket): void {
  if(ticket.number<=MAX_REVIEW_RUNS)return;
  const reason="Проверка заблокирована: 3 захода без вердикта; нужно решение владельца.";
  blockReviewRun(ticket.taskId,reason);
  throw new Error(reason);
}

export function finishReviewRun(ticket: ReviewRunTicket, error?: unknown): void {
  const verdict=ticket.versionId
    ? db.prepare("SELECT 1 FROM reviews WHERE task_id=? AND version_id=?").get(ticket.taskId,ticket.versionId)
    : db.prepare("SELECT 1 FROM reviews WHERE task_id=?").get(ticket.taskId);
  if(verdict)return;
  const reason=error instanceof Error ? error.message : error ? String(error) : "Проверка закончилась без сохранённого вердикта";
  logEvent({taskId:ticket.taskId,actorId:null,kind:"review_run_failed",field:ticket.cycle,toValue:reason.slice(0,1000)});
  if(ticket.number>=MAX_REVIEW_RUNS && reviewCycleFor(ticket.taskId).cycle===ticket.cycle)blockReviewRun(ticket.taskId,`Проверка заблокирована: 3 неудачных захода. ${reason.slice(0,700)}. Нужно решение владельца.`);
  throw new Error(reason);
}

export function reviewBudgetExhausted(taskId:string): boolean {
  const {cycle,versionId}=reviewCycleFor(taskId);
  if(versionId && db.prepare("SELECT 1 FROM reviews WHERE version_id=?").get(versionId))return false;
  return (db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND kind='review_run_started' AND field=?").get(taskId,cycle) as {n:number}).n>=MAX_REVIEW_RUNS;
}
