// Набор инструментов по роли. Владелец 07.11.2026: у каждой роли один полный
// набор — роли различаются инструкцией, навыками и подключёнными MCP, а не
// урезанным списком. Прежние ONLY/DENY (14.10–28.10.2026) сняты. Остаётся один
// запрет — необратимое удаление у Помощника владельца (его личные данные:
// напоминания, задачи); things_delete лишь переносит дело в Корзину Things.
const BUILDER_HOST_PREFIX = "taskflow_host";
const BUILDER_HOST_NAMES = new Set(["taskflow_hosts"]);

export function roleToolAllowed(role: string, tool: string): boolean {
  if (role === "secretary" && tool !== "things_delete" && /delete|purge|remove/i.test(tool)) return false;
  // iOS и серверный код на .110 — локальные read/bash/edit/write, не Mac-хост (11.11.2026).
  if (role === "builder" && (BUILDER_HOST_NAMES.has(tool) || tool.startsWith(BUILDER_HOST_PREFIX + "_"))) return false;
  return true;
}
