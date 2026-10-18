// MAK-70: проверка коммита на ветке `roles/<taskId>` при сдаче шага.
//
// Логика (владелец 01.10.2026, карточка T05):
//   1. Шаг закрывает агент (вызов `taskflow_subtask_done`, на сервере
//      PATCH /api/subtasks/:id с done=true) — это последнее рукопожатие
//      перед сдачей результата.
//   2. Если на ветке `roles/<id>` есть хотя бы один коммит, не
//      присутствующий в main — шаг принимается: работа зафиксирована в
//      git.
//   3. Если ветки нет или коммитов поверх main нет — закрытие шага
//      отклоняется с понятной ошибкой.
//
// Обновление 19.10.2026 (LOCK-WORKTREE-MANAGER-20261019): факты о ветке
// и копии теперь снимает один инспектор `lib/worktree/inspect.ts`, а
// этот модуль остаётся совместимой обёрткой — его вызывает `subtasks.ts`
// и старые тесты. Гард с незакоммиченными изменениями живёт в
// `lib/worktree/finalize.ts` и тоже вызывается отсюда.
import { inspectWorktree } from "./worktree/inspect.js";
import { finalizeWorktreeError } from "./worktree/finalize.js";
import { liveRepo } from "./worktree/paths.js";

export interface CommitCheckResult {
  hasCommits: boolean;
  branchExists: boolean;
  aheadCount: number;
  branchTip: string | null;
  baseTip: string | null;
}

/**
 * Проверить, есть ли на ветке `roles/<taskId>` хотя бы один коммит
 * поверх main. Возврат — структура с диагностикой; UI/логирование
 * может её показать, для гарда достаточно `hasCommits`.
 *
 * `base` по умолчанию `main`. Если у карточки собственная база
 * (форк/feature-ветка для слияния) — параметр можно будет расширить.
 */
export function inspectRoleBranch(
  taskId: string,
  base: string = "main",
  live: string = liveRepo(),
): CommitCheckResult {
  const state = inspectWorktree(taskId, base, live);
  return {
    hasCommits: state.ahead_count > 0,
    branchExists: state.branch_exists,
    aheadCount: state.ahead_count,
    branchTip: state.tip,
    baseTip: state.base_tip,
  };
}

/**
 * Текст ошибки для гарда в subtask_done. Возвращает `null`, если шаг
 * можно закрывать.
 *
 * Проверка молчит там, где смотреть нечего: ветки `roles/<id>` нет
 * (сторонний проект или карточка без серверного бэкенда), копии
 * выключены. Иначе — внятный текст: что именно не зафиксировано.
 *
 * Тестовая подмена: `MAK70_LIVE_REPO` смотрит на временный
 * репозиторий, а не на боевой.
 */
export function commitGuardError(
  taskId: string,
  live: string = liveRepo(),
): string | null {
  return finalizeWorktreeError(taskId, { live });
}
