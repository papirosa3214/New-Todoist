// Набор инструментов по роли. Владелец 07.11.2026: у каждой роли один полный
// набор — роли различаются инструкцией, навыками и подключёнными MCP, а не
// урезанным списком. Прежние ONLY/DENY (14.10–28.10.2026) сняты. Остаётся один
// запрет — необратимое удаление у Помощника владельца (его личные данные:
// напоминания, задачи); things_delete лишь переносит дело в Корзину Things.
export function roleToolAllowed(role: string, tool: string): boolean {
  if (role === "secretary" && tool !== "things_delete" && /delete|purge|remove/i.test(tool)) return false;
  return true;
}
