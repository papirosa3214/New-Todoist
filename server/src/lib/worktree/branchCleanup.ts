// Закрытие ветки роли на хостах после подтверждённого слияния.
// Владелец 10.11.2026: «сервер сам закрывает ветку, когда роль закончила работу».
//
// Ветку создаёт хост (`git_worktree`), роль пушит её в общий remote
// (`git_push`) — и дальше её никто не убирал: `cleanup.ts` снимает только
// рабочую копию и локальную ветку, а на GitHub и Gitea за месяцы накопилась
// сотня веток `roles/*`. Здесь убирается вторая половина — ветка на хостах.
//
// Правила те же, что у отправки main (`pushHosts.ts`):
//   — трогаем только слитую ветку: вершина на хосте обязана быть достижима из
//     main, иначе работа исчезла бы вместе с веткой;
//   — никакого `--force`: хост не пустил — пишем причину, ветку не трогаем;
//   — два remote с одним адресом — один хост (`uniqueRemotes`).
//
// Модуль знает только git и журнал: решение «пора ли» принимает очередь
// слияния и обход в `runtime/worktreeMergeQueue.ts`.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { uniqueRemotes } from "./pushHosts.js";
import { worktreesBase } from "./paths.js";

const NET_TIMEOUT_MS = 120_000;
/** Сколько записей журнала держим: он для глаза, а не для истории навсегда. */
const JOURNAL_KEEP = 200;

export type BranchCloseState = "deleted" | "absent" | "skipped" | "failed";

export interface BranchCloseResult {
  remote: string;
  branch: string;
  state: BranchCloseState;
  detail?: string;
}

export interface BranchCleanupEntry {
  at: string;
  branch: string;
  results: BranchCloseResult[];
}

export interface BranchCleanupStatus {
  updated_at: string;
  entries: BranchCleanupEntry[];
}

function run(cwd: string, args: string[], timeoutMs = NET_TIMEOUT_MS): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND:
        process.env.GIT_SSH_COMMAND ||
        "ssh -o BatchMode=yes -o ConnectTimeout=15",
    },
  }).trim();
}

function reason(error: unknown): string {
  const e = error as { stderr?: string; message?: string };
  const text = String(e.stderr || e.message || error).trim();
  return text.split("\n").filter(Boolean).slice(-2).join("; ").slice(0, 300);
}

function isAncestor(cwd: string, older: string, newer: string): boolean {
  try {
    run(cwd, ["merge-base", "--is-ancestor", older, newer]);
    return true;
  } catch {
    return false;
  }
}

/** Вершина ветки на хосте или `null`, если ветки там нет. */
function hostTip(cwd: string, remote: string, branch: string): string | null {
  const out = run(cwd, [
    "ls-remote",
    "--heads",
    remote,
    `refs/heads/${branch}`,
  ]);
  const line = out.split("\n").find(Boolean);
  return line ? line.split("\t")[0] : null;
}

function hasObject(cwd: string, sha: string): boolean {
  try {
    run(cwd, ["cat-file", "-e", `${sha}^{commit}`], 15_000);
    return true;
  } catch {
    return false;
  }
}

/** Скачать вершину с хоста во временную ссылку, не трогая локальные ветки. */
function probeRef(branch: string): string {
  return `refs/taskflow-close/${branch}`;
}

function closeOnHost(
  cwd: string,
  remote: string,
  branch: string,
  main: string,
): BranchCloseResult {
  const base = { remote, branch };
  let tip: string | null;
  try {
    tip = hostTip(cwd, remote, branch);
  } catch (error) {
    return { ...base, state: "failed", detail: reason(error) };
  }
  if (!tip) return { ...base, state: "absent" };

  // Коммит с хоста может быть ещё не скачан: без объекта проверка «слита ли»
  // ответила бы «нет» по незнанию, и ветка осталась бы навсегда.
  if (!hasObject(cwd, tip)) {
    try {
      run(cwd, [
        "fetch",
        "--quiet",
        remote,
        `+refs/heads/${branch}:${probeRef(branch)}`,
      ]);
    } catch {
      /* проверим тем, что есть локально */
    }
  }
  if (!isAncestor(cwd, tip, main)) {
    return {
      ...base,
      state: "skipped",
      detail: `на хосте ${tip.slice(0, 9)} — есть коммиты, которых нет в main; ветка не тронута`,
    };
  }

  try {
    run(cwd, ["push", "--quiet", remote, `:refs/heads/${branch}`]);
  } catch (error) {
    return { ...base, state: "failed", detail: reason(error) };
  }
  try {
    run(cwd, ["update-ref", "-d", probeRef(branch)], 15_000);
  } catch {
    /* временная ссылка не мешает: имя вне refs/heads */
  }
  return { ...base, state: "deleted" };
}

/**
 * Снять ветку роли со всех хостов. Отказ одного хоста не мешает остальным;
 * пустой список — значит remote не настроен, и это видно вызывающему.
 */
export function closeRoleBranchOnHosts(
  cwd: string,
  branch: string,
  options: { main?: string; remotes?: string[] } = {},
): BranchCloseResult[] {
  const main = options.main ?? "main";
  const remotes = options.remotes ?? uniqueRemotes(cwd);
  const results = remotes.map((remote) => {
    const result = closeOnHost(cwd, remote, branch, main);
    if (result.state === "deleted") {
      try {
        run(cwd, ["fetch", "--prune", "--quiet", remote]);
      } catch {
        /* ссылки-слежения догонят следующим проходом */
      }
    }
    return result;
  });
  journal(branch, results);
  return results;
}

/** Все хосты отпустили ветку: удалили или её там и не было. */
export function branchClosedEverywhere(results: BranchCloseResult[]): boolean {
  return results.length > 0 && results.every((row) => row.state === "deleted" || row.state === "absent");
}

function statusFile(): string {
  return path.join(worktreesBase(), "branch-cleanup.json");
}

export function loadBranchCleanup(): BranchCleanupStatus | null {
  try {
    return JSON.parse(fs.readFileSync(statusFile(), "utf8")) as BranchCleanupStatus;
  } catch {
    return null;
  }
}

function journal(branch: string, results: BranchCloseResult[]): void {
  const previous = loadBranchCleanup();
  const entries = [...(previous?.entries ?? []), {
    at: new Date().toISOString(),
    branch,
    results,
  }].slice(-JOURNAL_KEEP);
  const status: BranchCleanupStatus = {
    updated_at: new Date().toISOString(),
    entries,
  };
  try {
    fs.mkdirSync(worktreesBase(), { recursive: true });
    fs.writeFileSync(statusFile(), JSON.stringify(status, null, 2));
  } catch {
    /* без журнала ветка всё равно закрыта — это только для глаза */
  }
}
