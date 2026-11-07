// Инспектор рабочей копии карточки: один снимок «что сейчас в git».
// LOCK-WORKTREE-MANAGER-20261019.
//
// Один вызов — один честный ответ на вопрос «можно ли это сливать».
// Раньше эти факты собирались тремя разными способами (roleCommitCheck,
// merge-marker, ручной git в логах) и расходились; здесь одна чистая
// функция без исключений: отсутствие ветки — это нули, а не падение.
import { dirtyFiles, gitOrNull, liveRepo, refExists, roleBranch, worktreeExists, worktreePath } from "./paths.js";

export interface WorktreeInspection {
  task_id: string;
  branch: string;
  /** Ветка `roles/<taskId>` есть в репозитории. */
  branch_exists: boolean;
  worktree_path: string;
  /** Каталог копии есть на диске. */
  worktree_exists: boolean;
  /** Незакоммиченные изменения: пусто — копия чистая. */
  dirty: string[];
  /** Сколько коммитов поверх `base`. */
  ahead_count: number;
  /** Насколько ветка отстала от `base`. */
  behind_count: number;
  tip: string | null;
  base_tip: string | null;
  /** Ветка уже влита в `base` (содержательно — её коммиты в базе). */
  merged_into_base: boolean;
  last_commit_at: string | null;
}

/**
 * Снимок состояния ветки и копии карточки. Ничего не меняет и не падает:
 * отсутствие репозитория/ветки/копии — это нули в ответе.
 */
export function inspectWorktree(
  taskId: string,
  base: string = "main",
  live: string = liveRepo(),
): WorktreeInspection {
  const branch = roleBranch(taskId);
  const empty: WorktreeInspection = {
    task_id: taskId,
    branch,
    branch_exists: false,
    worktree_path: worktreePath(taskId),
    worktree_exists: false,
    dirty: [],
    ahead_count: 0,
    behind_count: 0,
    tip: null,
    base_tip: null,
    merged_into_base: false,
    last_commit_at: null,
  };
  if (!refExists(live, "HEAD")) return empty;

  const baseExists = refExists(live, `refs/heads/${base}`);
  const baseTip = baseExists ? gitOrNull(live, ["rev-parse", `refs/heads/${base}`]) : null;
  const branchExists = refExists(live, `refs/heads/${branch}`);
  if (!branchExists) return { ...empty, base_tip: baseTip };

  const tip = gitOrNull(live, ["rev-parse", `refs/heads/${branch}`]);
  const ahead = tip && baseTip ? Number(gitOrNull(live, ["rev-list", "--count", `${baseTip}..${tip}`]) ?? 0) : 0;
  const behind = tip && baseTip ? Number(gitOrNull(live, ["rev-list", "--count", `${tip}..${baseTip}`]) ?? 0) : 0;
  // `merge-base --is-ancestor` молчит: код 0 — ветка внутри базы, есть
  // что сливать не нужно (или всё уже слито).
  const merged = tip && baseTip ? gitOrNull(live, ["merge-base", "--is-ancestor", tip, baseTip]) !== null : false;

  const copy = worktreeExists(taskId);
  return {
    task_id: taskId,
    branch,
    branch_exists: true,
    worktree_path: worktreePath(taskId),
    worktree_exists: copy,
    dirty: copy ? dirtyFiles(worktreePath(taskId)) : [],
    ahead_count: Number.isFinite(ahead) ? ahead : 0,
    behind_count: Number.isFinite(behind) ? behind : 0,
    tip,
    base_tip: baseTip,
    merged_into_base: merged,
    last_commit_at: gitOrNull(live, ["log", "-1", "--format=%ci", `refs/heads/${branch}`]),
  };
}
