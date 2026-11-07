// Инструменты роли в чате задачи (владелец 05.11.2026): только чтение, и только
// своей задачи. Запрет держит сервер: лишних инструментов роль просто не получает,
// а чужую карточку, документ или коллегу пускает только слово владельца.

import db from "../db.js";
import { roleTitle } from "../roleRouting.js";
import { ownerMessageText, ownerNamed, taskDocuments } from "../lib/taskChatScope.js";

export const TASK_CHAT_MODE = "task_chat";

/** Роли, которых ограничение чата задачи не касается: у них в чате карточки те же полномочия, что в обычной работе.
 *  Помощник владельца — прежнее решение; оркестратор — решение владельца 06.11.2026. */
const TASK_CHAT_UNRESTRICTED_ROLES = new Set(["secretary", "code_orchestrator"]);
export function isTaskChatRestrictedRole(role: string): boolean {
  return !TASK_CHAT_UNRESTRICTED_ROLES.has(role);
}

/** Встроенные инструменты файлов: только чтение кода. */
export const TASK_CHAT_FILE_TOOLS = ["read", "grep", "find", "ls"];

const ALLOWED = new Set([
  "taskflow_task", "taskflow_plan_read", "taskflow_doc_read", "taskflow_topic_read", "taskflow_topic_send",
  "taskflow_hosts", "taskflow_host_read", "taskflow_host_ls", "taskflow_host_grep", "taskflow_host_find",
]);

export function isTaskChatTool(name: string): boolean {
  return ALLOWED.has(name) || name.includes("graft_");
}

type Scope = { taskId?: string; messageId?: string; role: string };

function taskAllowed(scope: Scope, target: string): void {
  if (target === scope.taskId) return;
  const row = db.prepare("SELECT id, title FROM tasks WHERE id = ?").get(target) as { id: string; title: string } | undefined;
  if (row && ownerNamed(ownerMessageText(scope.messageId), row)) return;
  throw new Error("В чате задачи чужую карточку можно открыть, только если её назвал владелец");
}

function noteAllowed(scope: Scope, noteId: string): void {
  if (scope.taskId) {
    if (taskDocuments(scope.taskId).some((doc) => doc.id === noteId)) return;
    const own = db
      .prepare("SELECT 1 FROM tasks t WHERE t.id = ? AND (t.description LIKE ? OR EXISTS (SELECT 1 FROM subtasks s WHERE s.task_id = t.id AND s.result LIKE ?))")
      .get(scope.taskId, `%${noteId}%`, `%${noteId}%`);
    if (own) return;
  }
  const note = db.prepare("SELECT id, title FROM user_notes WHERE id = ?").get(noteId) as { id: string; title: string | null } | undefined;
  if (note && ownerNamed(ownerMessageText(scope.messageId), note)) return;
  throw new Error("В чате задачи чужой документ можно открыть, только если его назвал владелец");
}

function colleagueAllowed(scope: Scope, to: string, taskId?: string): void {
  if (taskId && taskId !== scope.taskId) throw new Error("Из чата можно написать только коллеге по этой задаче");
  const text = ownerMessageText(scope.messageId);
  const title = (() => { try { return roleTitle(to); } catch { return to; } })();
  if (text && (text.includes(`@${to}`) || ownerNamed(text, { id: to, title }) || stemHit(text, title))) return;
  throw new Error("Написать коллеге из чата можно только по слову владельца");
}

/** В названии роли часто значимо одно слово: «тестировщик» в «Лайф-тестировщик». */
function stemHit(text: string, title: string): boolean {
  const said = text.toLowerCase();
  return title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 6).some((word) => said.includes(word.slice(0, 6)));
}

export function scopeTaskChatOperations<T extends { name: string; execute: (...args: any[]) => any }>(operations: T[], scope: Scope): T[] {
  return operations.map((tool) => {
    if (!["taskflow_task", "taskflow_plan_read", "taskflow_topic_read", "taskflow_doc_read", "taskflow_topic_send"].includes(tool.name)) return tool;
    return {
      ...tool,
      execute: async (id: string, args: any, ...rest: any[]) => {
        if (tool.name === "taskflow_task") taskAllowed(scope, String(args?.id ?? ""));
        else if (tool.name === "taskflow_plan_read") taskAllowed(scope, String(args?.task_id ?? scope.taskId ?? ""));
        else if (tool.name === "taskflow_topic_read") taskAllowed(scope, String(args?.task_id ?? scope.taskId ?? ""));
        else if (tool.name === "taskflow_doc_read") noteAllowed(scope, String(args?.id ?? ""));
        else colleagueAllowed(scope, String(args?.to ?? ""), args?.task_id);
        return tool.execute(id, args, ...rest);
      },
    };
  });
}
