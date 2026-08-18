import type { ApiTask, ApiUser } from "../api/types";

/**
 * Владелец задачи — тот, кто принимает по ней работу: кнопки «Принять» и
 * «Вернуть», блок «Ждут вас», приёмка шагов.
 *
 * Это создатель задачи ИЛИ владелец трекера (`role === "owner"`). Второе
 * условие добавлено 18.08.2026 вместе с серверным правилом доступа по роли
 * (server/src/access.ts): задачу, которую агент завёл сам, принимать было
 * некому — создателем числился бот, и человеку не показывалась ни одна
 * владельческая кнопка, хотя на сервере право у него было. Формулировка
 * Максима: «человек-владелец видит всё и вся и может залезать куда угодно».
 */
export function isTaskOwner(
  user: ApiUser | null | undefined,
  task: Pick<ApiTask, "creator_id">,
): boolean {
  if (!user) return false;
  return user.role === "owner" || user.id === task.creator_id;
}

/** Тот же вопрос без конкретной задачи: может ли этот человек принимать работу вообще. */
export function isTrackerOwner(user: ApiUser | null | undefined): boolean {
  return user?.role === "owner";
}
