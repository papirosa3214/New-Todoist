// Точечная проверка при слиянии (`worktreeMergeQueue.ts`, владелец 05.11.2026).

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
