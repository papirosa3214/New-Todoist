/** A mode belongs to one queued turn, including handoffs. */
export type ChatWorkMode = "work" | "plan" | "deep_research";
export function parseChatWorkMode(value: unknown): ChatWorkMode {
  if (value === undefined) return "work";
  if (value === "work" || value === "plan" || value === "deep_research") return value;
  throw new Error("Неизвестный режим работы");
}
export const PLANNING_TOOLS = [
  "read", "grep", "find", "ls",
  "taskflow_my_tasks", "taskflow_task", "taskflow_rules", "taskflow_status",
  "taskflow_agents", "taskflow_chat_read", "taskflow_projects", "taskflow_project_tasks",
  "taskflow_my_stats", "taskflow_docs", "taskflow_doc_read", "taskflow_kb_search",
  "taskflow_runtime", "taskflow_weather",
];
export function chatModeInstruction(mode: ChatWorkMode): string {
  switch (mode) {
    case "work": return "Режим этого хода: Работа. Выполняй запрос в пределах полномочий роли. Предыдущий режим этого чата не действует.";
    case "plan": return "Режим этого хода: Планирование. Только чтение, анализ и план в ответе чата. Не изменяй файлы, задачи, документы, состояния и настройки; не запускай команды и не передавай выполнение коллегам. Предложи шаги, риски и критерии проверки. Для выполнения владелец должен выбрать режим Работа.";
    case "deep_research": return "Режим этого хода: Глубокое исследование. Сначала сформулируй исследовательские вопросы, затем ищи и сопоставляй несколько независимых первичных источников. Проверяй даты, противоречия и применимость. Явно отдели подтверждённые факты от гипотез. Итог: выводы, прямые ссылки на источники, ограничения и практические рекомендации. Не выдавай непроверенные предположения за проведённое исследование.";
  }
}
