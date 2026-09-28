import db from "../db.js";
import { logEvent } from "../agentState.js";
import { unlockReadySlots } from "../routes/task-role-slots.js";

const SLOT_ORDER = ["waiting", "ready", "active", "submitted", "accepted"];

/** Мост между обычным workflow основной попытки (assignee_id, agent_state,
 *  status — обычные /claim и /state) и её узлом в collaboration plan.
 *  Основной исполнитель работает через обычные переходы задачи, а не через
 *  slot API — без этого моста его узел плана никогда бы не сдвинулся, и
 *  зависимые ноды (QA, Критик) вечно ждали бы событие, которого не будет.
 *  Вызывается из routes/tasks.ts, routes/subtasks.ts и routes/agent-state.ts
 *  в момент, когда основная попытка реально переходит в review/completed. */
export async function advancePrimaryPlanSlot(taskId: string, actorId: string, toState: "submitted" | "accepted"): Promise<void> {
  const task = db.prepare("SELECT assignee_id FROM tasks WHERE id = ?").get(taskId) as { assignee_id: string | null } | undefined;
  if (!task?.assignee_id) return;
  const assignee = db.prepare("SELECT role_key FROM users WHERE id = ?").get(task.assignee_id) as { role_key: string | null } | undefined;
  if (!assignee?.role_key) return;
  const plan = db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id = ? AND status = 'approved' ORDER BY revision DESC LIMIT 1").get(taskId) as { id: string } | undefined;
  if (!plan) return;
  const node = db.prepare("SELECT slot_key FROM task_collaboration_plan_nodes WHERE plan_id = ? AND role_key = ?").get(plan.id, assignee.role_key) as { slot_key: string } | undefined;
  if (!node) return;
  const slotRow = db.prepare("SELECT id, state FROM task_role_slots WHERE collaboration_plan_id = ? AND plan_node_key = ?").get(plan.id, node.slot_key) as { id: string; state: string } | undefined;
  if (!slotRow) return;
  if (SLOT_ORDER.indexOf(slotRow.state) >= SLOT_ORDER.indexOf(toState)) return;
  db.prepare("UPDATE task_role_slots SET state = ?, updated_at = datetime('now') WHERE id = ?").run(toState, slotRow.id);
  logEvent({ taskId, actorId, kind: "primary_plan_slot_advanced", field: node.slot_key, toValue: toState });
  await unlockReadySlots(plan.id, taskId, actorId);
}

/**
 * Непринятые предшественники основной попытки. Это не «все slots плана»:
 * QA и Критик идут после основной реализации и не должны блокировать claim.
 */
export function unmetPrimaryPlanPredecessors(taskId: string, userId: string): Array<{ slot_key: string; role_key: string }> {
  const caller = db.prepare("SELECT role_key FROM users WHERE id = ?").get(userId) as { role_key: string | null } | undefined;
  if (!caller?.role_key) return [];
  const plan = db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id = ? AND status = 'approved' ORDER BY revision DESC LIMIT 1").get(taskId) as { id: string } | undefined;
  if (!plan) return [];
  return db.prepare(`
    WITH RECURSIVE ancestors(slot_key) AS (
      SELECT e.from_slot_key
        FROM task_collaboration_plan_edges e
        JOIN task_collaboration_plan_nodes target ON target.plan_id = e.plan_id AND target.slot_key = e.to_slot_key
       WHERE e.plan_id = ? AND target.role_key = ?
      UNION
      SELECT e.from_slot_key
        FROM task_collaboration_plan_edges e
        JOIN ancestors a ON a.slot_key = e.to_slot_key
       WHERE e.plan_id = ?
    )
    SELECT a.slot_key, n.role_key
      FROM ancestors a
      JOIN task_collaboration_plan_nodes n ON n.plan_id = ? AND n.slot_key = a.slot_key
 LEFT JOIN task_role_slots s ON s.collaboration_plan_id = ? AND s.plan_node_key = a.slot_key
     WHERE COALESCE(s.state, 'waiting') <> 'accepted'
     ORDER BY a.slot_key
  `).all(plan.id, caller.role_key, plan.id, plan.id, plan.id) as Array<{ slot_key: string; role_key: string }>;
}
