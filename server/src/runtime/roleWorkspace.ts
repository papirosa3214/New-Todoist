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
//
// Правка 3 плана taskflow-mac-host (14.10.2026): роль может быть назначена на
// удалённую машину. Мозг роли остаётся на .110 — уезжает только папка с кодом.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOperation } from "../host/gateway.js";
import { isMachineOnline, resolveMachine } from "../host/gateway.js";
import db from "../db.js";

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

/** Пути репозиториев по машинам: server/scripts/task-context-hosts.json. */
export const HOSTS_CONFIG = path.join(process.cwd(), "scripts", "task-context-hosts.json");

/** Путь репозитория проекта НА МАШИНЕ machineId, или null если не заведён. */
export function hostRepoPath(taskId: string, machineId: string): string | null {
  let проект: string;
  try {
    const row = db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as
      | { project_id?: string | null }
      | undefined;
    проект = row?.project_id ?? "";
  } catch {
    return null;
  }
  try {
    const карта: Record<string, Record<string, string>> =
      JSON.parse(fs.readFileSync(HOSTS_CONFIG, "utf8")).projects ?? {};
    const найденный = карта[machineId]?.[проект];
    return typeof найденный === "string" ? найденный : null;
  } catch {
    return null;
  }
}

/**
 * Рабочая папка роли на удалённой машине.
 *
 * Ровно одна операция: создать worktree на той машине и вернуть путь К НЕЙ.
 * Проверки пути, лимиты и имя ветки уже умеет операция git_worktree хоста —
 * копировать её в сервер незачем.
 *
 * Ошибки не проглатываются. Машина назначена, но офлайн или отозвана — это
 * внятный отказ, а не тихий возврат на .110: тихий возврат означал бы, что
 * роль отчитается о работе в папке, которую никто не откроет.
 */
export async function remoteRoleWorkspace(
  machineId: string,
  repo: string,
  taskId: string,
): Promise<string> {
  const машина = resolveMachine(machineId);
  if (!машина) throw new Error(`роль назначена на машину, которой нет в реестре: ${machineId}`);
  if (машина.revoked_at) throw new Error(`ключ машины «${машина.name}» отозван`);
  if (!isMachineOnline(машина.id)) {
    throw new Error(`машина «${машина.name}» сейчас офлайн — подключите её и повторите`);
  }

  // Путь репозитория берём из настройки машин; если её нет — падаем словами,
  // а не подставляем серверный путь: путь на .110 для хоста не значит ничего.
  const путьНаМаке = hostRepoPath(taskId, машина.id);
  if (!путьНаМаке) {
    throw new Error(
      `для машины «${машина.name}» не заведён репозиторий проекта (${HOSTS_CONFIG})`,
    );
  }

  // Имя действия — из протокола хоста (host/src/operations/git_worktree.ts):
  // create | remove. С «add» хост отказывал, но до 16.10.2026 это не всплывало:
  // инструменты роли к хосту подключены не были (см. inProcessRun.ts).
  const результат = await runOperation(машина.id, "git_worktree", {
    action: "create",
    repo: путьНаМаке,
    taskId,
    branch: roleBranch(taskId),
  });

  // Путь работы приходит в stdout: отдельного поля data в протоколе нет
  // (проверено по OpResultMessage в protocol.ts) — операция отдаёт результат
  // как JSON-строку.
  // Не-bash операции хоста отдают результат в data (так же читает
  // hostOperations.ts); stdout — запасной путь для старого хоста.
  const отказ = результат as { ok?: boolean; error?: unknown };
  if (отказ.ok === false) {
    throw new Error(`хост «${машина.name}» не создал рабочую копию: ${String(отказ.error ?? "без текста")}`);
  }
  const данные = (результат as { data?: { path?: string } }).data;
  if (данные?.path) return данные.path;
  const сырое = ((результат as { stdout?: string }).stdout ?? "").trim();
  if (!сырое) {
    throw new Error(`хост не вернул путь рабочей копии для машины «${машина.name}»`);
  }
  const путь = (JSON.parse(сырое) as { path?: string }).path;
  if (!путь) {
    throw new Error(
      `хост вернул неожиданный ответ для машины «${машина.name}»: ${сырое.slice(0, 120)}`,
    );
  }
  return путь;
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