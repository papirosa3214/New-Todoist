import { execFile } from "node:child_process";
import { resolveWithin } from "../pathSafety.js";
import { BadArgsError, type Operation, optionalString, requireString } from "./types.js";

/**
 * Push ветки роли в общий gitea (остаток правки 12 плана taskflow-mac-host).
 *
 * Зачем: roleCommitCheck на .110 смотрит ветку `roles/<карточка>` в ЖИВОМ
 * репозитории сервера. Роль, работающая на маке, коммитит в worktree там — и
 * без пуша сервер не увидит её работу: проверка сдачи шага решит, что
 * коммитов нет, и отклонит закрытие. Молча, без ошибки у роли.
 *
 * Общий gitea уже есть (проверено 14.10.2026): и серверный репозиторий, и
 * iOS-репозиторий на маке смотрят в ssh://localhost:2222. Поэтому операция не
 * переносит код между машинами — она делает обычный push в тот же gitea,
 * после чего .110 подхватывает ветку следующим fetch.
 *
 * Имя remote берётся из аргумента, а не угадывается: у репозитория на маке их
 * минимум три (gitea, github, origin), и молчаливый выбор был бы источником
 * пушей не туда.
 */
export interface GitPushResult {
  repo: string;
  branch: string;
  remote: string;
  /** Ветка была уже на сервере и ничего не ушло. */
  unchanged: boolean;
  /** Сколько коммитов ушло. */
  pushed: number;
  /** Что ответил git — чтобы роль видела результат, а не догадывалась. */
  output: string;
}

const TASK_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,120}$/;
const REMOTE = /^[A-Za-z0-9._-]{1,40}$/;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message).trim().split("\n")[0] || error.message;
        reject(new BadArgsError(`git ${args.join(" ")}: ${detail}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export const gitPush: Operation = async (args, context) => {
  const repo = resolveWithin(context.roots, requireString(args, "repo"), { label: "git_push.repo" });
  const taskId = requireString(args, "taskId");
  if (!TASK_ID.test(taskId)) {
    throw new BadArgsError(`«${taskId}» не похоже на id карточки: ожидаются буквы, цифры, точка, дефис и подчёркивание`);
  }

  const branch = optionalString(args, "branch") ?? `roles/${taskId}`;
  if (!BRANCH.test(branch) || branch.includes("..")) throw new BadArgsError(`«${branch}» не похоже на имя ветки`);

  const remote = optionalString(args, "remote") ?? "gitea";
  if (!REMOTE.test(remote)) throw new BadArgsError(`«${remote}» не похоже на имя remote`);

  // Что уедет: только ветка роли, явным refspec. `git push remote --force` без
  // уточнения унёс бы на сервер всё, что накопилось локально, — а на маке
  // у репозитория есть ещё ветки, которые трогать нельзя.
  const refspec = `${branch}:refs/heads/${branch}`;

  // Сколько коммитов ушло.
  //
  // Считать приходится ДО пуша: после пуша ls-remote уже видит ветку, разница
  // с той же веткой даёт ноль. Первые два варианта были неверны по этой же
  // причине — и молча возвращали 0, то есть роль работала и получала в ответ
  // «ничего не отправлено».
  //
  // Опорная точка — то, что было в ДИСТАНТНЫХ refs до пуша: ветки может не
  // быть вовсе, и тогда уехала вся ветка целиком.
  const доПуша = await git(repo, ["ls-remote", "--heads", remote, `refs/heads/${branch}`])
    .catch(() => "");
  const был = доПуша.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)[0];

  // Все ДИСТАНТНЫЕ вершины — тоже ДО пуша. После пуша там появится и наша
  // ветка, и фильтр «что у нас есть, чего нет у них» выкинет всё, посчитав
  // ноль. Именно так и выходило: комментарий говорил «до пуша», а код брал
  // список после.
  const чужиеДо = await git(repo, ["ls-remote", "--heads", remote]).catch(() => "");
  const ихВершины = new Set(
    чужиеДо.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean),
  );

  let вывод: string;
  try {
    вывод = await git(repo, ["push", remote, refspec]);
  } catch (err) {
    // «Всё уже актуально» — это успех, а не отказ, иначе роль перепишет
    // работу вместо сдачи шага.
    const текст = err instanceof Error ? err.message : String(err);
    if (/Everything up-to-date|всё актуально/i.test(текст)) {
      return { repo, branch, remote, unchanged: true, pushed: 0, output: текст };
    }
    throw err;
  }

  let отправлено: number;
  if (был) {
    // Ветка в remote была: уехало то, что добавилось после её вершины.
    отправлено = await git(repo, ["rev-list", "--count", `${был}..${branch}`])
      .then((x) => Number(x) || 0)
      .catch(() => 0);
  } else {
    // Ветки в remote не было: уехало всё, чего нет ни в одной ветке ДИСТАНТА.
    // Их вершины забираем ДО пуша — после них уже нет, remote увидит и нашу.
    const наш = await git(repo, ["rev-list", branch]).then((x) => x.split("\n").filter(Boolean));
    отправлено = наш.filter((c) => !ихВершины.has(c)).length;
  }

  const ничего = отправлено === 0;

  return {
    repo,
    branch,
    remote,
    unchanged: ничего,
    pushed: отправлено,
    output: вывод,
  };
};

export const gitPushOpName = "git_push";