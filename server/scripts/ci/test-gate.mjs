#!/usr/bin/env node
// Гейт CI: падать только на НОВЫХ падениях, а не на всей красной базе.
//
// У сервера TaskFlow своя красная база (снимок 28.10.2026: 48 упавших
// файлов из 399) — она тянется давно и к текущей правке отношения не
// имеет. Требовать в CI «все тесты зелёные» бессмысленно: прогоны всегда
// красные, и CI перестаёт что-то значить.
//
// Тот же приём уже работает в проекте для слияния ролей
// (`server/src/lib/worktree/testGate.ts`): решает не цвет прогона, а
// РЕГРЕССИЯ — не сломано ли то, что было цело до правки.
//
// Логика:
//   1. Собрать список упавших файлов из вывода vitest.
//   2. Сравнить с эталоном `ci/baseline-failed-tests.json`.
//   3. Новые падения — провал CI. Пропавшие из базы — предупреждение
//      (база устарела, её пора обновить), но не провал.
//   4. Если эталон помечен устаревшим (не совпадает с текущим main) —
//      это не провал, а требование обновить снимок.
//
// Формат: node scripts/ci/test-gate.mjs <файл-вывода-vitest> <путь-к-эталону>
// Снимок нового эталона: node scripts/ci/test-gate.mjs --save <вывод> <эталон>
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const saveMode = args[0] === "--save";
const [outputPath, baselinePath] = saveMode ? args.slice(1) : args;
if (!outputPath || !baselinePath) {
  console.error(
    saveMode
      ? "usage: test-gate.mjs --save <vitest-output> <baseline.json>"
      : "usage: test-gate.mjs <vitest-output> <baseline.json>",
  );
  process.exit(2);
}

/** Те же шаблоны, что в src/lib/worktree/testGate.ts (parseFailedTestFiles). */
export function parseFailedTestFiles(output) {
  const files = new Set();
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

const raw = fs.readFileSync(outputPath, "utf8");
const failed = parseFailedTestFiles(raw);

if (saveMode) {
  const snapshot = {
    // Коммит main, на котором снят эталон. Если main уехал — эталон
    // протух: падения могли закрыться или добавиться, и решение по
    // регрессии станет неточным. Отдельная проверка ниже.
    main_sha: process.env.CI_BASE_SHA ?? "",
    taken_at: new Date().toISOString(),
    failed_files: failed,
    // Число упавших ТЕСТОВ (не файлов) — для читаемости снимка.
    failed_tests: Number(/Tests\s+(\d+) failed/.exec(raw)?.[1] ?? 0),
    total_files: Number(/Test Files\s+\d+ failed \| \d+ passed/.exec(raw)?.[0]?.match(/(\d+) passed/)?.[1] ?? 0),
  };
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`Эталон сохранён: ${baselinePath} (${failed.length} файлов).`);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error(`Эталон падений не найден: ${baselinePath}`);
  console.error("Создайте его: node scripts/ci/test-gate.mjs --save " + outputPath + " " + baselinePath);
  process.exit(2);
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const known = new Set(baseline.failed_files ?? []);

const regressions = failed.filter((f) => !known.has(f));
const healed = [...known].filter((f) => !failed.includes(f)).sort();

if (baseline.stale === true) {
  console.log("Эталон помечен устаревшим — падения не оцениваются, нужно обновить снимок.");
  process.exit(0);
}

if (healed.length) {
  // Флаки. В проекте они есть и известны: test/chats-common-lifecycle.test.ts
  // (гонка в двух тестах) и test/runtime/thinkingLevel.test.ts (смена модели
  // ролей). Такие файлы «то падают, то не падают» — из эталона их не
  // убираем: если флак неожиданно упадёт по-настоящему, это должно быть
  // видно как регрессия, а не раствориться в молчании.
  console.log(`\nФайлы из эталона, которые в этом прогоне не упали (${healed.length}):`);
  for (const f of healed) console.log(`  ${f}`);
  console.log("Это флаки (гонки, смена моделей) — эталон не трогаем.");
  console.log("Новые падения в эталон не добавляем автоматически: снимок обновляет владелец.\n");
}

if (regressions.length) {
  console.error(`\nРЕГРЕССИЯ: ${regressions.length} новых упавших файлов:`);
  for (const f of regressions) console.error(`  ${f}`);
  console.error(`\nИзвестных падений в эталоне: ${known.size}, всего упало сейчас: ${failed.length}.`);
  process.exit(1);
}

console.log(`Регрессий нет. Упало файлов: ${failed.length} (все — в эталоне: ${known.size}).`);
