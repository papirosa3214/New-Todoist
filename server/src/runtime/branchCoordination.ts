import db from "../db.js";
import {isOrchestrator} from "../access.js";
import {roleUserId} from "../roleRouting.js";
import {listActiveInProcessRuns} from "./inProcessRun.js";

/** Координация корня до допуска плана не занимает рабочий узел графа. */
export function hasOnlyBranchCoordination(taskId:string):boolean {
 const task=db.prepare("SELECT parent_id,assignee_id,agent_state,status FROM tasks WHERE id=?").get(taskId) as {parent_id:string|null;assignee_id:string|null;agent_state:string|null;status:string}|undefined;
 if(!task || task.parent_id || task.status!=="active" || !task.assignee_id || !isOrchestrator(task.assignee_id))return false;
 if(task.agent_state && task.agent_state!=="in_progress")return false;
 if(!db.prepare("SELECT 1 FROM tasks WHERE parent_id=?").get(taskId))return false;
 if(!db.prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id=? AND status='draft'").get(taskId))return false;
 if(db.prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id=? AND status='approved'").get(taskId))return false;
 // Ни один реально работающий исполнитель не подпадает под исключение.
 if(db.prepare("SELECT 1 FROM subtasks WHERE task_id=? AND done=0 AND (agent_state='in_progress' OR current_attempt_id IS NOT NULL)").get(taskId))return false;
 if(db.prepare("SELECT 1 FROM attempts WHERE task_id=? AND subtask_id IS NOT NULL AND ended_at IS NULL").get(taskId))return false;
 const runs=listActiveInProcessRuns().filter(r=>r.taskId===taskId);
 if(runs.some(r=>r.subtaskId || !isOrchestrator(roleUserId(r.role))))return false;
 const jobs=db.prepare("SELECT reason FROM role_run_jobs WHERE task_id=? AND status IN ('queued','running','retry_wait')").all(taskId) as {reason:string}[];
 return jobs.every(j=>j.reason==="commented" || j.reason==="assigned");
}

