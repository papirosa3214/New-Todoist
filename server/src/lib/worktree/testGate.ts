// Гейт тестов при слиянии: важно, ЧТО именно сломалось, а не просто
// «есть хоть одно падение». LOCK-WORKTREE-MANAGER-20261019.
//
// На `main` сервера уже есть своя красная база: 36 падающих тестов в 15
// файлах (снимок 19.10.2026). Если требовать от слияния «все тесты зелёные»,
// автослияние не сработает никогда — база красная. Поэтому решает не цвет
// прогона, а РЕГРЕССИЯ: слитая ветка не должна ломать то, что было цело
// до неё.
//
// База хранится файлом рядом с журналом слияний и помечена тем коммитом
// `main`, на котором снята. `main` уехал — база протухла, снимаем новую
// (один прогон), и до этого слияния не идут.
import fs from "node:fs";
import path from "node:path";
import { git, gitOrNull, worktreesBase } from "./paths.js";

export interface TestBaseline {
  main_sha: string;
  failed_files: string[];
  taken_at: string;
}

function baselinePath(): string {
  return path.join(worktreesBase(), "merge-baseline.json");
}

export function loadBaseline(): TestBaseline | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath(), "utf8")) as TestBaseline;
    if (!parsed.main_sha || !Array.isArray(parsed.failed_files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveBaseline(failedFiles: string[], mainSha: string): TestBaseline {
  const baseline: TestBaseline = {
    main_sha: mainSha,
    failed_files: [...new Set(failedFiles)].sort(),
    taken_at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(baselinePath(), JSON.stringify(baseline, null, 2));
  } catch {
    /* без базы гейт просто не пропустит слияние — см. checkForRegression */
  }
  return baseline;
}

/**
 * Файлы с упавшими тестами из вывода vitest. Строка отчёта выглядит так:
 *   ` ❯ test/runtime/thinkingLevel.test.ts (5 tests | 3 failed)`
 *   ` FAIL  test/roles.test.ts > группа ролей > чтение`
 * Берём оба вида, чтобы не зависеть от форматера.
 */
export function parseFailedTestFiles(output: string): string[] {
  const files = new Set<string>();
  for (const line of output.split("\n")) {
    const byMarker = /\bFAIL\b[^:]*?((?:test|src|Tests|UITests)\/[^\s>:]+\.test\.ts)/.exec(line);
    if (byMarker) {
      files.add(byMarker[1]);
      continue;
    }
    const bySummary = /❯\s+((?:test|src|Tests|UITests)\/[^\s>]+\.test\.ts)[^\n]*failed/.exec(line);
    if (bySummary) files.add(bySummary[1]);
  }
  return [...files].sort();
}

export interface GateResult {
  /** Слияние можно выполнять: новых падений нет. */
  ok: boolean;
  /** Причина отказа — показывается в очереди. */
  reason?: string;
  /** Файлы, которые упали именно из-за сливаемой ветки. */
  regressions: string[];
  /** База устарела (main уехал) — слияние ждёт свежей базы. */
  staleBaseline?: boolean;
}

/**
 * Решение по прогону тестов слитой ветки. `output` — то, что вернул
 * прогон в копии слияния.
 */
export function checkForRegression(output: string, live: string): GateResult {
  const failed = parseFailedTestFiles(output);
  const mainSha = gitOrNull(live, ["rev-parse", "main"], 30_000) ?? "";
  const baseline = loadBaseline();
  if (!baseline) {
    return {
      ok: false,
      regressions: failed,
      reason: "нет базы падений main — сначала снимок, потом слияния",
    };
  }
  if (baseline.main_sha !== mainSha) {
    return {
      ok: false,
      regressions: [],
      staleBaseline: true,
      reason: "база падений устарела: main уехал, нужен новый снимок",
    };
  }
  const known = new Set(baseline.failed_files);
  const regressions = failed.filter((file) => !known.has(file));
  if (regressions.length === 0) return { ok: true, regressions: [] };
  return {
    ok: false,
    regressions,
    reason: `новые падения после слияния: ${regressions.join(", ")}`,
  };
}

/**
 * Снять базу падений на текущем `main`. Дорогой прогон (весь набор),
 * поэтому запускается только когда бапы нет или она протухла.
 */
export async function refreshBaseline(
  runTests: (cwd: string, timeoutMs: number) => Promise<{ ok: boolean; output: string }>,
  timeoutMs: number,
  live: string,
): Promise<TestBaseline | null> {
  const mainSha = gitOrNull(live, ["rev-parse", "main"], 30_000) ?? "";
  if (!mainSha) return null;
  const dir = path.join(worktreesBase(), ".baseline-main");
  const branch = "integration/_baseline-main";
  // Чистая копия именно main: снимаем «как есть», без ролевых веток.
  try {
    git(live, ["worktree", "remove", "--force", dir]);
  } catch {
    /* каталога не было */
  }
  gitOrNull(live, ["worktree", "prune"]);
  try {
    git(live, ["worktree", "add", "-B", branch, dir, "main"]);
  } catch {
    return null;
  }
  try {
    // node_modules симлинками, как и в копии слияния.
    for (const rel of ["node_modules", path.join("server", "node_modules")]) {
      const source = path.join(live, rel);
      const link = path.join(dir, rel);
      if (fs.existsSync(source) && !fs.existsSync(link)) {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(source, link, "dir");
      }
    }
    const result = await runTests(path.join(dir, "server"), timeoutMs);
    const failed = parseFailedTestFiles(result.output);
    // Таймаут/сбой запуска без результатов — не зелёная база.
    if (!result.ok && (failed.length === 0 || /\[прервано по таймауту|\[запуск не удался/.test(result.output))) return null;
    return saveBaseline(failed, mainSha);
  } finally {
    try {
      git(live, ["worktree", "remove", "--force", dir]);
    } catch {
      /* оставим, если не далось */
    }
    gitOrNull(live, ["worktree", "prune"]);
  }
}

/**
 * Какие тесты проверяют правку (владелец 05.11.2026): изменённые файлы тестов и
 * тесты, названные как изменённый исходник. Пути — от папки server.
 */
export function selectTargetedTests(changed: string[], allTests: string[]): string[] {
  const chosen = new Set<string>();
  const known = new Set(allTests);
  for (const file of changed) {
    if (known.has(file)) chosen.add(file);
    const source = /^server\/src\/(?:.*\/)?([^/]+)\.tsx?$/.exec(file);
    if (!source) continue;
    for (const test of allTests) {
      const name = test.slice(test.lastIndexOf("/") + 1);
      if (name === `${source[1]}.test.ts` || name.startsWith(`${source[1]}.`)) chosen.add(test);
    }
  }
  return [...chosen].map((file) => file.slice("server/".length)).sort();
}
