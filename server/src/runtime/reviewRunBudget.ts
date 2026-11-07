import { isOwner } from "../access.js";
import { createHash } from "node:crypto";
import { tiptapToPlainText } from "../lib/tiptapPlaintext.js";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { broadcastTaskEvent } from "../ws.js";
import { getFullTask } from "../routes/subtasks.js";

export const MAX_REVIEW_RUNS = 3;
export type ReviewRunTicket = { taskId: string; cycle: string; versionId: string | null; number: number; beforeOutputs: string[]; denied?: string };

export function reviewCycleFor(taskId: string) {
  const version = db.prepare("SELECT id FROM artifact_versions WHERE task_id=? ORDER BY version_no DESC LIMIT 1").get(taskId) as {id:string}|undefined;
  const step = db.prepare(`SELECT s.id FROM subtasks s JOIN task_collaboration_plan_nodes n
    ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
    WHERE s.task_id=? AND s.done=0 AND n.instructions LIKE '[taskflow:final-review]%'
    ORDER BY s.position DESC LIMIT 1`).get(taskId) as {id:string}|undefined;
  return {versionId:version?.id ?? null, stepId:step?.id ?? null, cycle:JSON.stringify([version?.id ?? null,step?.id ?? null])};
}

/** Saved output contents, not heartbeats, comments or read-only tools.
 * Existing document, step result and artifact formats remain valid. */
function reviewOutputs(taskId: string): string[] {
  const actor="role_critic_verifier";
  const outputs: string[]=[];
  const add=(kind:string,body:string) => {
    const text=body.trim();
    if(text)outputs.push(createHash("sha256").update(kind+"\\0"+text).digest("hex"));
  };
  const docs=db.prepare("SELECT DISTINCT n.content FROM task_events e JOIN user_notes n ON n.id=e.field WHERE e.task_id=? AND e.kind='doc_written' AND (n.updated_by=? OR (n.updated_by IS NULL AND e.actor_id=?))").all(taskId,actor,actor) as {content:string}[];
  for(const doc of docs){
    try {add("document",tiptapToPlainText(JSON.parse(doc.content)));}catch {/* malformed documents are not proof */}
  }
  const results=db.prepare("SELECT result FROM subtasks WHERE task_id=? AND agent_id=? AND trim(COALESCE(result,''))<>''").all(taskId,actor) as {result:string}[];
  for(const result of results)add("result",result.result);
  const artifacts=db.prepare("SELECT a.summary,a.payload_json,a.evidence_json FROM subtask_artifact_versions a JOIN subtasks s ON s.id=a.subtask_id WHERE s.task_id=? AND a.created_by=? AND a.status IN ('submitted','accepted')").all(taskId,actor) as {summary:string;payload_json:string;evidence_json:string}[];
  for(const a of artifacts)add("artifact",JSON.stringify([a.summary,a.payload_json,a.evidence_json]));
  return [...new Set(outputs)].sort();
}
function hasNewOutput(before:string[],after:string[]):boolean {
  return after.some(hash=>!before.includes(hash));
}
function budgetState(taskId:string) {
  const {cycle,versionId}=reviewCycleFor(taskId);
  const rows=db.prepare("SELECT rowid,to_value FROM task_events WHERE task_id=? AND kind='review_run_started' AND field=? ORDER BY rowid").all(taskId,cycle) as {rowid:number;to_value:string}[];
  // Заходы, сорванные перезапуском сервера, в бюджет не идут: перезапуск —
  // не вина роли (см. voidReviewRunAfterRestart).
  const voided=new Set((db.prepare("SELECT to_value FROM task_events WHERE task_id=? AND kind='review_run_voided' AND field=?").all(taskId,cycle) as {to_value:string}[]).map(r=>r.to_value));
  let previous:string[]|null=null;
  let count=0;
  for(const row of rows){
    if(voided.has(String(row.rowid)))continue;
    count++;
    try {
      const value=JSON.parse(row.to_value);
      if(Array.isArray(value?.outputs))previous=value.outputs;
    }catch {/* old starts have no evidence snapshot */}
  }
  return {cycle,versionId,count,previous};
}
/** Освободить номер захода проверки, сорванного перезапуском сервера.
 *  31.10.2026: деплой рвал ход критика посреди проверки. Вердикта заход не
 *  оставил, но бюджет проверки его засчитывал, и следующий заход упирался в
 *  «Повтор проверки запрещён… нужно решение владельца» — шаг умирал, владельцу
 *  приходилось решать за роли. Освобождаем только этот заход; остальные в
 *  бюджете остаются, и три захода без вердикта по-прежнему блокируют. */
export function voidReviewRunAfterRestart(taskId:string, subtaskId:string):boolean {
  const {cycle,stepId}=reviewCycleFor(taskId);
  if(!stepId||stepId!==subtaskId)return false;
  const last=db.prepare("SELECT rowid FROM task_events WHERE task_id=? AND kind='review_run_started' AND field=? ORDER BY rowid DESC LIMIT 1").get(taskId,cycle) as {rowid:number}|undefined;
  if(!last)return false;
  const already=db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='review_run_voided' AND field=? AND to_value=?").get(taskId,cycle,String(last.rowid));
  if(already)return false;
  logEvent({taskId,actorId:null,kind:"review_run_voided",field:cycle,toValue:String(last.rowid)});
  return true;
}
export function reviewRepeatBlockReason(taskId:string):string|null {
  const state=budgetState(taskId);
  if(state.versionId && db.prepare("SELECT 1 FROM reviews WHERE version_id=?").get(state.versionId))return null;
  if(state.count>=MAX_REVIEW_RUNS)return "Проверка заблокирована: 3 захода без вердикта; нужно решение владельца.";
  if(state.count && (state.previous===null || !hasNewOutput(state.previous,reviewOutputs(taskId))))
    return "Повтор проверки запрещён: предыдущий заход не оставил нового сохранённого результата. Нужно решение владельца.";
  return null;
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

export function reserveReviewRun(taskId: string, ownerStartActorId?:string): ReviewRunTicket {
  const manual=Boolean(ownerStartActorId && isOwner(ownerStartActorId));
  return db.transaction(() => {
    const task=db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(taskId) as {agent_state:string}|undefined;
    if(!manual && task?.agent_state==='blocked')throw new Error("Проверка заблокирована; нужно решение владельца");
    const {cycle,versionId,count}=budgetState(taskId);
    const beforeOutputs=reviewOutputs(taskId);
    const denied=manual ? undefined : reviewRepeatBlockReason(taskId) ?? undefined;
    const ticket={taskId,cycle,versionId,number:count+1,beforeOutputs,denied};
    // Block outside the transaction: throwing here would undo the block.
    if(!denied)logEvent({taskId,actorId:null,kind:"review_run_started",field:cycle,toValue:JSON.stringify({number:ticket.number,outputs:beforeOutputs})});
    return ticket;
  })();
}

export function assertReviewRunAllowed(ticket: ReviewRunTicket): void {
  if(!ticket.denied)return;
  blockReviewRun(ticket.taskId,ticket.denied);
  throw new Error(ticket.denied);
}

export function finishReviewRun(ticket: ReviewRunTicket, error?: unknown): void {
  const verdict=ticket.versionId
    ? db.prepare("SELECT 1 FROM reviews WHERE task_id=? AND version_id=?").get(ticket.taskId,ticket.versionId)
    : db.prepare("SELECT 1 FROM reviews WHERE task_id=?").get(ticket.taskId);
  if(verdict)return;
  const reason=error instanceof Error ? error.message : error ? String(error) : "Проверка закончилась без сохранённого вердикта";
  logEvent({taskId:ticket.taskId,actorId:null,kind:"review_run_failed",field:ticket.cycle,toValue:reason.slice(0,1000)});
  const progressed=hasNewOutput(ticket.beforeOutputs,reviewOutputs(ticket.taskId));
  if((!progressed || ticket.number>=MAX_REVIEW_RUNS) && reviewCycleFor(ticket.taskId).cycle===ticket.cycle) {
    const why=progressed ? "3 неудачных захода" : "заход не оставил нового сохранённого результата; автоматический повтор запрещён";
    blockReviewRun(ticket.taskId,"Проверка заблокирована: "+why+". "+reason.slice(0,700)+". Нужно решение владельца.");
  }
  throw new Error(reason);
}

export function reviewBudgetExhausted(taskId:string): boolean {
  return reviewRepeatBlockReason(taskId)!==null;
}
