import db from "../db.js";
import { registryTextOr } from "../lib/roleRules.js";

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
  return registryTextOr("способ: " + (mode === "chat" ? "в чате" : "по карточке"), "exec:" + mode, chatExecutionInstructionLiteral(mode));
}
function chatExecutionInstructionLiteral(mode: ChatExecutionMode): string {
  return mode === "chat"
    ? "СПОСОБ ВЫПОЛНЕНИЯ: В чате. Выполняй поручение прямо здесь до результата: код, исследования, документы и действия разрешены в пределах роли. Сообщай ход и принимай уточнения. Карточка задачи, claim, heartbeat, сдача слота, обязательный критик для этой работы не нужны. Не создавай карточки, подзадачи и карточные планы и не требуй их вместо выполнения. Длительность и сложность не меняют режим. Используй рабочий чек-лист чата для многошаговой работы; материалы возвращай в исходный разговор. Только владелец выбирает способ выполнения. Для явного поручения оформить карточку владелец выбирает «По карточке» или пишет «Оформить как карточку». Это правило имеет приоритет над карточным процессом в общих инструкциях и истории."
    : "СПОСОБ ВЫПОЛНЕНИЯ: По карточке. Владелец выбрал работу через карточку задачи. Используй выбранную карточку и установленный процесс постановки, этапов, отчёта и приёмки; если карточки ещё нет — оформи поручение существующим инструментом и покажи владельцу. Самостоятельно не переключай способ выполнения.";
}
/** Only an explicit standalone owner command authorizes a card handoff. */
export function isCardHandoffCommand(text: string): boolean {
  return /^(?:оформи(?:ть)?|создай|создать)\s+(?:(?:это|работу|задачу)\s+)?(?:как\s+|в\s+)?карточк[уа](?:[.!:]|$)/iu.test(text.trim());
}
