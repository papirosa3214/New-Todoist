import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveWithin } from "../pathSafety.js";
import { BadArgsError, type Operation, optionalString, requireString } from "./types.js";

/**
 * Worktree для роли на маке (D6a). Логика списана с server/src/runtime/roleWorkspace.ts:
 * ветка `roles/<карточка>`, база `worktreesBase()`, переиспользование уже
 * заведённой копии. Отличие одно — на маке это Swift-репозиторий, поэтому
 * подстановка node_modules из живой копии не нужна.
 */
export interface GitWorktreeResult {
  action: "create" | "remove";
  repo: string;
  path: string;
  branch: string;
  /** create: копия была уже заведена и переиспользована. remove: её не было. */
  changed: boolean;
}

const TASK_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,120}$/;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message).trim().split("\n")[0] || error.message;
        reject(new BadArgsError(`git ${args.join(" ")}: ${detail}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** Ветка рабочей копии карточки — тот же вид, что roleBranch() на .110. */
export function roleBranch(taskId: string): string {
  return `roles/${taskId}`;
}

export const gitWorktree: Operation = async (args, context) => {
  const action = requireString(args, "action");
  if (action !== "create" && action !== "remove") throw new BadArgsError("«action» может быть create или remove");
  const repo = resolveWithin(context.roots, requireString(args, "repo"), { label: "git_worktree.repo" });
  const taskId = requireString(args, "taskId");
  if (!TASK_ID.test(taskId)) throw new BadArgsError(`«${taskId}» не похоже на id карточки: ожидаются буквы, цифры, точка, дефис и подчёркивание`);

  const branch = optionalString(args, "branch") ?? roleBranch(taskId);
  if (!BRANCH.test(branch) || branch.includes("..")) throw new BadArgsError(`«${branch}» не похоже на имя ветки`);

  // База может лежать вне корня (например, в ~/.local) — но только если её
  // разрешил конфиг: иначе роль вынесла бы worktree куда угодно.
  const dir = resolveWithin([context.worktreesBase, ...context.roots], path.join(context.worktreesBase, taskId), { label: "git_worktree.dir" });

  if (action === "remove") {
    if (!fs.existsSync(dir)) return { action, repo, path: dir, branch, changed: false };
    await git(repo, ["worktree", "remove", "--force", dir]);
    await git(repo, ["worktree", "prune"]).catch(() => {});
    return { action, repo, path: dir, branch, changed: true };
  }

  if (fs.existsSync(path.join(dir, ".git"))) {
    return { action, repo, path: dir, branch, changed: false };
  }

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo, ["worktree", "prune"]).catch(() => {});
  const hasBranch = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false);
  // Ветки может ещё не быть (первый заход роли) — тогда создаём её от HEAD.
  await git(repo, hasBranch ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, "HEAD"]);

  return { action, repo, path: dir, branch, changed: true };
};

/** Имя операции в протоколе — без подчёркивания имя файла, как в остальном списке. */
export const gitWorktreeOpName = "git_worktree";