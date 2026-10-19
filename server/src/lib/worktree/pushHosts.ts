// Отправка main во все git-хосты после автослияния (владелец 19.10.2026:
// «только fast-forward, с бэкапом, отказ — в журнал и сторожу»).
// LOCK-WORKTREE-MANAGER-20261019.
//
// Автослияние двигает только локальный main на .110. Здесь он уезжает на
// каждый remote живого репозитория (Gitea, GitHub, …). Правила те же, что у
// ручного `infra-ops/git-sync/git-sync.sh`:
// - никакого --force: на хосте есть коммиты, которых нет у нас, — отказ,
//   хост не трогаем, разбирает ответственный за интеграцию;
// - перед записью вершина хоста кладётся в ветку-бэкап;
// - два remote с одним адресом — один хост.
// Итог последнего прохода лежит в `push-status.json` — его читает сторож
// автослияния (`worktreeMergeWatcher.ts`).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { worktreesBase } from "./paths.js";

const NET_TIMEOUT_MS = 120_000;
const BRANCH = "main";

export type HostPushState = "pushed" | "in_sync" | "diverged" | "failed";

export interface HostPushResult {
  remote: string;
  state: HostPushState;
  detail?: string;
  backup?: string;
}

export interface PushStatus {
  at: string;
  main_sha: string;
  results: HostPushResult[];
}

/** git для сетевых операций: без вопросов о пароле и с пределом по времени. */
function run(cwd: string, args: string[], timeoutMs = 60_000): string {
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

/** Remotes репозитория без дублей по адресу (порядок — как в git remote). */
export function uniqueRemotes(cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const remote of run(cwd, ["remote"]).split("\n").filter(Boolean)) {
    const url = run(cwd, ["remote", "get-url", remote])
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(remote);
  }
  return out;
}

export function pushToHost(
  cwd: string,
  remote: string,
  stamp: string,
): HostPushResult {
  try {
    run(cwd, ["fetch", "--quiet", remote, BRANCH], NET_TIMEOUT_MS);
  } catch (error) {
    const text = reason(error);
    // Пустой хост: ветки ещё нет — первая отправка без бэкапа.
    if (
      !/couldn't find remote ref|не удалось найти внешнюю ссылку/i.test(text)
    ) {
      return { remote, state: "failed", detail: `fetch: ${text}` };
    }
  }
  const local = run(cwd, ["rev-parse", BRANCH]);
  const tracking = `refs/remotes/${remote}/${BRANCH}`;
  let hostTip: string | null = null;
  try {
    hostTip = run(cwd, ["rev-parse", "--verify", "--quiet", tracking]);
  } catch {
    hostTip = null;
  }
  if (hostTip === local) return { remote, state: "in_sync" };
  if (hostTip && !isAncestor(cwd, hostTip, local)) {
    return {
      remote,
      state: "diverged",
      detail: `на хосте ${hostTip.slice(0, 9)} — есть коммиты, которых нет в main; хост не тронут`,
    };
  }
  let backup: string | undefined;
  if (hostTip) {
    backup = `backup-${remote}-${BRANCH}-${stamp}`;
    try {
      run(
        cwd,
        ["push", "--quiet", remote, `${hostTip}:refs/heads/${backup}`],
        NET_TIMEOUT_MS,
      );
    } catch (error) {
      // Без бэкапа запись не делаем: он и превращает необратимое в обратимое.
      return {
        remote,
        state: "failed",
        detail: `бэкап не создан: ${reason(error)}`,
      };
    }
  }
  try {
    run(
      cwd,
      ["push", "--quiet", remote, `${BRANCH}:refs/heads/${BRANCH}`],
      NET_TIMEOUT_MS,
    );
  } catch (error) {
    return { remote, state: "failed", detail: reason(error), backup };
  }
  return { remote, state: "pushed", backup };
}

function statusFile(): string {
  return path.join(worktreesBase(), "push-status.json");
}

export function loadPushStatus(): PushStatus | null {
  try {
    return JSON.parse(fs.readFileSync(statusFile(), "utf8")) as PushStatus;
  } catch {
    return null;
  }
}

/** Отправить main во все хосты и записать итог для сторожа. */
export function pushMainToHosts(cwd: string): PushStatus {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
  let results: HostPushResult[];
  try {
    results = uniqueRemotes(cwd).map((remote) =>
      pushToHost(cwd, remote, stamp),
    );
  } catch (error) {
    results = [{ remote: "*", state: "failed", detail: reason(error) }];
  }
  const status: PushStatus = {
    at: new Date().toISOString(),
    main_sha: (() => {
      try {
        return run(cwd, ["rev-parse", BRANCH]);
      } catch {
        return "";
      }
    })(),
    results,
  };
  try {
    fs.mkdirSync(worktreesBase(), { recursive: true });
    fs.writeFileSync(statusFile(), JSON.stringify(status, null, 2));
  } catch {
    /* без файла сторож увидит устаревший статус — это тоже сигнал */
  }
  return status;
}
