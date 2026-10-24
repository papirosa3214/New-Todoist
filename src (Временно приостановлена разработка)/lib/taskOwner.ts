import type { ApiTask, ApiUser, Role } from "../api/types";

/**
 * Подпись роли на плашке рядом с именем — в списке агентов и в выборе
 * исполнителя. Раньше в трёх местах стоял один и тот же тернарник
 * «владелец или агент»; с появлением оркестратора (28.08.2026) вариантов
 * стало три, и место у них теперь одно.
 */
export function roleLabel(role: Role | undefined): string {
  if (role === "owner") return "Владелец";
  if (role === "orchestrator") return "Оркестратор";
  return "Агент";
}

/**
 * Задача назначена агенту (ИИ-исполнителю), а не человеку — по фактическому
 * типу пользователя-исполнителя, не по имени/эвристике. Используется, чтобы
 * НЕ показывать такие задачи там, где им не место (19.08.2026, владелец:
 * «там, где назначен агент, кроме как во входящих в конкретном проекте, эта
 * задача нигде не показываться не должна... засоряют мне ленту»):
 * Предстоящее — полностью, календарная развёртка часов на «Сегодня» —
 * тоже. Обычный список «Сегодня» и «Входящие» (там, где задача и должна
 * жить, в своём проекте) — НЕ трогать, владелец явно оставил как есть.
 */
export function isAgentAssignedTask(
  task: Pick<ApiTask, "assignee_id">,
  agents: Pick<ApiUser, "id" | "type">[],
): boolean {
  if (!task.assignee_id) return false;
  return agents.some((a) => a.id === task.assignee_id && a.type === "ai");
}

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

/**
 * Задача «ждёт владельца»: активная, не дочерняя (subtask),
 * владелец — текущий пользователь, агентское состояние = blocked или
 * review. Тот самый предикат, что рисует блок «Ждут вас» в «Сегодня».
 * Извлечён из TodayScreen в lib/ в Шаге 2 (feature/projects-decouple-
 * planner-merge), чтобы не дублировать между filter-aware (plannerTasks)
 * и «искренним» (allTasks) счётом — оба зовут один источник правды.
 * Раньше та же логика жила inline в двух useMemo, и ревьюер
 * (@local-macbook) счёл это техдолгом после фикса Шага 1.
 */
export function isWaitingForUser(
  task: Pick<
    ApiTask,
    "status" | "parent_id" | "creator_id" | "agent_state"
  >,
  user: ApiUser | null | undefined,
): boolean {
  if (!user) return false;
  return (
    task.status === "active" &&
    !task.parent_id &&
    isTaskOwner(user, task) &&
    (task.agent_state === "blocked" || task.agent_state === "review")
  );
}

/** Comparator для сортировки «ждут вас»: blocked впереди review.
 *  Тот же приоритет, что был inline в TodayScreen Шага 1. */
export const waitingBlockedFirst = (
  a: Pick<ApiTask, "agent_state">,
  b: Pick<ApiTask, "agent_state">,
): number =>
  (a.agent_state === "blocked" ? 0 : 1) -
  (b.agent_state === "blocked" ? 0 : 1);
