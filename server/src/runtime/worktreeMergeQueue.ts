// Очередь автослияния: механика переноса ветки роли в main.
// LOCK-WORKTREE-MANAGER-20261019, владелец 19.10.2026.
//
// Что решает система, а что остаётся за ответственным за интеграцию:
//   — решение «что вливается» принимает шаг интеграции (роль или
//     владелец). Он и кладёт карточку в очередь — см. `enqueueMerge`.
//   — система делает механику: чистая копия → merge → тесты → main.
//
// Ключевое отличие от «слить и надеяться»: main двигается ПОСЛЕ зелёных
// тестов. Слияние собирается во временной копии `integration/<taskId>`;
// только когда тесты прошли, она fast-forward'ом переносится в main.
// Поэтому «откат после красных тестов» в бою не нужен — красные тесты
// означают, что main вообще не трогали. Ручка отката остаётся для уже
// слитого коммита.
//
// Последовательность: одна очередь, одна блокировка на файл, за проход
// планировщика — одна карточка (тесты занимают минуты, блокировать все
// ветки планировщика нельзя).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { getSetting } from "../lib/serverSettings.js";
import { inspectWorktree } from "../lib/worktree/inspect.js";
import { cleanupWorktree, sweepTestLeftovers } from "../lib/worktree/cleanup.js";
import { checkForRegression, loadBaseline, refreshBaseline, parseFailedTestFiles } from "../lib/worktree/testGate.js";
import { pushMainToHosts, type PushStatus } from "../lib/worktree/pushHosts.js";
import {
  GitError,
  dirtyFiles,
  git,
  gitOrNull,
  linkNodeModules,
  liveRepo,
  refExists,
  roleBranch,
  worktreePath,
  worktreesBase,
  worktreesDisabled,
} from "../lib/worktree/paths.js";

export type MergeTrigger = "integration_step" | "orchestrator_step" | "sweep";
export type MergeState =
  | "queued"
  | "running"
  | "merged"
  | "conflict"
  | "test_failed"
  | "dry_run"
  | "blocked_dirty_main"
  | "dirty_worktree"
  | "nothing_to_merge"
  | "missing_branch"
  | "disabled";

export interface MergeRow {
  task_id: string;
  trigger: MergeTrigger;
  state: MergeState;
  main_sha_before: string | null;
  result_sha: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const LOCK_FILE = "merge.lock";
const LOCK_STALE_MS = 30 * 60_000;

/** Крюк для тестов: реальный запуск `npm test` занимает минуты. */
export const hooks = {
  /** Отправка main во все git-хосты после слияния; тесты подменяют. */
  pushHosts: (live: string): PushStatus => pushMainToHosts(live),
  runTests: async (cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> => {
    const command = process.env.TASKFLOW_AUTO_MERGE_TEST_CMD || "npm test -- --maxWorkers=2";
    return runShell(command, cwd, timeoutMs);
  },
};

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      env: { ...process.env, CI: "1", GRAFT_NO_REFRESH: "1" },
    });
    let output = "";
    const cap = 200_000;
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > cap) output = output.slice(-cap);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* процесс уже завершён */ }
      resolve({ ok: false, output: `${output}\n[прервано по таймауту ${Math.round(timeoutMs / 1000)} с]` });
    }, timeoutMs);
    timer.unref?.();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n[запуск не удался: ${error.message}]` });
    });
  });
}

/**
 * Событие в ленту карточки — вспомогательное. Если таблица недоступна или
 * запись не прошла, слияние обязано продолжиться: перенос важнее
 * упороться в журнал.
 */
function safeLogEvent(taskId: string, kind: string, field: string, toValue?: string | null): void {
  try {
    logEvent({ taskId, actorId: null, kind, field, toValue });
  } catch {
    /* лента недоступна — слияние продолжается */
  }
}

function journal(entry: Record<string, unknown>): void {
  try {
    const base = worktreesBase();
    fs.mkdirSync(path.dirname(path.join(base, "merge-journal.log")), { recursive: true });
    fs.appendFileSync(
      path.join(base, "merge-journal.log"),
      `${new Date().toISOString()} ${JSON.stringify(entry)}\n`,
    );
  } catch {
    /* журнал — вспомогательный, его потеря не должна ломать слияние */
  }
}

// ───────────────────────── блокировка ─────────────────────────

function acquireLock(): string | null {
  const file = path.join(worktreesBase(), LOCK_FILE);
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return file;
  } catch {
    // Файл есть. Старый (процесс упал) — забираем себе, свежий — уходим.
    try {
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.unlinkSync(file);
        return acquireLock();
      }
    } catch {
      return null;
    }
    return null;
  }
}

function releaseLock(file: string | null): void {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* уже снята */
  }
}

// ───────────────────────── очередь в БД ─────────────────────────

export function mergeMode(): "off" | "dry" | "on" {
  return getSetting("auto_merge_mode");
}

/**
 * Порог «слияние идёт подозрительно долго», минуты. Тесты при слиянии
 * умеют идти до `auto_merge_test_timeout_min`; запас сверху нужен на
 * пересборку копии и перенос в main.
 */
export function staleRunningMinutes(): number {
  const testMinutes = Number(getSetting("auto_merge_test_timeout_min")) || 20;
  return Math.max(30, testMinutes + 10);
}

function writeState(taskId: string, patch: Partial<MergeRow>): void {
  const map: Record<string, string> = {
    state: "state",
    main_sha_before: "main_sha_before",
    result_sha: "result_sha",
    error: "error",
    trigger: "trigger",
  };
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(map)) {
    const value = patch[key as keyof MergeRow];
    if (value === undefined) continue;
    fields.push(`${column} = ?`);
    values.push(value);
  }
  if (!fields.length) return;
  db.prepare(`UPDATE worktree_merge_queue SET ${fields.join(", ")}, updated_at = datetime('now') WHERE task_id = ?`).run(
    ...values,
    taskId,
  );
}

/**
 * Поставить карточку в очередь. Точка входа — сдача шага интеграции
 * (или закрытие шага сборки Оркестратора при плане `orchestrated`).
 * Повторная постановка того же состояния не плодит строки.
 */
export function enqueueMerge(taskId: string, trigger: MergeTrigger): boolean {
  if (worktreesDisabled()) return false;
  if (mergeMode() === "off") return false;
  if (!refExists(liveRepo(), "HEAD")) return false;
  const existing = db.prepare("SELECT state FROM worktree_merge_queue WHERE task_id = ?").get(taskId) as
    | { state: string }
    | undefined;
  if (existing) {
    // Строку, которая уже в работе или уже разобрана, развертка не
    // трогает: иначе причина отказа («красные тесты», «грязный main»,
    // «грязная копия») стирается и её невозможно увидеть.
    if (existing.state !== "queued") return false;
    db.prepare(
      "UPDATE worktree_merge_queue SET trigger = ?, updated_at = datetime('now') WHERE task_id = ?",
    ).run(trigger, taskId);
    return true;
  }
  db.prepare(
    "INSERT INTO worktree_merge_queue(task_id, trigger, state) VALUES (?, ?, 'queued')",
  ).run(taskId, trigger);
  return true;
}

/**
 * Переоформить строку в `queued` после того, как ответственный за
 * интеграцию починил конфликт (сдача шага). Для ручных разборов —
 * единственный путь, возвращающий карточку в работу осознанно.
 */
export function requeueMerge(taskId: string): boolean {
  const changed = db
    .prepare("UPDATE worktree_merge_queue SET state = 'queued', error = NULL, updated_at = datetime('now') WHERE task_id = ? AND state IN ('conflict', 'test_failed', 'blocked_dirty_main', 'dirty_worktree')")
    .run(taskId).changes;
  return changed > 0;
}

export function mergeQueueRow(taskId: string): MergeRow | undefined {
  return db.prepare("SELECT * FROM worktree_merge_queue WHERE task_id = ?").get(taskId) as
    | MergeRow
    | undefined;
}

export function mergeQueueRows(limit = 50): MergeRow[] {
  return db
    .prepare("SELECT * FROM worktree_merge_queue ORDER BY created_at LIMIT ?")
    .all(limit) as MergeRow[];
}

// ───────────────────────── слияние ─────────────────────────

export interface MergeOutcome extends MergeRow {
  detail?: string;
}

function scratchPath(taskId: string): string {
  return path.join(worktreesBase(), `.merge-${taskId}`);
}

function dropScratch(live: string, taskId: string): void {
  const dir = scratchPath(taskId);
  if (fs.existsSync(dir)) {
    try {
      git(live, ["worktree", "remove", "--force", dir]);
    } catch {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* оставим врачебную — следующий проход */
      }
    }
  }
  gitOrNull(live, ["worktree", "prune"]);
}

/** Попытка слить одну карточку. Ничего не бросает наружу. */
export async function processMerge(taskId: string): Promise<MergeOutcome> {
  const row = mergeQueueRow(taskId) ?? ({ task_id: taskId, trigger: "sweep", state: "queued" } as MergeRow);
  const outcome: MergeOutcome = { ...row };
  const live = liveRepo();
  const branch = roleBranch(taskId);

  const dirtyMain = dirtyFiles(live);
  if (dirtyMain.length > 0) {
    outcome.state = "blocked_dirty_main";
    outcome.error = `в main есть незакоммиченное (${dirtyMain.length}): ${dirtyMain.slice(0, 3).join(", ")}`;
    writeState(taskId, { state: outcome.state, error: outcome.error });
    return outcome;
  }

  if (!refExists(live, `refs/heads/${branch}`)) {
    outcome.state = "missing_branch";
    outcome.error = `ветки ${branch} нет`;
    writeState(taskId, { state: outcome.state, error: outcome.error });
    return outcome;
  }

  const state = inspectWorktree(taskId, "main", live);
  if (state.ahead_count === 0) {
    outcome.state = "nothing_to_merge";
    outcome.error = null;
    writeState(taskId, { state: outcome.state, error: null });
    return outcome;
  }
  if (state.worktree_exists && state.dirty.length > 0) {
    outcome.state = "dirty_worktree";
    outcome.error = `в рабочей копии есть незакоммиченное (${state.dirty.length})`;
    writeState(taskId, { state: outcome.state, error: outcome.error });
    return outcome;
  }

  const mainShaBefore = git(live, ["rev-parse", "main"]);
  outcome.main_sha_before = mainShaBefore;
  writeState(taskId, { state: "running", main_sha_before: mainShaBefore, error: null });
  // Счётчик попыток: по нему видно, что слияние упирается в одно и то же
  // (создание копии) и пора звать человека.
  const attempts = Number(row.attempts ?? 0) + 1;
  db.prepare("UPDATE worktree_merge_queue SET attempts = ? WHERE task_id = ?").run(attempts, taskId);

  const dir = scratchPath(taskId);
  const integrationBranch = `integration/${taskId}`;
  dropScratch(live, taskId);
  // Хвост прошлой попытки: ветка интеграции может остаться после
  // неудачи — переиспользовать её нельзя, коммиты уже с merge-конфликтом.
  if (refExists(live, `refs/heads/${integrationBranch}`)) {
    gitOrNull(live, ["branch", "-D", integrationBranch]);
  }
  try {
    // Создание копии на большом репозитории умеет не уложиться в минуту
    // (checkout 1759 файлов на холодном кэше) — это не конфликт кода, а
    // техническая помеха, и её должен снять следующий проход.
    git(live, ["worktree", "add", "-b", integrationBranch, dir, "main"], 300_000);
  } catch (error) {
    const message = error instanceof GitError ? error.message : String(error);
    // Помеха повторяется — дальше крутить бессмысленно, отдаём человеку.
    if (attempts >= 4) {
      outcome.state = "conflict";
      outcome.error = `временная копия не создана: ${message}`;
      writeState(taskId, { state: outcome.state, error: outcome.error });
      journal({ task_id: taskId, state: "conflict", main_sha_before: mainShaBefore, error: outcome.error });
      return outcome;
    }
    outcome.state = "queued";
    outcome.error = `временная копия не создана: ${message}`;
    writeState(taskId, { state: outcome.state, error: outcome.error });
    journal({ task_id: taskId, state: "requeued", from: "running", reason: "scratch_not_created" });
    safeLogEvent(taskId, "merge_unblocked", "running", "queued");
    return outcome;
  }
  linkNodeModules(dir, live);

  // 1. Слияние в изолированной копии: main ещё не тронут.
  try {
    git(dir, ["merge", "--no-ff", "--no-edit", branch]);
  } catch {
    const files = gitOrNull(dir, ["diff", "--name-only", "--diff-filter=U"], 60_000) ?? "";
    gitOrNull(dir, ["merge", "--abort"]);
    dropScratch(live, taskId);
    outcome.state = "conflict";
    outcome.error = files ? `конфликт в: ${files.split("\n").slice(0, 8).join(", ")}` : "конфликт слияния";
    writeState(taskId, { state: outcome.state, error: outcome.error });
    journal({ task_id: taskId, state: "conflict", main_sha_before: mainShaBefore, error: outcome.error });
    safeLogEvent(taskId, "merge_conflict", branch, outcome.error);
    return outcome;
  }
  const mergedSha = git(dir, ["rev-parse", "HEAD"]);

  // 2. Тесты — тоже в изолированной копии. main ещё не тронут.
  const timeoutMs = getSetting("auto_merge_test_timeout_min") * 60_000;
  // Дорогой снимок main нужен только для готового слияния, под блокировкой
  // очереди. Пустой проход, грязный main и конфликт тесты не запускают.
  const baseline = loadBaseline();
  if (!baseline || baseline.main_sha !== mainShaBefore) {
    const refreshed = await refreshBaseline(hooks.runTests, timeoutMs, live);
    if (!refreshed) {
      dropScratch(live, taskId);
      outcome.state = "test_failed";
      outcome.error = "не удалось снять базу падений main";
      writeState(taskId, { state: outcome.state, error: outcome.error });
      return outcome;
    }
  }
  // Владелец мог выключить автоматику во время долгого снимка.
  if (mergeMode() === "off") {
    dropScratch(live, taskId);
    outcome.state = "queued";
    writeState(taskId, { state: "queued", error: null });
    return outcome;
  }
  const tests = await hooks.runTests(path.join(dir, "server"), timeoutMs);

  // Решает не цвет прогона, а РЕГРЕССИЯ: на самом main уже есть своя
  // красная база, требовать «все тесты зелёные» значит не сливать никогда.
  const interrupted = !tests.ok && (parseFailedTestFiles(tests.output).length === 0 ||
    /\[прервано по таймауту|\[запуск не удался/.test(tests.output));
  const gate = interrupted
    ? { ok: false, regressions: [], reason: "прогон тестов не завершён: " + tail(tests.output) }
    : checkForRegression(tests.output, live);
  if (!gate.ok) {
    dropScratch(live, taskId);
    outcome.state = "test_failed";
    outcome.result_sha = mergedSha;
    outcome.error = tail(gate.reason ?? tail(tests.output));
    writeState(taskId, { state: outcome.state, result_sha: mergedSha, error: outcome.error });
    journal({ task_id: taskId, state: "test_failed", main_sha_before: mainShaBefore, result_sha: mergedSha, regressions: gate.regressions });
    safeLogEvent(taskId, "merge_test_failed", branch, mergedSha);
    return outcome;
  }

  // 3. Режим «считать, но не сливать» — рапорт без движения main.
  if (mergeMode() === "dry") {
    dropScratch(live, taskId);
    outcome.state = "dry_run";
    outcome.result_sha = mergedSha;
    outcome.error = null;
    writeState(taskId, { state: outcome.state, result_sha: mergedSha, error: null });
    journal({ task_id: taskId, state: "dry_run", main_sha_before: mainShaBefore, result_sha: mergedSha });
    return outcome;
  }

  if (mergeMode() === "off") {
    dropScratch(live, taskId);
    outcome.state = "queued";
    writeState(taskId, { state: "queued", error: null });
    return outcome;
  }
  // 4. Двигаем main — только теперь, после зелёных тестов.
  try {
    git(live, ["merge", "--ff-only", integrationBranch]);
  } catch (error) {
    dropScratch(live, taskId);
    outcome.state = "conflict";
    outcome.error = `main ушёл вперёд, перенос не выполнен: ${error instanceof GitError ? error.message : String(error)}`;
    writeState(taskId, { state: outcome.state, error: outcome.error });
    journal({ task_id: taskId, state: "conflict", main_sha_before: mainShaBefore, error: outcome.error });
    return outcome;
  }

  // 5. Копия роли и её ветка больше не нужны.
  try {
    await cleanupWorktree(taskId, { live, mergedAt: mainShaBefore, skipRemote: true });
  } catch {
    /* уборка не должна отменять уже состоявшееся слияние */
  }
  db.prepare(
    "UPDATE tasks SET merged_at = datetime('now'), merged_into_commit = ?, merged_into_branch = 'main' WHERE id = ?",
  ).run(mergedSha, taskId);
  // Слияние состоялось — счётчик неудачных попыток обнуляем: он считает
  // затыки, а не число слияний за всю жизнь карточки.
  db.prepare("UPDATE worktree_merge_queue SET attempts = 0 WHERE task_id = ?").run(taskId);
  dropScratch(live, taskId);

  outcome.state = "merged";
  outcome.result_sha = mergedSha;
  outcome.error = null;
  writeState(taskId, { state: "merged", result_sha: mergedSha, error: null, finished_at: null });
  journal({ task_id: taskId, state: "merged", main_sha_before: mainShaBefore, result_sha: mergedSha });
  safeLogEvent(taskId, "auto_merged", branch, mergedSha);

  // 6. main — на все хосты: только fast-forward, с бэкапом вершины хоста.
  // Отказ не отменяет слияние: он уходит в журнал и в push-status.json,
  // оттуда его поднимает сторож автослияния.
  try {
    const push = hooks.pushHosts(live);
    journal({ task_id: taskId, state: "push", main_sha: push.main_sha, results: push.results });
  } catch (error) {
    journal({ task_id: taskId, state: "push", error: String(error) });
  }
  return outcome;
}

function tail(output: string, limit = 4000): string {
  return output.trim().slice(-limit);
}

/**
 * Вернуть в очередь строки, остановленные ВНЕШНЕЙ помехой, как только
 * помеха снята: main стал чистым — `blocked_dirty_main` снова `queued`,
 * копия роли чистая — `dirty_worktree` снова `queued`.
 *
 * Помеха здесь не в руках роли: пока main грязный чужой правкой или копия
 * не закоммичена, сдавать шаг заново нечего — шаг уже сдан. Ждать
 * повторной сдачи значит ждать человека, который про строку вообще не
 * знает: 19.10.2026 карточка так пролежала в `blocked_dirty_main` с 14:45
 * до 21:17 UTC, хотя main к тому моменту почистили.
 *
 * `conflict` и `test_failed` сюда НЕ входят: там нужен разбор человека
 * (починить и сдать шаг), иначе система будет снова и снова упираться в
 * одно и то же. `dirty_worktree` тоже ждёт, пока копия не вернётся на
 * диск: ушедшая копия — это потерянные правки, решать это владельцу.
 */
export function retryClearedObstructions(limit = 20): string[] {
  if (worktreesDisabled() || mergeMode() === "off") return [];
  const live = liveRepo();
  if (!refExists(live, "HEAD")) return [];
  const rows = db
    .prepare(
      `SELECT task_id, state FROM worktree_merge_queue
        WHERE state IN ('blocked_dirty_main', 'dirty_worktree')
        ORDER BY created_at LIMIT ?`,
    )
    .all(limit) as Array<{ task_id: string; state: string }>;
  if (!rows.length) return [];
  const mainClean = dirtyFiles(live).length === 0;
  const requeued: string[] = [];
  for (const row of rows) {
    const cleared =
      row.state === "blocked_dirty_main"
        ? mainClean
        : (() => {
            const state = inspectWorktree(row.task_id, "main", live);
            return state.worktree_exists && state.dirty.length === 0;
          })();
    if (!cleared) continue;
    if (!requeueMerge(row.task_id)) continue;
    requeued.push(row.task_id);
    journal({ task_id: row.task_id, state: "requeued", from: row.state, cleared });
    safeLogEvent(row.task_id, "merge_unblocked", row.state, "queued");
  }
  return requeued;
}

/**
 * Вернуть в очередку строки, застрявшие в `running`.
 *
 * `running` ставится перед слиянием и снимается в конце. Если сервер
 * упал или был перезапущен посреди слияния, строка остаётся в `running`
 * навсегда: её не берёт ни `drainMergeQueue` (берёт только `queued`), ни
 * `requeueMerge` (не переоформляет `running`) — карточка висит часами,
 * а сторож автослияния поднимает тревогу «слияние зависло в работе».
 *
 * Признак «слияния нет» — свежий файл блокировки: пока идёт слияние,
 * держится `merge.lock`, и посторонний проход в очередь не лезет.
 * Возраст строки сверяется с порогом из настроек: тесты при слиянии
 * идут до `auto_merge_test_timeout_min`, запас даётся сверху.
 */
export function recoverStaleRunning(limit = 20): string[] {
  if (worktreesDisabled() || mergeMode() === "off") return [];
  const threshold = staleRunningMinutes();
  // Живое слияние держит блокировку — не трогаем его строку.
  try {
    const lock = path.join(worktreesBase(), LOCK_FILE);
    if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < LOCK_STALE_MS) return [];
  } catch {
    /* блокировку не прочитали — считаем, что её нет */
  }
  const rows = db
    .prepare(
      `SELECT task_id, attempts FROM worktree_merge_queue
        WHERE state = 'running'
          AND (julianday('now') - julianday(updated_at)) * 24 * 60 > ?
        ORDER BY updated_at LIMIT ?`,
    )
    .all(threshold, limit) as Array<{ task_id: string; attempts: number }>;
  const recovered: string[] = [];
  for (const row of rows) {
    const attempts = Number(row.attempts ?? 0);
    if (attempts >= 5) {
      // Пять попыток подряд — дальше крутить бессмысленно: это разбор
      // человека, а не помеха, которая снимется сама.
      db.prepare(
        "UPDATE worktree_merge_queue SET state = 'conflict', error = ?, updated_at = datetime('now') WHERE task_id = ?",
      ).run(`слияние не продвигается: ${attempts} попыток подряд`, row.task_id);
      journal({ task_id: row.task_id, state: "conflict", error: `слияние не продвигается: ${attempts} попыток подряд` });
      safeLogEvent(row.task_id, "merge_conflict", roleBranch(row.task_id), "слияние не продвигается");
      continue;
    }
    db.prepare(
      "UPDATE worktree_merge_queue SET state = 'queued', error = NULL, updated_at = datetime('now') WHERE task_id = ? AND state = 'running'",
    ).run(row.task_id);
    recovered.push(row.task_id);
    journal({ task_id: row.task_id, state: "requeued", from: "running", reason: "stale_running" });
    safeLogEvent(row.task_id, "merge_unblocked", "running", "queued");
  }
  return recovered;
}

/**
 * Убрать временные копии слияния (`.merge-<taskId>`), оставшиеся от
 * упавшего прохода: карточка не в `running` — значит слияния сейчас
 * нет, и каталог никто не трогает. Иначе эти каталоги копятся на диске
 * (живой случай: 21.10.2026 на сервере лежал `.merge-a001ff3d…`).
 */
export function sweepMergeScratch(limit = 20): number {
  if (worktreesDisabled()) return 0;
  const base = worktreesBase();
  if (!fs.existsSync(base)) return 0;
  const live = liveRepo();
  let removed = 0;
  for (const entry of fs.readdirSync(base).slice(0, limit)) {
    if (!entry.startsWith(".merge-")) continue;
    const taskId = entry.slice(".merge-".length);
    const row = db.prepare("SELECT state FROM worktree_merge_queue WHERE task_id = ?").get(taskId) as
      | { state: string }
      | undefined;
    if (row?.state === "running") continue;
    const dir = path.join(base, entry);
    try {
      gitOrNull(live, ["worktree", "remove", "--force", dir]);
      fs.rmSync(dir, { recursive: true, force: true });
      gitOrNull(live, ["worktree", "prune"]);
      removed += 1;
    } catch {
      /* занят кем-то — следующий проход */
    }
  }
  return removed;
}

/**
 * Один проход очереди: не больше `limit` карточек за раз. Возвращает
 * разобранные строки — планировщик пишет их в лог, тесты читают.
 */
export async function drainMergeQueue(limit = 1): Promise<MergeOutcome[]> {
  if (mergeMode() === "off") return [];
  const lock = acquireLock();
  if (!lock) return [];
  try {
    const rows = db
      .prepare("SELECT task_id FROM worktree_merge_queue WHERE state IN ('queued') ORDER BY created_at LIMIT ?")
      .all(limit) as Array<{ task_id: string }>;
    const out: MergeOutcome[] = [];
    for (const row of rows) {
      out.push(await processMerge(row.task_id));
    }
    return out;
  } finally {
    releaseLock(lock);
  }
}

// ───────────────────────── проход обслуживания ─────────────────────────

/**
 * Поставить в очередь ветки ролей, у которых есть неслитые коммиты.
 * Это разбирает хвост, оставшийся до появления менеджера.
 */
export function sweepUnmergedBranches(limit = 20): number {
  if (worktreesDisabled()) return 0;
  const live = liveRepo();
  const refs = gitOrNull(live, ["for-each-ref", "--format=%(refname:short)", "refs/heads/roles/"], 60_000);
  if (!refs) return 0;
  let queued = 0;
  for (const ref of refs.split("\n").filter(Boolean).slice(0, 200)) {
    if (queued >= limit) break;
    const taskId = ref.replace(/^roles\//, "");
    const state = inspectWorktree(taskId, "main", live);
    if (!state.branch_exists || state.merged_into_base || state.ahead_count === 0) continue;
    // Строка уже есть — состояние не трогаем: у неё либо свой диагноз,
    // либо она уже в очереди. Развертка только добавляет новые.
    if (mergeQueueRow(taskId)) continue;
    try {
      if (enqueueMerge(taskId, "sweep")) queued += 1;
    } catch {
      /* одна битая строка не должна ронять проход */
    }
  }
  return queued;
}

/**
 * План `profile='orchestrated'`: интеграция считается не требуемой, и
 * вливает шаг сборки самого Оркестратора (владелец 13.10.2026). Этот
 * шаг — последний незакрытый в плане; его закрытие тоже запускает
 * перенос.
 */
export function isOrchestratedFinalStep(subtaskId: string): boolean {
  try {
    const plan = db
      .prepare(
        "SELECT p.id AS id FROM subtasks s JOIN task_collaboration_plans p ON p.id = s.collaboration_plan_id " +
          "WHERE s.id = ? AND p.profile = 'orchestrated' AND p.status IN ('draft','approved')",
      )
      .get(subtaskId) as { id: string } | undefined;
    if (!plan) return false;
    const open = db
      .prepare("SELECT COUNT(*) AS n FROM subtasks WHERE collaboration_plan_id = ? AND done = 0")
      .get(plan.id) as { n: number };
    return open.n === 0;
  } catch {
    return false;
  }
}

/** Убрать копии карточек, чьё слияние уже подтверждено. */
export async function sweepMergedWorkspaces(limit = 20): Promise<number> {
  if (worktreesDisabled()) return 0;
  const live = liveRepo();
  let cleaned = 0;
  const base = worktreesBase();
  if (!fs.existsSync(base)) return 0;
  // Смотреть надо на ВСЕ копии, а не на первые `limit` по алфавиту:
  // иначе хвост из копий, чьи названия начинаются после двадцатого,
  // не убирался никогда — а именно его и жаловались.
  for (const entry of fs.readdirSync(base)) {
    if (cleaned >= limit) break;
    if (entry.startsWith(".merge-") || entry.startsWith("iso-test-")) continue;
    const taskId = entry;
    try {
      const state = inspectWorktree(taskId, "main", live);
      // Ветки роли уже нет — сливать больше нечего, копия только занимает
      // место. Ветка есть, но не слита — там может быть неслитая работа.
      if (state.branch_exists && !state.merged_into_base) continue;
      if (state.dirty.length > 0) continue;
      const row = db.prepare("SELECT merged_at FROM tasks WHERE id = ?").get(taskId) as
        | { merged_at: string | null }
        | undefined;
      if (!row?.merged_at) continue;
      const result = await cleanupWorktree(taskId, { live, skipRemote: true });
      if (result.removed_worktree) cleaned += 1;
    } catch {
      /* следующий проход */
    }
  }
  return cleaned;
}

/**
 * Проход обслуживания рабочих копий: очередь, уборка подтверждённого,
 * хвост тестовых каталогов. Вызывается планировщиком.
 */
export async function worktreeMaintenancePass(): Promise<number> {
  // Возврат снятых помех — до разбора: вернувшаяся строка сразу же
  // разбирается тем же проходом, а не следующим через 5 минут.
  const unblocked = retryClearedObstructions().length;
  // Зависшие в `running` строки (сервер упал посреди слияния) — тоже
  // в очередь: иначе карточка висит до прихода человека.
  const recovered = recoverStaleRunning().length;
  const merged = (await drainMergeQueue(1)).filter((row) => row.state === "merged").length;
  const queued = mergeMode() === "off" ? 0 : sweepUnmergedBranches();
  const cleaned = await sweepMergedWorkspaces();
  const leftovers = sweepTestLeftovers() + sweepMergeScratch();
  return unblocked + recovered + merged + queued + cleaned + leftovers;
}
