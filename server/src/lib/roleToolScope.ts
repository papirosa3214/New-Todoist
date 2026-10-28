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
  taskflow_archive: ["secretary"],
  // Apple Напоминания и Apple Календарь (21.10.2026): данные личные, живут на
  // айфоне, и доступ к ним — только у Помощника владельца. Без этой записи
  // новый инструмент достаётся всем ролям (правило файла).
  apple_reminders_create: ["secretary"],
  apple_reminders_list: ["secretary"],
  apple_reminders_complete: ["secretary"],
  apple_reminders_reschedule: ["secretary"],
  apple_reminders_delete: ["secretary"],
  apple_calendar_agenda: ["secretary"],
  apple_calendar_create: ["secretary"],
  apple_calendar_update: ["secretary"],
  // Метки задач (26.10.2026): личная оснастка владельца, доступна только
  // Помощнику владельца.
  taskflow_set_task_labels: ["secretary"],
  taskflow_labels: ["secretary"],
  // Уборка чатов и тем задач (22.10.2026): сервер умел, роли не видели.
  taskflow_chat_archive: ["code_orchestrator", "secretary"],
  taskflow_chat_close: ["code_orchestrator", "secretary"],
  taskflow_chats_cleanup_preview: ["code_orchestrator"],
  taskflow_chats_cleanup: ["code_orchestrator"],
  // Уточнение у владельца из чата (26.10.2026): спрашивает владелец, отвечает
  // тоже он — инструмент только у Помощника владельца.
  taskflow_ask_user_question: ["secretary"],
  // Вызов роли как субагента (28.10.2026): цепочки ролей заводит Помощник
  // владельца (совет по своей работе) и Оркестратор (разбор результата по
  // ролям). Остальным роль звать незачем — и опасно: цепочка ролей.
  taskflow_call_role: ["secretary", "code_orchestrator"],
};

const DENY: Record<string, string[]> = {
  critic_verifier: ["chat_send", "chat_read", "topic_reply", "consult", "claim", "heartbeat", "subtask_add", "library"],
  analyst: ["chat_send", "chat_read", "consult", "claim"],
  researcher: ["chat_read", "consult"],
  designer: ["chat_send", "chat_read"],
  infra_engineer: ["chat_send", "chat_read", "consult", "claim"],
};

export function roleToolAllowed(role: string, tool: string): boolean {
  // Владелец 26.10.2026 разрешил помощнице все действия с рутинами,
  // включая удаление самой рутины; удаление её задач этим не разрешается.
  if (tool === "taskflow_routines" || tool.startsWith("taskflow_routine_")) return role === "secretary";
  // Помощник владельца имеет общий набор TaskFlow-инструментов, кроме
  // операций удаления/физической очистки. Архивирование остаётся доступно.
  // things_delete лишь переносит дело в Корзину Things — как и до разделения операций.
  // apple_reminders_delete — то же самое: стирание напоминания недоступно,
  // закрыть (apple_reminders_complete) и перенести (apple_reminders_reschedule) можно.
  if (role === "secretary" && tool !== "things_delete" && /delete|purge|remove/i.test(tool)) return false;
  const only = ONLY[tool];
  if (only && !only.includes(role)) return false;
  return !(DENY[role] ?? []).some((name) => tool === "taskflow_" + name);
}
