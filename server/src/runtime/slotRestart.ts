import db from "../db.js";
import { activeInProcessRun, asControlActor } from "./inProcessRun.js";
import { acquireSlotSession } from "./slotSession.js";
import { startPlanSubtaskRun } from "./planSubtaskAdmission.js";
import { technicalSlotSnapshot } from "./slotWorkSnapshot.js";
import { logEvent } from "../agentState.js";
import { isOwner, isOrchestrator } from "../access.js";

const replacing = new Set<string>();
export async function restartOccupiedSlot(id: string, role: string, actor: string, reason: string) {
  if (replacing.has(id)) throw new Error("Замена этого слота уже выполняется");
  replacing.add(id);
  try {
    const row = db.prepare(`SELECT s.*, n.role_key, n.skipped_at, t.status AS task_status, p.status AS plan_status
      FROM subtasks s JOIN task_collaboration_plan_nodes n
      ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
      JOIN tasks t ON t.id=s.task_id JOIN task_collaboration_plans p ON p.id=n.plan_id WHERE s.id=?`).get(id) as any;
    const task = row && db.prepare("SELECT * FROM tasks WHERE id=?").get(row.task_id) as any;
    if (!row || row.done || row.skipped_at || row.task_status !== "active" || row.plan_status !== "approved" || task.archived_at) throw new Error("Нужен незавершённый рабочий слот активной задачи");
    if (row.role_key !== role) throw new Error("Заменить исполнителя можно только той же ролью");
    const run = activeInProcessRun(row.task_id, id) ?? (role === "critic_verifier" ? activeInProcessRun(row.task_id, undefined) : undefined);
    if (run) {
      if (!run.completion) throw new Error("Запуск ещё подготавливается; повторите после его старта");
      run.replacementRequested = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => { await run.abort(); await run.completion!.catch(() => {}); })(),
          new Promise<never>((_, reject) => { timer=setTimeout(() => reject(new Error("Текущая попытка ещё не остановилась; новая не запущена")), 15000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    }
    const controller = new AbortController();
    const waiting = setTimeout(() => controller.abort(new Error("Сессия слота занята; новая попытка не запущена")), 15000);
    let release: () => void;
    try { release = await acquireSlotSession(id,controller.signal); }
    finally { clearTimeout(waiting); }
    try {
      // The previous run must have finished, including its snapshot and session cleanup.
      const current = db.prepare("SELECT done FROM subtasks WHERE id=?").get(id) as any;
      if (!current || current.done) throw new Error("Шаг успел завершиться; заменять его уже нельзя");
      technicalSlotSnapshot(id,"stopped",{blocker:reason});
      db.transaction(() => {
        db.prepare("UPDATE attempts SET ended_at=datetime('now'),outcome='reset',reason=? WHERE subtask_id=? AND ended_at IS NULL").run(reason,id);
        // Deliberately scoped to one slot: parallel executors must remain untouched.
        db.prepare("UPDATE subtasks SET agent_state=NULL,agent_id=NULL,agent_heartbeat_at=NULL,current_attempt_id=NULL,block_type=NULL,blocked_at=NULL WHERE id=?").run(id);
        if (role !== "critic_verifier") db.prepare("UPDATE tasks SET agent_state='in_progress',updated_at=datetime('now') WHERE id=? AND agent_state='review'").run(row.task_id);
        logEvent({taskId:row.task_id,actorId:actor,kind:"slot_executor_replaced",field:row.plan_node_key,toValue:JSON.stringify({subtask_id:id,role,reason})});
      })();
    } finally { release(); }
    return await startPlanSubtaskRun(id,actor,{freshSession:true});
  } finally { replacing.delete(id); }
}

/** Chat provenance is captured by the server, never chosen by the model. */
export async function restartSlotFromOwnerChat(chatId: string, messageId: string, p: {subtask_id:string;role:string;reason:string}) {
  const message = db.prepare("SELECT from_user_id FROM chat_messages WHERE id=? AND chat_id=?").get(messageId,chatId) as {from_user_id:string}|undefined;
  if (!message || (!isOwner(message.from_user_id) && !isOrchestrator(message.from_user_id))) throw new Error("Перезапуск из чата доступен только по сообщению владельца или оркестратора");
  return asControlActor(message.from_user_id,"POST",`/api/subtasks/${encodeURIComponent(p.subtask_id)}/restart`,{role:p.role,reason:p.reason});
}
