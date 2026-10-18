// Уборка копий карточки на удалённых машинах (Mac).
// LOCK-WORKTREE-MANAGER-20261019.
//
// Копию там создаёт операция хоста `git_worktree` (create) — она же
// умеет `remove`. Сервер раньше вызывал только create, поэтому копии на
// Mac оставались навсегда. Новый протокол не нужен: та же операция, тот
// же ключ `taskId`.
//
// Ошибки не поднимаем: уборка одной машины не должна ломать уборку
// остальных — неотвечающая машина просто остаётся в следующем проходе.
import { listMachines } from "../../host/machines.js";
import { isMachineOnline, runOperation } from "../../host/gateway.js";
import { hostRepoPath, roleBranch } from "../../runtime/roleWorkspace.js";

export interface RemoteCleanup {
  machine_id: string;
  machine_name: string;
  removed: boolean;
  error?: string;
}

/**
 * Снять копию карточки на всех машинах, где она заведена и машина
 * онлайн. Отсутствие копии — не ошибка: операция хоста вернёт
 * `changed: false`.
 */
export async function cleanupRemoteWorktrees(taskId: string): Promise<RemoteCleanup[]> {
  const out: RemoteCleanup[] = [];
  let machines: Array<{ id: string; name: string }> = [];
  try {
    machines = listMachines() as Array<{ id: string; name: string }>;
  } catch {
    return out;
  }
  for (const machine of machines) {
    if (!isMachineOnline(machine.id)) continue;
    let repo: string | null;
    try {
      repo = hostRepoPath(taskId, machine.id);
    } catch {
      continue;
    }
    if (!repo) continue;
    try {
      const result = (await runOperation(machine.id, "git_worktree", {
        action: "remove",
        repo,
        taskId,
        branch: roleBranch(taskId),
      })) as { ok?: boolean; error?: unknown; data?: { changed?: boolean }; stdout?: string };
      if (result?.ok === false) {
        out.push({ machine_id: machine.id, machine_name: machine.name, removed: false, error: String(result.error ?? "без текста") });
        continue;
      }
      const changed = result?.data?.changed ?? false;
      out.push({ machine_id: machine.id, machine_name: machine.name, removed: changed });
    } catch (error) {
      out.push({
        machine_id: machine.id,
        machine_name: machine.name,
        removed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}
