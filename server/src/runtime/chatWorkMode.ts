/** A mode belongs to one queued turn, including handoffs. */
export type ChatWorkMode = "work" | "plan" | "deep_research" | "discussion" | "goal";
export function parseChatWorkMode(value: unknown): ChatWorkMode {
  if (value === undefined) return "work";
  if (value === "work" || value === "plan" || value === "deep_research" || value === "goal") return value;
  throw new Error("Неизвестный режим работы");
}
export const PLANNING_TOOLS = [
  "read", "grep", "find", "ls",
  "taskflow_my_tasks", "taskflow_task", "taskflow_rules", "taskflow_status",
  "taskflow_agents", "taskflow_chat_read", "taskflow_projects", "taskflow_project_tasks",
  "taskflow_my_stats", "taskflow_docs", "taskflow_doc_read", "taskflow_kb_search",
  "taskflow_runtime", "taskflow_weather", "taskflow_recall",
];
export function chatModeInstruction(mode: ChatWorkMode): string {
  switch (mode) {
    // Владелец 20.10.2026: в обсуждении он так же поручает работу и заводит
    // карточки — полномочия те же, что в режиме «Работа».
    case "discussion": return "Режим этого хода: Обсуждение. Отвечай по существу; если в разговоре поручают работу — выполняй её так же, как в режиме Работа, в пределах полномочий роли. Итоговый ответ сервер вернёт автору вопроса автоматически.";
    // Владелец 20.10.2026: «Цель» — роль работает до результата, а не один
    // ответ. Сервер продолжает ход, пока последняя строка — «ЦЕЛЬ: ПРОДОЛЖАЮ».
    case "goal": return `Режим этого хода: Цель. Владелец поставил цель — работай, пока не получишь результат, в пределах полномочий роли. Каждый свой ответ начинай с коротких промежуточных итогов: что сделано и что дальше. Последней строкой ответа ставь ровно одно: «${GOAL_MARK.continue}» — если работа продолжается; «${GOAL_MARK.done}» — если результат получен (перед ней итог); «${GOAL_MARK.owner}» — если нужно решение владельца (перед ней конкретный вопрос).`;
    case "work": return "Режим этого хода: Работа. Выполняй запрос в пределах полномочий роли. Предыдущий режим этого чата не действует.";
    case "plan": return "Режим этого хода: Планирование. Только чтение, анализ и план в ответе чата. Не изменяй файлы, задачи, документы, состояния и настройки; не запускай команды и не передавай выполнение коллегам. Предложи шаги, риски и критерии проверки. Для выполнения владелец должен выбрать режим Работа.";
    case "deep_research": return "Режим этого хода: Глубокое исследование. Сначала сформулируй исследовательские вопросы, затем ищи и сопоставляй несколько независимых первичных источников. Проверяй даты, противоречия и применимость. Явно отдели подтверждённые факты от гипотез. Итог: выводы, прямые ссылки на источники, ограничения и практические рекомендации. Не выдавай непроверенные предположения за проведённое исследование.";
  }
}

/** Последняя строка ответа в режиме «Цель» — по ней сервер решает, давать ли следующий ход. */
export const GOAL_MARK = { continue: "ЦЕЛЬ: ПРОДОЛЖАЮ", done: "ЦЕЛЬ: ДОСТИГНУТА", owner: "ЦЕЛЬ: НУЖЕН ВЛАДЕЛЕЦ" } as const;
export function goalStatus(text: string): "continue" | "done" | "owner" | null {
  const last = text.trim().split("\n").pop()?.trim().replace(/[*_«»."]/g, "") ?? "";
  for (const [key, mark] of Object.entries(GOAL_MARK)) if (last.toUpperCase() === mark) return key as "continue" | "done" | "owner";
  return null;
}
/** Убрать служебную строку из текста, который увидит владелец. */
export function stripGoalMark(text: string): string {
  return goalStatus(text) ? text.trim().split("\n").slice(0, -1).join("\n").trim() : text;
}
