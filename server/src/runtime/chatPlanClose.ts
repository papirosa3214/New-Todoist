// Конец хода роли с активным планом: текущий пункт обязан быть сдан или заблокирован.
// Сервер ОДИН раз продолжает ход просьбой сдать пункт; не сдан и после неё — пункт
// получает отметку unclosed («не закрыт ролью»), план выполненным не считается.
import { markChatItemUnclosed, openChatPlanItem } from "../lib/subtaskWorkPlan.js";

export const PLAN_CLOSE_PROMPT =
  "Перед ответом сдай текущий пункт чек-листа (taskflow_work_item_submit: done с результатом или blocked с причиной)";

export type PlanCloseResult = "none" | "closed" | "unclosed";

export async function ensurePlanItemClosed(
  chatId: string,
  roleId: string,
  prompt: (text: string) => Promise<void>,
): Promise<PlanCloseResult> {
  const open = openChatPlanItem(chatId, roleId);
  if (!open) return "none";
  await prompt(PLAN_CLOSE_PROMPT);
  const still = openChatPlanItem(chatId, roleId);
  // Пункт сдан (или заблокирован): текущим мог стать следующий — его этим дожимом не требуем.
  if (!still || still.id !== open.id) return "closed";
  markChatItemUnclosed(chatId, roleId, still.id);
  return "unclosed";
}
