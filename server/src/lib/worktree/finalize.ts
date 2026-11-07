// Финализация шага: последний рубеж перед сдачей.
// LOCK-WORKTREE-MANAGER-20261019, владелец 19.10.2026.
//
// Сдача шага = «работа зафиксирована». Два способа не зафиксировать её:
// оставить изменения незакоммиченными в копии карточки (следующий заход
// роли сделает свежий `git worktree add` и затопчет их) или сдать шаг, не
// сделав ни одного коммита поверх `main`. Оба случая ловит этот модуль.
//
// Гард молчит там, где проверять нечего: чужой проект (нет ветки
// `roles/<id>`), копии выключены (`TASKFLOW_ROLE_WORKTREES=off`) —
// требовать коммит там, где сервер не знает, как коммитить, значит
// давать ложный отказ.
import { inspectWorktree } from "./inspect.js";
import { liveRepo, worktreesDisabled, worktreePath } from "./paths.js";

export interface FinalizeOptions {
  base?: string;
  live?: string;
}

function shortList(files: string[], limit = 5): string {
  const shown = files.slice(0, limit).join(", ");
  return files.length > limit ? `${shown} и ещё ${files.length - limit}` : shown;
}

/**
 * Текст ошибки для сдачи шага, либо `null` — можно сдавать.
 * Раньше эту проверку делал `commitGuardError` из `roleCommitCheck.ts`;
 * он остаётся и зовёт этот модуль, чтобы старые вызовы и тесты жили.
 */
export function finalizeWorktreeError(taskId: string, options: FinalizeOptions = {}): string | null {
  if (worktreesDisabled()) return null;
  const live = options.live ?? liveRepo();
  const state = inspectWorktree(taskId, options.base ?? "main", live);
  // Ветки нет — работа в стороннем проекте либо карточка без серверного
  // бэкенда. Проверять нечего.
  if (!state.branch_exists) return null;

  if (state.worktree_exists && state.dirty.length > 0) {
    return (
      `перед сдачей шага зафиксируй изменения в рабочей копии ${worktreePath(taskId)}: ` +
      `незакоммичено ${state.dirty.length} (${shortList(state.dirty)}). ` +
      `Сделай коммит в этой копии и попробуй снова`
    );
  }
  if (state.ahead_count === 0) {
    return (
      `перед сдачей шага на ветке ${state.branch} должен быть коммит поверх main ` +
      `(сейчас ahead=0). Сделай коммит в рабочей копии ${worktreePath(taskId)} и попробуй снова`
    );
  }
  return null;
}

/** Бросает с текстом ошибки — для вызовов, где «нельзя» значит стоп. */
export function finalizeWorktree(taskId: string, options: FinalizeOptions = {}): void {
  const error = finalizeWorktreeError(taskId, options);
  if (error) throw new Error(error);
}
