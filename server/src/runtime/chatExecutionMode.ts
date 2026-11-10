import db from "../db.js";
import { registryText } from "../lib/roleRules.js";

export type ChatExecutionMode = "chat" | "card";
export function parseChatExecutionMode(value: unknown): ChatExecutionMode {
  if (value === "chat" || value === "card") return value;
  throw new Error("Выберите «В чате» или «По карточке»");
}
/**
 * Правило владельца (06.11.2026): переключателя «В чате / По карточке» нет. У чата есть
 * задача (chats.task_id) — card; задачи нет — chat. Ветка (в т.ч. субагента taskflow_call_role)
 * наследует задачу корневого чата. Сохранённые execution_mode в сообщениях и чатах — следы
 * переключателя: колонки остаются, но больше не читаются. messageId оставлен для совместимости.
 */
export function chatExecutionMode(chatId?: string, _messageId?: string): ChatExecutionMode {
  if (!chatId) return "chat";
  const chat = db.prepare("SELECT task_id, branch_of_chat_id FROM chats WHERE id=?").get(chatId) as
    | { task_id: string | null; branch_of_chat_id: string | null } | undefined;
  if (chat?.task_id) return "card";
  if (chat?.branch_of_chat_id) {
    const root = db.prepare("SELECT task_id FROM chats WHERE id=?").get(chat.branch_of_chat_id) as { task_id: string | null } | undefined;
    if (root?.task_id) return "card";
  }
  return "chat";
}
export const CARD_WORK_OPERATIONS = new Set([
  "taskflow_create_task", "taskflow_suggest_subtasks", "taskflow_structure_dictation",
  "taskflow_work_start", "taskflow_review_result", "taskflow_review_code",
  "taskflow_plan_request", "taskflow_task_proposal", "taskflow_subtask_add",
  "taskflow_claim", "taskflow_heartbeat", "taskflow_state", "taskflow_review",
  "taskflow_subtask_work", "taskflow_subtask_done", "taskflow_slot_restart",
  "taskflow_slot_snapshot", "taskflow_report",
]);
export function chatExecutionInstruction(mode: ChatExecutionMode): string {
  return registryText("способ: " + (mode === "chat" ? "в чате" : "по карточке"), undefined, "exec:" + mode);
}
/** Only an explicit standalone owner command authorizes a card handoff. */
export function isCardHandoffCommand(text: string): boolean {
  return /^(?:оформи(?:ть)?|создай|создать)\s+(?:(?:это|работу|задачу)\s+)?(?:как\s+|в\s+)?карточк[уа](?:[.!:]|$)/iu.test(text.trim());
}
