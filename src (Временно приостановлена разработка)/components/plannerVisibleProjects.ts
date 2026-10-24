// Чистая функция-селектор для PlannerProjectChips. Вынесена из компонента,
// чтобы можно было покрыть её юнит-тестом без React-рендера: в проекте
// нет @testing-library/react (devDependencies включают только vitest +
// playwright), вводить testing-library ради одной фичи — лишний шум.
// Шаг 2 (feature/projects-decouple-planner-merge).
import type { ApiProject } from "../api/types";

/**
 * Возвращает проекты, выбранные пользователем для отображения в
 * ежедневнике, в порядке, заданном `projects` (порядок проектов в
 * общем списке сохраняется — это даёт пользователю стабильное
 * расположение чипов между перерендерами).
 *
 * `visibleProjectIds` приходит из стора как Record<string, true>:
 * ключ = id проекта, значение = true. Пустая запись → проект не
 * выбран. Записи, чей id не нашёлся в projects (проект удалён), тихо
 * отбрасываются.
 */
export function selectVisibleProjects(
  projects: ApiProject[],
  visibleProjectIds: Record<string, true>,
): ApiProject[] {
  return projects.filter((p) => visibleProjectIds[p.id]);
}
