import db from "../db.js";
import { logEvent } from "../agentState.js";
import { findStuckSubtasks } from "../routes/owner-controls.js";
import { recoverInterruptedPlanSubtasks, unlockReadyPlanSubtasks, type PlanSubtask } from "./planSubtaskAdmission.js";

/**
 * Владелец написал в чат задачи — сервер будит её план (владелец 07.10.2026: «всё колом встало,
 * хоть в чат пиши — никто ничего сделать не может; та же роль должна вставать на место той,
 * что якобы назначена, но спит»). Два действия, оба уже существовавшими средствами:
 *  - шаги, которые ждут и уже могут начаться, запускаются;
 *  - шаги «в работе» без живого запуска и без сигнала перезапускаются той же ролью — она
 *    продолжает свой же разговор (то же, что кнопка владельца «Возобновить зависшие шаги»,
 *    но только для этой задачи).
 * Живые запуски не трогаются.
 */
export async function nudgeTaskPlan(taskId: string, actorId: string): Promise<{ resumed: number }> {
  const plan = db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id = ? AND status = 'approved' ORDER BY revision DESC LIMIT 1")
    .get(taskId) as { id: string } | undefined;
  if (!plan) return { resumed: 0 };
  const stuck = findStuckSubtasks().filter((row) => row.task_id === taskId);
  let resumed = 0;
  if (stuck.length) {
    const ids = new Set(stuck.map((row) => row.id));
    const result = await recoverInterruptedPlanSubtasks({ skip: (row: PlanSubtask) => !ids.has(row.id), reason: "владелец написал в чат задачи" });
    resumed = result.resumed;
    for (const row of stuck) logEvent({ taskId, actorId, kind: "owner_resume_stuck", field: row.plan_node_key, toValue: `${result.resumed} возобновлено` });
  }
  await unlockReadyPlanSubtasks(plan.id, taskId, actorId);
  return { resumed };
}
