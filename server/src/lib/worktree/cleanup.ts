// Уборка рабочих копий — только после подтверждённого слияния.
// LOCK-WORKTREE-MANAGER-20261019, владелец 19.10.2026.
//
// Три условия, иначе уборка не начинается:
//   1. слияние подтверждено (`tasks.merged_at`) — ветку с неслитой работой
//      удалять нельзя ни при каких настройках;
//   2. копия чистая — незакоммиченные изменения живут только здесь и
//      после удаления их больше нигде нет;
//   3. ветка слита в базу — `git branch -d` откажется сам, но мы и не
//      пытаемся, чтобы не оставлять половину убранного.
//
// Копии на удалённых машинах (Mac) убираются существующей операцией
// хоста `git_worktree remove` — новый протокол для этого не нужен.
import fs from "node:fs";
import path from "node:path";
import db from "../../db.js";
import { inspectWorktree } from "./inspect.js";
import { git, gitOrNull, liveRepo, roleBranch, worktreeExists, worktreePath, worktreesDisabled, worktreesBase } from "./paths.js";
import { cleanupRemoteWorktrees } from "./cleanupRemote.js";

export interface CleanupResult {
  task_id: string;
  removed_worktree: boolean;
  removed_branch: boolean;
  remote: Array<{ machine_id: string; removed: boolean; error?: string }>;
  skipped?: string;
}

export interface CleanupOptions {
  live?: string;
  base?: string;
  /** Явное «слияние было» вместо чтения `tasks.merged_at` (тесты). */
  mergedAt?: string | null;
  /** Пропустить уборку копий на удалённых машинах (тесты без машин). */
  skipRemote?: boolean;
  now?: string;
}

function mergedStamp(taskId: string, explicit?: string | null): string | null {
  if (explicit !== undefined) return explicit;
  try {
    const row = db.prepare("SELECT merged_at FROM tasks WHERE id = ?").get(taskId) as
      | { merged_at: string | null }
      | undefined;
    return row?.merged_at ?? null;
  } catch {
    return null;
  }
}

/**
 * Убрать копию и ветку карточки. Возвращает, что именно сделано и
 * почему ничего не сделано (`skipped`) — вызывающий пишет это в отчёт.
 */
export async function cleanupWorktree(taskId: string, options: CleanupOptions = {}): Promise<CleanupResult> {
  const live = options.live ?? liveRepo();
  const base = options.base ?? "main";
  const result: CleanupResult = {
    task_id: taskId,
    removed_worktree: false,
    removed_branch: false,
    remote: [],
  };
  if (worktreesDisabled()) return { ...result, skipped: "рабочие копии выключены" };

  const mergedAt = mergedStamp(taskId, options.mergedAt);
  if (!mergedAt) return { ...result, skipped: "слияние не подтверждено" };

  const state = inspectWorktree(taskId, base, live);
  if (state.dirty.length > 0) {
    return { ...result, skipped: `в копии есть незакоммиченное (${state.dirty.length})` };
  }
  if (state.branch_exists && !state.merged_into_base) {
    return { ...result, skipped: `ветка ${state.branch} не слита в ${base}` };
  }

  if (worktreeExists(taskId)) {
    const dir = worktreePath(taskId);
    try {
      git(live, ["worktree", "remove", "--force", dir]);
      result.removed_worktree = true;
    } catch {
      // Каталог мог остаться после обрыва — сносим и чистим реестр.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        gitOrNull(live, ["worktree", "prune"]);
        result.removed_worktree = true;
      } catch {
        return { ...result, skipped: `не удалось убрать копию ${dir}` };
      }
    }
  }
  gitOrNull(live, ["worktree", "prune"]);

  if (state.branch_exists) {
    try {
      git(live, ["branch", "-d", roleBranch(taskId)]);
      result.removed_branch = true;
    } catch {
      // Ветка не слита (проверили выше) или уже удалена — наша задача
      // не превращать это в шум.
      result.removed_branch = false;
    }
  }

  if (!options.skipRemote) result.remote = await cleanupRemoteWorktrees(taskId);

  const now = options.now ?? new Date().toISOString().slice(0, 19).replace("T", " ");
  try {
    db.prepare(
      "UPDATE tasks SET workspace_cleared_at = CASE WHEN ? = 1 THEN datetime('now') ELSE workspace_cleared_at END, " +
        "branch_cleared_at = CASE WHEN ? = 1 THEN datetime('now') ELSE branch_cleared_at END WHERE id = ?",
    ).run(result.removed_worktree ? 1 : 0, result.removed_branch ? 1 : 0, taskId);
  } catch {
    /* БД может быть ещё не мигрирована — уборка git не должна зависеть от БД */
  }
  void now;
  return result;
}

/**
 * Уборка каталогов, оставшихся от тестов и не являющихся копиями:
 * `iso-test-*` без `.git` внутри. Ничего чужого не трогаем — только
 * этот префикс и только без `.git`.
 */
export function sweepTestLeftovers(): number {
  if (worktreesDisabled()) return 0;
  const base = worktreesBase();
  if (!fs.existsSync(base)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(base)) {
    if (!entry.startsWith("iso-test-")) continue;
    const full = path.join(base, entry);
    if (fs.existsSync(path.join(full, ".git"))) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* занят кем-то — следующий проход */
    }
  }
  return removed;
}
