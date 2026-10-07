import db from "../db.js";

/**
 * Критик проверил и одобрил текущую сдачу — клиенты рисуют рядом с «На проверке» двойную
 * галочку (владелец 07.10.2026). Вердикт приходит двумя путями:
 *  - итоговая проверка: событие review_recorded «версия:вердикт» после последнего ухода в review;
 *  - Критик шагом плана: берётся его последний шаг в согласованном плане (он не обязан стоять
 *    последним — после него бывает QA). Карточка на проверке, значит план сдан; шаг закрыт и
 *    не возврат — Критик одобрил.
 */
export function criticApproved(taskId: string): boolean {
  const verdict = db.prepare(
    `SELECT to_value FROM task_events WHERE task_id = ? AND kind = 'review_recorded'
        AND created_at >= COALESCE((SELECT MAX(created_at) FROM task_events WHERE task_id = ? AND kind = 'state_changed' AND to_value = 'review'), '')
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(taskId, taskId) as { to_value: string | null } | undefined;
  if (verdict) return (verdict.to_value ?? "").endsWith(":approved");
  const last = db.prepare(
    `SELECT n.role_key, s.done, s.result FROM subtasks s
       JOIN task_collaboration_plans p ON p.id = s.collaboration_plan_id AND p.status = 'approved'
       JOIN task_collaboration_plan_nodes n ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
      WHERE s.task_id = ? AND n.skipped_at IS NULL AND n.role_key = 'critic_verifier' ORDER BY s.position DESC LIMIT 1`,
  ).get(taskId) as { role_key: string; done: number; result: string | null } | undefined;
  return !!last && last.done === 1 && !/^(changes_requested|blocked)/.test(last.result ?? "");
}
