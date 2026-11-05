import db from "../db.js";

export type ChatExecutionMode = "chat" | "card";
export function parseChatExecutionMode(value: unknown): ChatExecutionMode {
  if (value === "chat" || value === "card") return value;
  throw new Error("Выберите «В чате» или «По карточке»");
}
/**
 * Правило владельца (05.11.2026): способ выполнения не выбирается. Чат, привязанный
 * к задаче, работает по карточке; любой другой — в чате. Уже принятое сообщение
 * сохраняет свой способ.
 */
export function chatExecutionMode(chatId?: string, messageId?: string): ChatExecutionMode {
  if (chatId && messageId) {
    const message = db.prepare("SELECT execution_mode FROM chat_messages WHERE id=? AND chat_id=?").get(messageId,chatId) as any;
    if (message?.execution_mode) return parseChatExecutionMode(message.execution_mode);
  }
  const chat = chatId ? db.prepare("SELECT task_id FROM chats WHERE id=?").get(chatId) as any : null;
  return chat?.task_id ? "card" : "chat";
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
  return mode === "chat"
    ? "СПОСОБ ВЫПОЛНЕНИЯ: В чате. Выполняй поручение прямо здесь до результата: код, исследования, документы и действия разрешены в пределах роли. Сообщай ход и принимай уточнения. Карточка задачи, claim, heartbeat, сдача слота, обязательный критик для этой работы не нужны. Не создавай карточки, подзадачи и карточные планы и не требуй их вместо выполнения. Длительность и сложность не меняют режим. Используй рабочий чек-лист чата для многошаговой работы; материалы возвращай в исходный разговор. Только владелец выбирает способ выполнения. Для явного поручения оформить карточку владелец выбирает «По карточке» или пишет «Оформить как карточку». Это правило имеет приоритет над карточным процессом в общих инструкциях и истории."
    : "СПОСОБ ВЫПОЛНЕНИЯ: По карточке. Владелец выбрал работу через карточку задачи. Используй выбранную карточку и установленный процесс постановки, этапов, отчёта и приёмки; если карточки ещё нет — оформи поручение существующим инструментом и покажи владельцу. Самостоятельно не переключай способ выполнения.";
}
/** Only an explicit standalone owner command authorizes a card handoff. */
export function isCardHandoffCommand(text: string): boolean {
  return /^(?:оформи(?:ть)?|создай|создать)\s+(?:(?:это|работу|задачу)\s+)?(?:как\s+|в\s+)?карточк[уа](?:[.!:]|$)/iu.test(text.trim());
}
