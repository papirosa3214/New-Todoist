// Общие пути и git-обёртки для рабочих копий карточек.
// LOCK-WORKTREE-MANAGER-20261019, владелец 19.10.2026.
//
// Здесь только механика: где лежат копии, как называется ветка карточки и
// как тихо спросить git. Никакой политики — решение «можно ли сливать»
// принимает `inspect.ts` и очередь слияния.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Корень репозитория сервера: `server/` — его cwd, значит корень на
 * уровень выше. Не читает переменные окружения — «боевой» путь,
 * подменяемый для тестов, это `liveRepo()`.
 */
export function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

/**
 * Репозиторий, в котором смотрят ветки ролей. `MAK70_LIVE_REPO`
 * подменяет его — этим же переключателем пользуются существующие тесты
 * (см. `test/roleWorkspace.test.ts`).
 */
export function liveRepo(): string {
  return process.env.MAK70_LIVE_REPO || repoRoot();
}

/**
 * Корень рабочих копий. `TASKFLOW_ROLE_WORKTREES=off` — копии не
 * заводятся вовсе (тестовый прогон сервера).
 */
export function worktreesBase(): string {
  return (
    process.env.TASKFLOW_ROLE_WORKTREES ||
    path.join(os.homedir(), ".local", "state", "taskflow-runs", "worktrees")
  );
}

export function worktreesDisabled(): boolean {
  return process.env.TASKFLOW_ROLE_WORKTREES === "off";
}

export function worktreePath(taskId: string): string {
  return path.join(worktreesBase(), taskId);
}

export function worktreeExists(taskId: string): boolean {
  return fs.existsSync(path.join(worktreePath(taskId), ".git"));
}

/** Ветка рабочей копии карточки. */
export function roleBranch(taskId: string): string {
  return `roles/${taskId}`;
}

/** Ошибка git с выводом команды: «почему не вышло» должно быть видно. */
export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stdout: string,
    readonly stderr: string,
  ) {
    const detail = (stderr || stdout || "без вывода").trim().split("\n").slice(0, 4).join("; ");
    super(`git ${args.join(" ")} — ${detail}`);
    this.name = "GitError";
  }
}

/** Тихий git для чтения: null вместо исключения. */
export function gitOrNull(cwd: string, args: string[], timeoutMs = 60_000): string | null {
  try {
    return git(cwd, args, timeoutMs);
  } catch {
    return null;
  }
}

/** Git, который падает с внятной причиной. Для операций записи. */
export function git(cwd: string, args: string[], timeoutMs = 60_000): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    throw new GitError(args, String(e.stdout ?? ""), String(e.stderr ?? ""));
  }
}

export function refExists(cwd: string, ref: string): boolean {
  return gitOrNull(cwd, ["rev-parse", "--verify", "--quiet", ref]) !== null;
}

/** Список незакоммиченных изменений (пустой массив — копия чистая). */
export function dirtyFiles(cwd: string): string[] {
  const out = gitOrNull(cwd, ["status", "--porcelain"], 120_000);
  if (!out) return [];
  return out.split("\n").filter(Boolean);
}

/**
 * Симлинки `node_modules` из живой копии — чтобы в копии карточки (и во
 * временной копии слияния) тесты и typecheck шли на тех же пакетах, что
 * и у живого сервера. Ровно то же, что делает `roleWorkspace.ts`.
 */
export function linkNodeModules(target: string, live: string): void {
  for (const rel of ["node_modules", path.join("server", "node_modules")]) {
    const source = path.join(live, rel);
    const link = path.join(target, rel);
    if (!fs.existsSync(source) || fs.existsSync(link)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(source, link, "dir");
  }
}

/** Рекурсивный размер папки в МБ. Только для отчётов, не на горячем пути. */
export function directorySizeMb(dir: string): number {
  let total = 0;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // Симлинки (в том числе node_modules) не идём: размер считается
      // один раз в живой копии, иначе диск будет посчитан дважды.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* файл исчез между readdir и stat — не важно для оценки */
        }
      }
    }
  };
  walk(dir);
  return Math.round(total / (1024 * 1024));
}
