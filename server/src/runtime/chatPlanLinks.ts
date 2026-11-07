// Связь «вызванная роль → вызвавшая» на время хода субагента (taskflow_call_role).
// План вызванной роли при записи получает parent_role_id и question_id; пока
// идёт её ход, сдача пунктов считается живой без очереди доставки (у комнаты
// субагента строки в chat_message_queue нет).
export type PlanLink = { parentRoleId: string; questionId: string | null };
const links = new Map<string, PlanLink>();
const key = (rootChatId: string, roleId: string) => rootChatId + "|" + roleId;
export function setPlanLink(rootChatId: string, roleId: string, link: PlanLink): void { links.set(key(rootChatId, roleId), link); }
export function clearPlanLink(rootChatId: string, roleId: string): void { links.delete(key(rootChatId, roleId)); }
export function planLinkOf(rootChatId: string, roleId: string): PlanLink | null { return links.get(key(rootChatId, roleId)) ?? null; }
