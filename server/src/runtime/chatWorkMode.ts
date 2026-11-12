import { registryText } from "../lib/roleRules.js";
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
  // Чтение на хосте и проверки на чтение по белому списку (владелец 06.11.2026).
  "taskflow_hosts", "taskflow_host_read", "taskflow_host_ls", "taskflow_host_grep", "taskflow_host_find",
  "taskflow_inspect",
];
export function chatModeInstruction(mode: ChatWorkMode): string {
  return registryText("режим: " + mode, undefined, "mode:" + mode);
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
