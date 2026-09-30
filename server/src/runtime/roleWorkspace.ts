// Отдельная рабочая копия для роли, которая работает в репозитории самого
// сервера (владелец 01.10.2026, карточка T05).
//
// Сервер на .110 запущен как `tsx watch`: любое сохранение его исходника
// перезапускает процесс. Роли работают ВНУТРИ этого процесса — Разработчик
// сохранил server/src/migrations.ts в живой копии и тем самым оборвал свой
// же ход. Поэтому роль, у которой рабочая папка — репозиторий этого же
// сервера, получает git worktree на карточку: правит там, живой сервер не
// трогает. Все роли одной карточки работают в одной копии — QA и Критик
// видят то, что сделал Разработчик. В живой сервер изменения попадают
// обычным путём: коммит/слияние ветки `roles/<карточка>` владельцем.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Корень репозитория, из которого запущен сам сервер (`server/` — его cwd). */
export function liveServerRepo(): string {
  return path.resolve(process.cwd(), "..");
}

function worktreesBase(): string {
  return (
    process.env.TASKFLOW_ROLE_WORKTREES ||
    path.join(os.homedir(), ".local", "state", "taskflow-runs", "worktrees")
  );
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 60_000 }).trim();
}

function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** Ветка рабочей копии карточки. */
export function roleBranch(taskId: string): string {
  return `roles/${taskId}`;
}

/**
 * Рабочая папка роли. Чужой проект — как есть; репозиторий самого сервера —
 * отдельная worktree карточки (создаётся при первом запуске, потом
 * переиспользуется). Не удалось завести копию — ошибка, а не тихий откат в
 * живую папку: иначе роль снова уронит сервер.
 */
export function roleWorkspace(taskId: string, repo: string, live: string = liveServerRepo()): string {
  // "off" — без отдельных копий (прогон тестов: test/setup.ts).
  if (process.env.TASKFLOW_ROLE_WORKTREES === "off") return repo;
  if (!sameDir(repo, live)) return repo;
  const dir = path.join(worktreesBase(), taskId);
  if (fs.existsSync(path.join(dir, ".git"))) return dir;

  fs.mkdirSync(worktreesBase(), { recursive: true });
  const branch = roleBranch(taskId);
  let hasBranch = true;
  try {
    git(live, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch {
    hasBranch = false;
  }
  try {
    git(live, ["worktree", "prune"]);
    git(live, hasBranch ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, "HEAD"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`не удалось завести отдельную копию репозитория для роли: ${reason}`);
  }
  // Зависимости не ставим заново: ссылки на уже установленные в живой копии,
  // чтобы роль могла гонять тесты и typecheck.
  for (const rel of ["node_modules", path.join("server", "node_modules")]) {
    const source = path.join(live, rel);
    const target = path.join(dir, rel);
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      fs.symlinkSync(source, target, "dir");
    }
  }
  return dir;
}
