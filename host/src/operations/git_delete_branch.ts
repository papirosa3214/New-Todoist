import { execFile } from "node:child_process";
import { resolveWithin } from "../pathSafety.js";
import { BadArgsError, type Operation, optionalString, requireString } from "./types.js";

/**
 * Удаление ветки роли на хостах (решение владельца 10.11.2026).
 *
 * Зачем: ветку `roles/<карточка>` создаёт и пушит хост, а снимал её только
 * `cleanup.ts` на сервере и только локально (`skipRemote: true`). Поэтому на
 * GitHub и Gitea копились ветви: 10.11.2026 их было больше сотни. У iOS-проекта
 * рабочая папка живёт на маке, клона на .110 нет — закрыть его ветви сервер
 * может только через хост, эту операцию.
 *
 * Удаление идёт без `--force` и только когда вершина ветки уже достижима из
 * main на том же хосте: непереехавшая работа не пропадёт, ветка просто
 * останется и вернётся как `skipped` с причиной.
 */
export interface GitDeleteBranchResult {
  remote: string;
  branch: string;
  /** `deleted` — снята, `absent` — её уже нет, `skipped` — есть код вне main. */
  state: "deleted" | "absent" | "skipped" | "failed";
  detail?: string;
}

const BRANCH = /^[A-Za-z0-9._/-]{1,120}$/;
const REMOTE = /^[A-Za-z0-9._-]{1,40}$/;
const ЗАЩИЩЁННЫЕ = ["main", "master", "HEAD"];

const NET_TIMEOUT_MS = 120_000;

/**
 * git в репозитории мака. Ошибки сети и прав — не исключение для всей
 * операции, а результат по этому хосту: один недоступный remote не должен
 * отменять работу с остальными.
 */
function git(cwd: string, args: string[], timeoutMs = NET_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        // Интерактивных вопросов нет: некому отвечать, а повисший git держит
        // операцию до таймаута.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim().split("\n").slice(-2).join(" ")));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** Remote'ы репозитория, если список не задан явно. */
async function всеRemotes(repo: string): Promise<string[]> {
  const вывод = await git(repo, ["remote"]).catch(() => "");
  return вывод.split("\n").map((l) => l.trim()).filter(Boolean);
}

export interface GitDeleteBranchOutput {
  repo: string;
  branch: string;
  results: GitDeleteBranchResult[];
}

export const gitDeleteBranch: Operation = async (args, context) => {
  const repo = resolveWithin(context.roots, requireString(args, "repo"), {
    label: "git_delete_branch.repo",
  });
  const branch = requireString(args, "branch");
  if (!BRANCH.test(branch) || branch.includes("..")) {
    throw new BadArgsError(`«${branch}» не похоже на имя ветки`);
  }
  if (ЗАЩИЩЁННЫЕ.includes(branch)) {
    throw new BadArgsError(`«${branch}» не удаляется: это основная ветка`);
  }
  const main = optionalString(args, "main") ?? "main";
  if (!BRANCH.test(main)) throw new BadArgsError(`«${main}» не похоже на имя основной ветки`);

  const заявленные = args.remotes;
  let remotes: string[];
  if (Array.isArray(заявленные) && заявленные.length > 0) {
    remotes = заявленные.map((r) => String(r));
  } else if (typeof заявленные === "string" && заявленные.trim()) {
    remotes = [заявленные.trim()];
  } else {
    remotes = await всеRemotes(repo);
  }
  for (const remote of remotes) {
    if (!REMOTE.test(remote)) throw new BadArgsError(`«${remote}» не похоже на имя remote`);
  }

  const results: GitDeleteBranchResult[] = [];

  for (const remote of remotes) {
    const ответ = await git(repo, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]).catch(
      (err: unknown) => {
        const текст = err instanceof Error ? err.message : String(err);
        results.push({ remote, branch, state: "failed", detail: `ls-remote: ${текст}` });
        return null;
      },
    );
    if (ответ === null) continue;

    const вершина = ответ
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean)[0];
    if (!вершина) {
      results.push({ remote, branch, state: "absent" });
      continue;
    }

    // Что этот хост считает main. Обновление не обязано удаться: если связи
    // нет, работа ниже это заметит и вернёт отказ, а не «удалено».
    await git(repo, ["fetch", "--quiet", "--prune", remote]).catch(() => "");

    const основание = await git(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/${remote}/${main}`,
    ]).catch(() => "");

    // Ветка может быть на хосте, но ещё не приехать в локальные объекты —
    // забрать её отдельным ref, чтобы проверить достижимость из main.
    const local = await git(repo, ["cat-file", "-e", `${вершина}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (!local) {
      await git(repo, [
        "fetch",
        "--quiet",
        remote,
        `+refs/heads/${branch}:refs/taskflow-close/${branch}`,
      ]).catch(() => "");
    }

    let слита = false;
    if (основание) {
      слита = await git(repo, ["merge-base", "--is-ancestor", вершина, основание]).then(
        () => true,
        () => false,
      );
    }

    if (!слита) {
      results.push({
        remote,
        branch,
        state: "skipped",
        detail: основание
          ? `на ${remote} вершина ${вершина.slice(0, 8)} — есть коммиты, которых нет в ${main}; ветка не тронута`
          : `на ${remote} нет ветки ${main}; ветка не тронута`,
      });
      await git(repo, ["update-ref", "-d", `refs/taskflow-close/${branch}`]).catch(() => "");
      continue;
    }

    const удаление = await git(repo, ["push", "--quiet", remote, `:refs/heads/${branch}`]).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    await git(repo, ["update-ref", "-d", `refs/taskflow-close/${branch}`]).catch(() => "");
    await git(repo, ["fetch", "--quiet", "--prune", remote]).catch(() => "");

    if (удаление === null) {
      results.push({ remote, branch, state: "deleted" });
    } else {
      results.push({ remote, branch, state: "failed", detail: `push --delete: ${удаление}` });
    }
  }

  const output: GitDeleteBranchOutput = { repo, branch, results };
  return output;
};
