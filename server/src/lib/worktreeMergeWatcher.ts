// Сторож автослияния (LOCK-WORKTREE-MANAGER-20261019, владелец 19.10.2026).
//
// Очередь слияния живёт сама: результат принят → копия → merge → тесты →
// fast-forward main → уборка. Ломается она тихо: строка висит в `queued`,
// main грязный от чужих правок — и
// ни одна карточка больше не вливается, а снаружи это выглядит как «просто
// ничего не происходит».
//
// Проверка — пробным ходом по тем местам, куда прибор пишет и откуда
// читает (строка очереди в БД, каталог копий, git живого репозитория),
// плюс сверка «давно ли очередь двигалась». Пока всё хорошо — молчит.
// Сломалось — уведомление в «Состояние системы», не чаще раза в сутки.

import fs from "node:fs";
import path from "node:path";

import db from "../db.js";
import { getSetting } from "./serverSettings.js";
import { raiseIncident, incidentRaisedRecently } from "./incidents.js";
import { loadPushStatus } from "./worktree/pushHosts.js";
import { loadBranchCleanup } from "./worktree/branchCleanup.js";
import {
  dirtyFiles,
  gitOrNull,
  liveRepo,
  worktreesBase,
  worktreesDisabled,
} from "./worktree/paths.js";

const INTERVAL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITY = 2;
const INCIDENT_KEY = "worktree-merge";

/** Пороги в часах. Планировщик ходит раз в 5 минут — это с большим запасом. */
export const LIMITS = {
  queuedHours: 2,
  runningHours: 1,
  dirtyMainHours: 6,
  awaitingAuthorHours: 72,
};

let pollHandle: NodeJS.Timeout | null = null;
/**
 * Защита от лавины тревог: не чаще одной тревоги в сутки.
 *
 * Источник правды — БД (incidentRaisedRecently в incidents.ts), а не
 * переменная в памяти: память обнуляется при рестарте, и ограничение
 * переставало действовать (24.10.2026, аудит надёжности).
 */

export interface MergeWatchResult {
  ok: boolean;
  problems: string[];
}

class ProbeRollback extends Error {}

/** Пробная запись строки очереди: вставить, прочитать, откатить. */
function probeQueueTable(): string | null {
  const probeId = "__merge-watch-probe__";
  try {
    db.transaction(() => {
      db.prepare(
        "INSERT INTO worktree_merge_queue(task_id, trigger, state) VALUES (?, 'sweep', 'queued')",
      ).run(probeId);
      const row = db
        .prepare("SELECT state FROM worktree_merge_queue WHERE task_id = ?")
        .get(probeId) as { state: string } | undefined;
      if (row?.state !== "queued")
        throw new Error("пробная строка не читается после записи");
      throw new ProbeRollback();
    })();
  } catch (e: any) {
    if (e instanceof ProbeRollback) return null;
    return `очередь в БД не принимает запись: ${String(e?.message ?? e).slice(0, 160)}`;
  }
  return null;
}

/** Пробный файл в каталоге копий: туда пишутся журнал и копии. */
function probeWorktreesDir(): string | null {
  const file = path.join(worktreesBase(), `.merge-watch-probe-${process.pid}`);
  try {
    fs.mkdirSync(worktreesBase(), { recursive: true });
    fs.writeFileSync(file, "probe");
    fs.rmSync(file, { force: true });
    return null;
  } catch (e: any) {
    return `каталог копий ${worktreesBase()} недоступен для записи: ${String(e?.message ?? e).slice(0, 160)}`;
  }
}

function hoursOld(
  state: string,
  hours: number,
): Array<{ task_id: string; error: string | null }> {
  return db
    .prepare(
      `SELECT task_id, error FROM worktree_merge_queue
        WHERE state = ? AND (julianday('now') - julianday(updated_at)) * 24 > ?
        ORDER BY updated_at`,
    )
    .all(state, hours) as Array<{ task_id: string; error: string | null }>;
}

function short(ids: Array<{ task_id: string }>): string {
  return (
    ids
      .slice(0, 5)
      .map((r) => r.task_id.slice(0, 8))
      .join(", ") + (ids.length > 5 ? ` и ещё ${ids.length - 5}` : "")
  );
}

export function checkWorktreeMerge(): MergeWatchResult {
  const problems: string[] = [];
  if (worktreesDisabled() || getSetting("auto_merge_mode") === "off")
    return { ok: true, problems };

  const live = liveRepo();
  const mainSha = gitOrNull(live, ["rev-parse", "main"], 30_000);
  if (!mainSha)
    problems.push(
      `git не читает ветку main в ${live} — очередь не может ни сравнить, ни слить`,
    );

  const table = probeQueueTable();
  if (table) problems.push(table);
  const dir = probeWorktreesDir();
  if (dir) problems.push(dir);

  const queued = hoursOld("queued", LIMITS.queuedHours);
  if (queued.length)
    problems.push(
      `в очереди дольше ${LIMITS.queuedHours} ч без движения: ${short(queued)}`,
    );
  const running = hoursOld("running", LIMITS.runningHours);
  if (running.length)
    problems.push(
      `слияние зависло в работе дольше ${LIMITS.runningHours} ч: ${short(running)}`,
    );
  const dirty = hoursOld("blocked_dirty_main", LIMITS.dirtyMainHours);
  if (dirty.length) {
    const files = mainSha ? dirtyFiles(live).slice(0, 5).join("; ") : "";
    problems.push(
      `main грязный дольше ${LIMITS.dirtyMainHours} ч, очередь стоит: ${short(dirty)}${files ? ` (незакоммиченное: ${files})` : ""}`,
    );
  }
  const waiting = [
    ...hoursOld("conflict", LIMITS.awaitingAuthorHours),
    ...hoursOld("test_failed", LIMITS.awaitingAuthorHours),
  ];
  if (waiting.length) {
    problems.push(
      `конфликт или красные тесты дольше ${LIMITS.awaitingAuthorHours} ч, автор не разобрал: ${short(waiting)}`,
    );
  }

  // Отправка main на хосты после слияния: отказ или расхождение в последнем
  // проходе — main не доехал, и сам по себе он туда уже не уедет.
  const push = loadPushStatus();
  const badHosts = push?.results.filter((r) => r.state === "failed" || r.state === "diverged") ?? [];
  if (badHosts.length) {
    problems.push(
      `main ${push!.main_sha.slice(0, 8)} не отправлен на хосты: ` +
        badHosts.map((r) => `${r.remote} — ${r.state === "diverged" ? "расхождение" : "отказ"} (${r.detail ?? ""})`).join("; "),
    );
  }

  // Ветка роли на хостах (владелец 10.11.2026: сервер закрывает её сам).
  // Отказ снова оставил бы хвост `roles/*` на GitHub и в Gitea — а снаружи
  // это выглядит как «сервер слил, а ветку не убрал».
  const closeJournal = loadBranchCleanup();
  const lastClose = closeJournal?.entries[closeJournal.entries.length - 1];
  const stalledBranch =
    lastClose?.results.filter((r) => r.state === "failed" || r.state === "skipped") ?? [];
  if (lastClose && stalledBranch.length) {
    problems.push(
      `ветка ${lastClose.branch} не закрыта на хостах: ` +
        stalledBranch
          .map(
            (r) =>
              `${r.remote} — ${r.state === "skipped" ? "на хосте коммиты вне main" : "отказ"} (${r.detail ?? ""})`,
          )
          .join("; "),
    );
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Что делать с очередью, когда встала. Текст уходит владельцу в
 * уведомление, поэтому здесь только то, что реально помогает.
 * 19.10.2026 поправлено: очередь НЕ «продолжит сама» после того, как
 * помеха снята, — до правки возврата в очередь не было, и совет
 * «просто закоммитить» оставлял карточку стоять на месте.
 */
export const MERGE_WATCH_ACTIONS: readonly string[] = [
  '- Очередь: `sqlite3 -column server/taskflow.db "SELECT task_id, state, error, updated_at FROM worktree_merge_queue"`.',
  "- Журнал: `tail ~/.local/state/taskflow-runs/worktrees/merge-journal.log`.",
  "- Грязный main — закоммитить или убрать чужие правки в `~/Проекты/New-Todoist`: как только main станет чистым, эти строки вернутся в очередь сами (проход обслуживания ходит каждые несколько минут).",
  "- Грязная копия роли — закоммитить в самой копии, строка вернётся в очередь сама.",
  "- Конфликт / красные тесты — работа уже вернулась автору шагом плана; нет шага — смотреть событие merge_return_failed.",
  "- main не доехал до хоста — `~/.local/state/taskflow-runs/worktrees/push-status.json`; после починки `~/infra-ops/git-sync/git-sync.sh ~/Проекты/New-Todoist`. Расхождение без слова владельца не форсить.",
  "- Ветка роли не закрыта на хосте — `~/.local/state/taskflow-runs/worktrees/branch-cleanup.json`: там причина по каждому хосту. Отказ прав (Permission denied) снимается доступом, а «коммиты вне main» — ручным разбором: ветку с неслитой работой сервер не удаляет намеренно.",
];

function raise(problems: string[]) {
  // Дедуп по БД: переживает рестарт сервера (см. комментарий у lastRaisedAt).
  if (incidentRaisedRecently(INCIDENT_KEY, DAY_MS)) return;
  const title = `Автослияние стоит: ${problems[0]}`.slice(0, 200);
  const description = [
    "## Что случилось",
    "Сторож автослияния нашёл, что очередь переноса веток ролей в main не работает как должна.",
    "",
    "## Причины",
    ...problems.map((p) => `- ${p}`),
    "",
    "## Что сломано",
    "Принятые результаты ролей не попадают в main: шаг интеграции сдан, а перенос не",
    "происходит. Копии и ветки не убираются, хвост на диске растёт.",
    "",
    "## Что делать",
    ...MERGE_WATCH_ACTIONS,
  ].join("\n");
  raiseIncident({ key: INCIDENT_KEY, title, description, priority: PRIORITY });
}

export function startWorktreeMergeWatcher(): void {
  if (process.env.WORKTREE_MERGE_WATCHER_DISABLED === "1") return;
  if (pollHandle) return;
  const tick = () => {
    try {
      const result = checkWorktreeMerge();
      if (!result.ok) raise(result.problems);
    } catch (e: any) {
      console.warn("[merge-watch] проба не отработала:", e);
    }
  };
  tick();
  pollHandle = setInterval(tick, INTERVAL_MS);
  pollHandle.unref?.();
}
