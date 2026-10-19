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
import { checkForRegression, loadBaseline, refreshBaseline } from "../lib/worktree/testGate.js";
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
  runTests: async (cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> => {
    const command = process.env.TASKFLOW_AUTO_MERGE_TEST_CMD || "npm test";
    return runShell(command, cwd, timeoutMs);
  },
};

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: "1" },
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
      child.kill("SIGKILL");
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
 * интеграцию починил конфликт (сдача шага). Единственный путь,
 * возвращающий карточку в работу осознанно.
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

  const dir = scratchPath(taskId);
  const integrationBranch = `integration/${taskId}`;
  dropScratch(live, taskId);
  // Хвост прошлой попытки: ветка интеграции может остаться после
  // неудачи — переиспользовать её нельзя, коммиты уже с merge-конфликтом.
  if (refExists(live, `refs/heads/${integrationBranch}`)) {
    gitOrNull(live, ["branch", "-D", integrationBranch]);
  }
  try {
    git(live, ["worktree", "add", "-b", integrationBranch, dir, "main"]);
  } catch (error) {
    outcome.state = "conflict";
    outcome.error = `временная копия не создана: ${error instanceof GitError ? error.message : String(error)}`;
    writeState(taskId, { state: outcome.state, error: outcome.error });
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
  const tests = await hooks.runTests(path.join(dir, "server"), timeoutMs);

  // Решает не цвет прогона, а РЕГРЕССИЯ: на самом main уже есть своя
  // красная база, требовать «все тесты зелёные» значит не сливать никогда.
  const gate = checkForRegression(tests.output, live);
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
  dropScratch(live, taskId);

  outcome.state = "merged";
  outcome.result_sha = mergedSha;
  outcome.error = null;
  writeState(taskId, { state: "merged", result_sha: mergedSha, error: null, finished_at: null });
  journal({ task_id: taskId, state: "merged", main_sha_before: mainShaBefore, result_sha: mergedSha });
  safeLogEvent(taskId, "auto_merged", branch, mergedSha);
  return outcome;
}

function tail(output: string, limit = 4000): string {
  return output.trim().slice(-limit);
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
  for (const entry of fs.readdirSync(base).slice(0, limit)) {
    if (entry.startsWith(".merge-") || entry.startsWith("iso-test-")) continue;
    const taskId = entry;
    try {
      const state = inspectWorktree(taskId, "main", live);
      if (!state.branch_exists || !state.merged_into_base || state.dirty.length > 0) continue;
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
  // База падений: снимаем, только если её нет или main уехал. Дорогой
  // прогон, поэтому не каждый проход.
  const baseline = loadBaseline();
  const liveNow = liveRepo();
  const mainSha = gitOrNull(liveNow, ["rev-parse", "main"], 30_000);
  if (mergeMode() !== "off" && (!baseline || baseline.main_sha !== mainSha)) {
    await refreshBaseline(hooks.runTests, getSetting("auto_merge_test_timeout_min") * 60_000, liveNow);
  }
  const merged = (await drainMergeQueue(1)).filter((row) => row.state === "merged").length;
  const queued = mergeMode() === "off" ? 0 : sweepUnmergedBranches();
  const cleaned = await sweepMergedWorkspaces();
  const leftovers = sweepTestLeftovers();
  return merged + queued + cleaned + leftovers;
}
