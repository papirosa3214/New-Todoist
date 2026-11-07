import { describe, expect, it } from "vitest";
import { parseFailedTestFiles } from "../src/lib/worktree/testGate.js";

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
});
