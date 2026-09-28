import db from "../db.js";
import { logEvent } from "../agentState.js";
import { unitState } from "../routes/agent-service.js";
import { dispatchTaskToPi } from "../routes/dispatch.js";

// Отдельный автоматический допуск только заявок watcher'а. Глобальный
// переключатель «Система» действует и здесь; обычные задачи не затрагиваются.
// Назначение, inbox и durable job создаёт существующий диспетчер.
const marker = "_Авто-создано inbox-triage-watcher из inbox/";
const lastErrors = new Map<string, string>();

export async function dispatchPendingDiagnosticTasks(): Promise<void> {
  if (!(await unitState()).active) return;
  const tasks = db.prepare(`
    SELECT t.id, t.creator_id
    FROM tasks t JOIN users u ON u.id = t.creator_id
    WHERE t.status = 'active' AND t.assignee_id IS NULL
      AND (t.agent_state IS NULL OR t.agent_state = 'todo')
      AND u.role = 'owner' AND instr(t.description, ?) > 0
    ORDER BY t.created_at, t.id LIMIT 10
  `).all(marker) as Array<{ id: string; creator_id: string }>;

  for (const task of tasks) {
    try {
      const flagged = db.prepare(`
        UPDATE tasks SET ready_for_pickup = 1, agent_state = NULL,
          ready_set_at = datetime('now'), ready_set_by = ?,
          updated_at = datetime('now')
        WHERE id = ? AND ready_for_pickup = 0 AND status = 'active'
          AND assignee_id IS NULL
      `).run(task.creator_id, task.id);
      if (flagged.changes) {
        logEvent({ taskId: task.id, actorId: null, kind: "ready_flag_changed",
          field: "ready_for_pickup", fromValue: "0", toValue: "1" });
      }
      const result = await dispatchTaskToPi(task.id, task.creator_id, { system: true });
      if (!result.ok) throw new Error(result.error);
      lastErrors.delete(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Причина видна в ленте; одна и та же ошибка не спамит на каждом тике.
      // Карточка остаётся в выборке и повторится без повторного INSERT.
      if (lastErrors.get(task.id) !== message) {
        lastErrors.set(task.id, message);
        console.warn(`[inbox-triage] назначение ${task.id}: ${message}`);
        logEvent({ taskId: task.id, actorId: null, kind: "diagnostic_dispatch_failed",
          field: "assignee_id", toValue: message });
      }
    }
  }
}
