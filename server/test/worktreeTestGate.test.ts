// Гейт тестов при слиянии: решает регрессия, а не «есть падания».
// База main красная — иначе автослияние не сработает никогда.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkForRegression, loadBaseline, parseFailedTestFiles, saveBaseline } from "../src/lib/worktree/testGate.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-gate-"));
const live = path.join(root, "live");
const base = path.join(root, "worktrees");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const previousBase = process.env.TASKFLOW_ROLE_WORKTREES;

beforeAll(() => {
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(base, { recursive: true });
  git(live, "init", "-q", "-b", "main");
  git(live, "config", "user.email", "t@t");
  git(live, "config", "user.name", "t");
  fs.writeFileSync(path.join(live, "a.txt"), "1\n");
  git(live, "add", "a.txt");
  git(live, "commit", "-q", "-m", "init");
  process.env.TASKFLOW_ROLE_WORKTREES = base;
});

afterAll(() => {
  if (previousBase === undefined) delete process.env.TASKFLOW_ROLE_WORKTREES;
  else process.env.TASKFLOW_ROLE_WORKTREES = previousBase;
  fs.rmSync(root, { recursive: true, force: true });
});

const VITEST_OUTPUT = `
 ❯ test/runtime/thinkingLevel.test.ts (5 tests | 3 failed) 120ms
 ✓ test/worktreeInspect.test.ts (5 tests) 40ms
 ❯ test/roles.test.ts (12 tests | 2 failed) 88ms
 FAIL  test/runtime/thinkingLevel.test.ts > MiniMax thinking > work: off
 FAIL  test/roles.test.ts > группа ролей > чтение

 Test Files  15 failed | 251 passed (266)
      Tests  36 failed | 1988 passed (2024)
`;

describe("гейт тестов при слиянии", () => {
  it("разбирает список упавших файлов из отчёта vitest", () => {
    const files = parseFailedTestFiles(VITEST_OUTPUT);
    expect(files).toContain("test/runtime/thinkingLevel.test.ts");
    expect(files).toContain("test/roles.test.ts");
    expect(files).not.toContain("test/worktreeInspect.test.ts");
    expect(files).toHaveLength(2);
  });

  it("без базы слияние не идёт — сначала нужно снять картину main", () => {
    saveBaseline(["test/roles.test.ts"], git(live, "rev-parse", "main"));
    expect(loadBaseline()?.failed_files).toEqual(["test/roles.test.ts"]);
  });

  it("совпадает с базой падений main — регрессии нет, слияние можно", () => {
    saveBaseline(["test/roles.test.ts", "test/runtime/thinkingLevel.test.ts"], git(live, "rev-parse", "main"));
    const gate = checkForRegression(VITEST_OUTPUT, live);
    expect(gate.ok).toBe(true);
    expect(gate.regressions).toEqual([]);
  });

  it("новый упавший файл — регрессия, слияние стоп", () => {
    const output = `${VITEST_OUTPUT}\n ❯ test/worktreeMergeQueue.test.ts (8 tests | 1 failed)\n`;
    saveBaseline(["test/roles.test.ts", "test/runtime/thinkingLevel.test.ts"], git(live, "rev-parse", "main"));
    const gate = checkForRegression(output, live);
    expect(gate.ok).toBe(false);
    expect(gate.regressions).toEqual(["test/worktreeMergeQueue.test.ts"]);
    expect(gate.reason).toContain("новые падения");
  });

  it("base уехала вместе с main — ждём новый снимок", () => {
    saveBaseline(["test/roles.test.ts"], "0000000000000000000000000000000000000000");
    const gate = checkForRegression(VITEST_OUTPUT, live);
    expect(gate.ok).toBe(false);
    expect(gate.staleBaseline).toBe(true);
  });

  it("выход без единого падения — регрессии нет", () => {
    const clean = " ✓ test/roles.test.ts (12 tests) 30ms\n Test Files 1 passed\n";
    saveBaseline(["test/roles.test.ts"], git(live, "rev-parse", "main"));
    expect(checkForRegression(clean, live).ok).toBe(true);
  });
});
