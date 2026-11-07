// Отметка в виджете checklist и сдача пункта плана роли — одно действие.
// Виджет — текст сообщения, а не представление плана, поэтому связь по пункту:
// id пункта плана == ключ пункта виджета либо та же подпись. Если пункт плана найден,
// отметка проходит через submitChatWorkItem; отказ сдачи отменяет и отметку.
import { checklistWidgetsOf, ChecklistItemError, type ChecklistItem } from "./chatChecklist.js";
import { ChatItemSubmitError, readChatWorkPlans, submitChatWorkItem, type ChatItemSubmitResult } from "./subtaskWorkPlan.js";

export function resolveChecklistItem(text: string, widgetKey: string, itemKey: string): ChecklistItem {
  const widgets = checklistWidgetsOf(text);
  const widget = widgets.find((w) => w.widget_key === widgetKey) ?? widgets[Number(widgetKey)];
  if (!widget) throw new ChecklistItemError(`В сообщении нет checklist-виджета «${widgetKey}»`);
  const item = widget.items.find((i) => i.key === itemKey) ?? widget.items[Number(itemKey)];
  if (!item) throw new ChecklistItemError(`В виджете «${widget.title ?? widget.widget_key}» нет пункта «${itemKey}»`);
  return item;
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export type ChecklistPlanSync = { matched: false } | { matched: true; role_id: string; item_id: string; result: ChatItemSubmitResult | null };

export function syncChecklistMarkWithPlan(input: { chatId: string; itemKey: string; label: string; done: boolean; userId: string }): ChecklistPlanSync {
  for (const plan of readChatWorkPlans(input.chatId)) {
    const item = plan.items.find((i) => i.id === input.itemKey || norm(i.title) === norm(input.label));
    if (!item) continue;
    const already = plan.outcomes[item.id];
    const isDone = !!already && !already.stale && already.state === "done";
    if (!input.done) {
      if (isDone) throw new ChatItemSubmitError({ code: "item_already_done", status: 409, message: "Пункт плана уже сдан: снять отметку нельзя" });
      return { matched: true, role_id: plan.role_id, item_id: item.id, result: null };
    }
    if (isDone) return { matched: true, role_id: plan.role_id, item_id: item.id, result: null };
    const result = submitChatWorkItem({
      chatId: input.chatId, roleId: plan.role_id, itemId: item.id, outcome: "done",
      result: "Отмечено владельцем в виджете чек-листа", markedBy: "owner:" + input.userId,
    });
    return { matched: true, role_id: plan.role_id, item_id: item.id, result };
  }
  return { matched: false };
}
