// MAK-70: проверка коммита на ветке `roles/<taskId>` при сдаче шага.
//
// Логика (владелец 01.10.2026, карточка T05):
//   1. Шаг закрывает агент (вызов `taskflow_subtask_done`, на сервере
//      PATCH /api/subtasks/:id с done=true) — это последнее рукопожатие
//      перед сдачей результата.
//   2. Если на ветке `roles/<id>` есть хотя бы один коммит, не
//      присутствующий в main — шаг принимается: работа зафиксирована в
//      git, владелец её увидит при вливании.
//   3. Если ветки нет или коммитов поверх main нет — закрытие шага
//      отклоняется с понятной ошибкой. Иначе роль «делает что-то», но
//      по факту работа нигде: ни в git, ни в diff для владельца.
//
// `liveRepo` берётся из `roleWorkspace.liveServerRepo()` — это корень
// репозитория, в котором запущен сам сервер. Карточка, чей `repo` —
// сторонний проект, проверки не проходит: сервер не знает, как туда
// стучаться (ветка может называться по-другому, или git может быть
// вообще не нужен — например, работа в `src/` без бэкенда).
//
// Возвращаем `null` — коммиты есть, шаг можно закрывать. Иначе строка с
// причиной для 400-ответа, чтобы агент понял, что именно не так и не
// гадал.
import { execFileSync } from "node:child_process";
import { liveServerRepo } from "../runtime/roleWorkspace.js";

export interface CommitCheckResult {
  hasCommits: boolean;
  branchExists: boolean;
  aheadCount: number;
  branchTip: string | null;
  baseTip: string | null;
}

/** Тихая обёртка над `git -C liveRepo ...`. Пустые stdout/stderr → null. */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Проверить, есть ли на ветке `roles/<taskId>` хотя бы один коммит
 * поверх main. Возврат — структура с диагностикой; UI/логирование
 * может её показать, для гарда достаточно `hasCommits`.
 *
 * `base` по умолчанию `main`. Если у карточки собственная база
 * (форк/feature-ветка для слияния) — параметр можно будет расширить.
 */
export function inspectRoleBranch(
  taskId: string,
  base: string = "main",
  live: string = process.env.MAK70_LIVE_REPO || liveServerRepo(),
): CommitCheckResult {
  const branch = `roles/${taskId}`;
  const branchExists = git(live, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null;
  const baseExists = git(live, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`]) !== null;
  if (!branchExists || !baseExists) {
    return { hasCommits: false, branchExists, aheadCount: 0, branchTip: null, baseTip: null };
  }
  const branchTip = git(live, ["rev-parse", `refs/heads/${branch}`]);
  const baseTip = git(live, ["rev-parse", `refs/heads/${base}`]);
  const aheadRaw = git(live, ["rev-list", "--count", `${baseTip}..${branchTip}`]);
  const aheadCount = aheadRaw ? Number(aheadRaw) || 0 : 0;
  return {
    hasCommits: aheadCount > 0,
    branchExists,
    aheadCount,
    branchTip,
    baseTip,
  };
}

/**
 * Текст ошибки для гарда в subtask_done. Возвращает `null`, если коммит
 * есть — закрытие шага можно пропустить.
 *
 * Гард срабатывает только когда ветка `roles/<id>` уже создана. Если
 * ветки нет — значит роль работает в стороннем проекте (где у сервера
 * нет ни своего репо, ни права проверять), либо это карточка без
 * серверного бэкенда вообще. Тогда требовать коммит бессмысленно, и
 * гард молча пропускает шаг.
 *
 * Тестовая подмена: переменная `MAK70_LIVE_REPO` (если задана) подменяет
 * `liveServerRepo()` — нужно, чтобы тест мог смотреть на временный
 * репозиторий, а не на боевой.
 */
export function commitGuardError(taskId: string, live: string = process.env.MAK70_LIVE_REPO || liveServerRepo()): string | null {
  const check = inspectRoleBranch(taskId, "main", live);
  if (check.hasCommits) return null;
  if (!check.branchExists) return null;
  return (
    `перед сдачей шага на ветке roles/${taskId} должен быть коммит поверх main ` +
    `(сейчас ahead=${check.aheadCount}). Сделай коммит в рабочей копии ` +
    `~/.local/state/taskflow-runs/worktrees/${taskId} и попробуй снова`
  );
}
