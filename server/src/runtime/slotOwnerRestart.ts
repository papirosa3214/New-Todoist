// Замена заблокированного слота по решению владельца (владелец 07.11.2026).
//
// Владелец: «критерий — моё решение, а не кто-то там попросит». Поэтому:
//   * роль НЕ просит и ничего не подтверждает сама;
//   * замена выполняется, только когда в этом же чате есть сообщение
//     ВЛАДЕЛЬЦА (или Оркестратора) — это проверяет restartSlotFromOwnerChat;
//   * роль может заменить только слот СВОЕЙ роли и только заблокированный.
//
// Отличие от прежней заявки: нет таблицы заявок и нет вопроса с кнопками.
// Роль зовёт инструмент по просьбе владельца — сервер сам сверяет, чьё это
// сообщение и чей слот.
import db from "../db.js";
import { restartSlotFromOwnerChat } from "./slotRestart.js";

/** Слот заблокирован? Замена по решению владельца допустима и для blocked. */
function slotOfRole(subtaskId: string): { role_key: string; task_id: string; archived: number; agent_state: string | null } | undefined {
  return db
    .prepare(
      `SELECT n.role_key, s.task_id, COALESCE(t.archived_at,'') <> '' AS archived, s.agent_state
         FROM subtasks s
         LEFT JOIN task_collaboration_plan_nodes n
           ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
         LEFT JOIN tasks t ON t.id = s.task_id
        WHERE s.id = ?`,
    )
    .get(subtaskId) as
    | { role_key: string; task_id: string; archived: number; agent_state: string | null }
    | undefined;
}

export type OwnerDrivenRestartResult =
  | { status: "restarted" }
  | { status: "refused"; reason: string };

/**
 * Роль запускает замену своего заблокированного слота по сообщению владельца.
 * Возвращает исход; текст отказа пригоден для показа роли как есть.
 */
export async function restartOwnSlotByOwnerMessage(args: {
  chatId: string;
  messageId: string;
  role: string;
  subtaskId: string;
  reason: string;
}): Promise<OwnerDrivenRestartResult> {
  const slot = slotOfRole(args.subtaskId);
  if (!slot) return { status: "refused", reason: "Слот не найден" };
  if (slot.role_key !== args.role) {
    return { status: "refused", reason: `Слот принадлежит роли «${slot.role_key}», а не «${args.role}»` };
  }
  if (slot.archived) {
    return {
      status: "refused",
      reason: "Карточка в архиве — узлы архивной карточки не запускаются. Нужно вернуть её из архива.",
    };
  }
  try {
    // Права и источник сообщения проверяет эта функция: сообщение должно быть
    // от владельца или Оркестратора в этом же чате.
    await restartSlotFromOwnerChat(args.chatId, args.messageId, {
      subtask_id: args.subtaskId,
      role: args.role,
      reason: args.reason,
    });
    return { status: "restarted" };
  } catch (error) {
    return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
  }
}
