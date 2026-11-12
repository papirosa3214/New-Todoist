// План решения заблокированного слота и номера одинаковых ролей (владелец 05.11.2026).
//
// В заблокированном слоте разговор идёт как обычно: сервер не запрещает отвечать,
// а только подбрасывает роли маячок предложить план. Под блоком плана у владельца
// кнопка «Продолжить», как Play у команды.

import db from "../db.js";
import { roleTitle, roleUserId } from "../roleRouting.js";

export const RESOLUTION_PLAN_BEACON = [
  "Этот этап заблокирован, и владелец пришёл помочь его продвинуть. Отвечай на его сообщение как обычно: сначала разберитесь, что мешает и чего он хочет.",
  "Когда станет ясно, как двигаться дальше, предложи план решения отдельным блоком:",
  "```plan",
  "1. Первое действие",
  "2. Второе действие",
  "```",
  "Под этим блоком у владельца появится кнопка «Продолжить»: по ней этот этап пойдёт дальше с твоей же памятью. Пока ясности нет, блок не добавляй.",
].join("\n");

export function hasResolutionPlan(text: unknown): boolean {
  return /```plan[^\S\n]*\n(?=[\s\S]*?\S[\s\S]*?```)\s*[^`\s]/.test(String(text ?? ""));
}

export type SlotLabel = { subtask_id: string; role_id: string; label: string; state: string | null };

/** Подписи слотов задачи: если роль в плане не одна, у неё появляется номер. */
export function slotLabels(taskId: string): SlotLabel[] {
  const rows = db
    .prepare(
      `SELECT s.id, n.role_key, s.agent_state, s.slot_number FROM subtasks s
         JOIN task_collaboration_plan_nodes n ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
         JOIN task_collaboration_plans p ON p.id = n.plan_id
        WHERE s.task_id = ? AND p.status = 'approved' AND n.skipped_at IS NULL
        ORDER BY s.position, s.rowid`,
    )
    .all(taskId) as Array<{ id: string; role_key: string; agent_state: string | null; slot_number: number | null }>;
  const total = new Map<string, number>();
  for (const row of rows) total.set(row.role_key, (total.get(row.role_key) ?? 0) + 1);
  return rows.map((row, index) => {
    const title = roleTitle(row.role_key);
    // Номер хранится в слоте (`subtasks.slot_number`) и не зависит от того,
    // какое место он занимает сейчас. Старые строки без номера — порядковый
    // номер как запасной вариант, пока миграция их не заполнила.
    const number = row.slot_number ?? index + 1;
    return {
      subtask_id: row.id,
      role_id: roleUserId(row.role_key),
      label: (total.get(row.role_key) ?? 0) > 1 ? `${title} ${number}` : title,
      state: row.agent_state,
    };
  });
}

/** Подпись для сообщения слота; без номера подпись не нужна. */
export function numberedSlotLabel(subtaskId: string): string | null {
  const row = db.prepare("SELECT task_id FROM subtasks WHERE id = ?").get(subtaskId) as { task_id: string } | undefined;
  if (!row) return null;
  const label = slotLabels(row.task_id).find((slot) => slot.subtask_id === subtaskId)?.label;
  return label && /\s\d+$/.test(label) ? label : null;
}

/** Слот из упоминания «@Разработчик 2» в тексте. Роль без номера адресуется как раньше. */
export function slotFromMention(taskId: string, text: string): string | null {
  const lower = text.toLowerCase();
  const slots = slotLabels(taskId)
    .filter((slot) => /\s\d+$/.test(slot.label))
    .sort((a, b) => b.label.length - a.label.length);
  for (const slot of slots) {
    const mention = `@${slot.label.toLowerCase()}`;
    const at = lower.indexOf(mention);
    if (at >= 0 && !/\d/.test(lower[at + mention.length] ?? "")) return slot.subtask_id;
  }
  return null;
}

/** Показывать ли под сообщением кнопку «Продолжить». */
export function isSlotResumable(message: { subtask_id?: string | null; text?: unknown }): boolean {
  if (!message.subtask_id || !hasResolutionPlan(message.text)) return false;
  const slot = db.prepare("SELECT agent_state, done FROM subtasks WHERE id = ?").get(message.subtask_id) as
    | { agent_state: string | null; done: number }
    | undefined;
  return slot?.agent_state === "blocked" && !slot.done;
}
