import { branchMembership } from "./branchPlan.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import db from "../db.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const tails=new Map<string,Promise<void>>();
/** Work and discussion share one writer, including preparation before activeRuns registration. */
export async function acquireSlotSession(subtaskId:string,signal?:AbortSignal):Promise<()=>void> {
  const previous=tails.get(subtaskId) ?? Promise.resolve();
  let releaseGate!:()=>void;
  const next=new Promise<void>(resolve=>{releaseGate=resolve;});
  tails.set(subtaskId,next);
  let released=false;
  const release=()=>{if(released)return;released=true;releaseGate();if(tails.get(subtaskId)===next)tails.delete(subtaskId);};
  let abort=()=>{};
  try {
    await new Promise<void>((resolve,reject)=>{
      abort=()=>reject(signal?.reason ?? new Error("Сессия отменена"));
      if(signal?.aborted){abort();return;}
      signal?.addEventListener("abort",abort,{once:true});
      void previous.then(resolve);
    });
  } catch(error){void previous.then(release);throw error;}
  finally{signal?.removeEventListener("abort",abort);}
  return release;
}
export function slotSessionDirectory(taskId:string,role:string,subtaskId:string):string {
  const root=process.env.TASKFLOW_RUNS_DIR || path.join(os.homedir(),".local","state","taskflow-runs");
  return path.join(root,"sessions",`${taskId}-${role}-${subtaskId}`);
}
/** Adopt the original work file, regardless of its cwd; never fork to a chat session. */
export function openSlotSession(taskId:string,role:string,subtaskId:string,fallbackCwd:string):SessionManager {
  const dir=slotSessionDirectory(taskId,role,subtaskId);
  fs.mkdirSync(dir,{recursive:true});
  const saved=db.prepare("SELECT session_file FROM slot_sessions WHERE subtask_id=?").get(subtaskId) as {session_file:string}|undefined;
  const candidates=fs.readdirSync(dir).filter(name=>name.endsWith(".jsonl")).map(name=>path.join(dir,name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  const file=saved && path.dirname(saved.session_file)===dir && fs.existsSync(saved.session_file) ? saved.session_file : candidates[0];
  const manager=file ? SessionManager.open(file,dir) : SessionManager.create(fallbackCwd,dir);
  rememberSlotSession(subtaskId,manager);
  return manager;
}
export function rememberSlotSession(subtaskId:string,manager:SessionManager):void {
  const file=manager.getSessionFile();
  if(!file)return;
  // finally в runRoleInProcess может сработать после удаления субтаска
  // (тестовая уборка, ручной DELETE из админки). FK CASCADE не спасёт
  // INSERT — субтаска уже нет. Проглатываем код SQLITE_CONSTRAINT_FOREIGNKEY,
  // остальные ошибки пробрасываем: упавший апдейт — это уже потеря данных.
  try {
    db.prepare("INSERT INTO slot_sessions(subtask_id,session_file,cwd,session_id) VALUES(?,?,?,?) ON CONFLICT(subtask_id) DO UPDATE SET session_file=excluded.session_file,cwd=excluded.cwd,session_id=excluded.session_id,updated_at=datetime('now')").run(subtaskId,file,manager.getCwd(),manager.getSessionId());
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") return;
    throw error;
  }
}
export type TopicSlot={id:string;task_id:string;title:string;plan_node_key:string;agent_state:string|null;done:number};
export function topicSlots(taskId:string,role:string):TopicSlot[] {
  return db.prepare("SELECT s.id,s.task_id,s.title,s.plan_node_key,s.agent_state,s.done FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key JOIN task_collaboration_plans p ON p.id=n.plan_id WHERE s.task_id=? AND p.status='approved' AND n.role_key=? AND n.skipped_at IS NULL ORDER BY s.position,s.rowid").all(taskId,role) as TopicSlot[];
}
export function resolveTopicSlot(taskId:string,role:string,key?:string,recipientId?:string):TopicSlot|null {
  const rows=topicSlots(taskId,role);
  if(recipientId){
    const local=rows.find(row=>row.id===recipientId);if(local)return local;
    const other=db.prepare("SELECT task_id FROM subtasks WHERE id=?").get(recipientId) as {task_id:string}|undefined;
    const branch=branchMembership(taskId);
    return other && branch && branchMembership(other.task_id)?.root_plan_id===branch.root_plan_id ? topicSlots(other.task_id,role).find(row=>row.id===recipientId) ?? null : null;
  }
  if(key)return rows.find(row=>row.plan_node_key===key || row.title===key) ?? null;
  return rows.length===1 ? rows[0] : null;
}
