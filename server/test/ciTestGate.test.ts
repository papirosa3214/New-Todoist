import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// Гейт CI падает только на НОВЫХ падениях, а не на всей красной базе
// сервера (48 файлов на снимок 28.10.2026). Тот же приём, что в
// src/lib/worktree/testGate.ts для слияния ролей.
const GATE = join(process.cwd(), "scripts", "ci", "test-gate.mjs");

function runGate(output: string, baseline: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
  try {
    const outFile = join(dir, "vitest.log");
    const baseFile = join(dir, "baseline.json");
    writeFileSync(outFile, output);
    writeFileSync(baseFile, JSON.stringify(baseline));
    try {
      const stdout = execFileSync("node", [GATE, outFile, baseFile], {
        encoding: "utf8",
      });
      return { code: 0, stdout };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FALLING = "FAIL  test/alpha.test.ts > alpha > упало\n";
const PASSING_LOG = "Test Files  1 passed (1)\n";

describe("гейт CI по регрессиям", () => {
  it("падает, когда упал новый файл, которого нет в эталоне", () => {
    const result = runGate(FALLING, { failed_files: ["test/other.test.ts"] });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("test/alpha.test.ts");
  });

  it("не падает, когда упавшее есть в эталоне", () => {
    const result = runGate(FALLING, { failed_files: ["test/alpha.test.ts"] });
    expect(result.code).toBe(0);
  });

  it("не падает на флаке: файл из эталона в этом прогоне не упал", () => {
    const result = runGate(PASSING_LOG, { failed_files: ["test/flaky.test.ts"] });
    expect(result.code).toBe(0);
  });

  it("пустой эталон: любое падение — регрессия", () => {
    const result = runGate(FALLING, { failed_files: [] });
    expect(result.code).toBe(1);
  });

  it("эталон помечен устаревшим — решение по падениям не принимается", () => {
    const result = runGate(FALLING, { failed_files: [], stale: true });
    expect(result.code).toBe(0);
  });

  it("отсутствующий эталон — ошибка запуска, а не «всё хорошо»", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
    try {
      const outFile = join(dir, "vitest.log");
      writeFileSync(outFile, FALLING);
      let code = 0;
      try {
        execFileSync("node", [GATE, outFile, join(dir, "нет-такого.json")], {
          encoding: "utf8",
        });
      } catch (error) {
        code = (error as { status?: number }).status ?? 1;
      }
      expect(code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
