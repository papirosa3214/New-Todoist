// Набор инструментов по роли (владелец 14.10.2026). Описания всех инструментов
// идут модели в каждом запросе, а роль пользуется половиной: по 14 дням ходов
// регулярно 11–17 из 30. Здесь — чего роли НЕ давать (новый инструмент по
// умолчанию достаётся всем). Резали с запасом: редкие, но важные (state,
// plan_request, chat_reply, темы, документы) оставлены. Роль позвала
// убранный инструмент — это пишется в журнал role_tool_missing
// (inProcessRun), по нему возвращаем точечно.
const ONLY: Record<string, string[]> = {
  taskflow_review: ["critic_verifier"],
  taskflow_task_daily: ["secretary"],
  taskflow_calendar_events: ["secretary"],
  taskflow_task_proposal: ["architect", "code_orchestrator", "secretary"],
};

const DENY: Record<string, string[]> = {
  critic_verifier: ["chat_send", "chat_read", "topic_reply", "consult", "claim", "heartbeat", "subtask_add", "library"],
  // Помощнику владельца нельзя было закрыть свой шаг: subtask_work и
  // subtask_done стояли здесь в запрете, и он трижды упирался в отказ по
  // правам после выполненной работы (карточка kb-triage-mvbb2ecf, 16.10.2026).
  // Запрет был избыточен: оба инструмента и так привязаны к своему слоту —
  // inProcessRun отклоняет вызов с чужим id («Работай только в назначенном
  // текущем слоте»), так что чужие шаги ими закрыть нельзя в принципе.
  secretary: ["claim", "heartbeat", "state", "slot_snapshot", "subtask_add", "plan_request", "topic_reply", "topic_send", "topic_read", "rules", "library"],
  analyst: ["chat_send", "chat_read", "consult", "claim"],
  researcher: ["chat_read", "consult"],
  designer: ["chat_send", "chat_read"],
  infra_engineer: ["chat_send", "chat_read", "consult", "claim"],
};

export function roleToolAllowed(role: string, tool: string): boolean {
  const only = ONLY[tool];
  if (only && !only.includes(role)) return false;
  return !(DENY[role] ?? []).some((name) => tool === "taskflow_" + name);
}
