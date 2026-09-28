import db from "../db.js";

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
