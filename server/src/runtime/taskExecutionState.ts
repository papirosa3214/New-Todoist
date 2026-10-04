import {branchRoot,branchCards} from "./branchPlan.js";
import db from "../db.js";
import { activeInProcessRun } from "./inProcessRun.js";

/** Read only: queue is the durable source of launch acceptance and failure. */
export function taskExecutionState(taskId: string) {
  const rootId=branchRoot(taskId), isChild=rootId!==taskId, isBranchRoot=!isChild && branchCards(taskId).length>1;
  const task = db.prepare("SELECT agent_state, status FROM tasks WHERE id=?").get(taskId) as {agent_state: string | null; status: string} | undefined;
  const job = db.prepare(`SELECT status,last_error,manual_start FROM role_run_jobs WHERE task_id=?
    ORDER BY CASE WHEN status IN ('queued','running','retry_wait') THEN 0 ELSE 1 END, rowid DESC LIMIT 1`).get(taskId) as {status:string;last_error:string|null;manual_start:number} | undefined;
  const single = Boolean(db.prepare("SELECT 1 FROM role_run_jobs WHERE task_id=? AND manual_start=1 LIMIT 1").get(taskId));
  const team = Boolean(db.prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id=? AND status IN ('approved','running','completed') LIMIT 1").get(taskId));
  const active = Boolean(activeInProcessRun(taskId));
  const busy = active || Boolean(job && ['queued','running','retry_wait'].includes(job.status)) || task?.agent_state === 'in_progress';
  let status = 'idle';
  if (active || job?.status === 'running') status = 'running';
  else if (job?.status === 'queued') status = 'queued';
  else if (job?.status === 'retry_wait') status = 'retry_wait';
  else if (task?.agent_state) status = task.agent_state;
  else if (job?.status === 'dead' || job?.status === 'skipped') status = 'failed';
  else if (single) status = 'finished';
  const canRetry = status === 'failed';
  return {status, busy, scheme: single ? 'single' : team ? 'team' : null,
    branch_root_task_id:isChild ? rootId : null,
    can_launch: !isBranchRoot && !isChild && !busy && !team && !task?.agent_state && (!single || canRetry) && task?.status === 'active',
    can_change_executor: !isBranchRoot && !isChild && !busy && !single && !team,
    can_use_plan: !isChild && !busy && !single,
    error: canRetry ? job?.last_error ?? 'Запуск завершён без начала работы. Проверьте назначение исполнителя.' : null};
}
