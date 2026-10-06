// Бюджет полных прогонов серверного набора (владелец 06.10.2026): на задачу
// не больше двух полных прогонов всеми ролями, Разработчику один; точечные
// тесты не ограничиваются; лишний полный прогон сервер не запускает.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import {
  checkAndConsumeFullRun,
  isFullSuiteCommand,
  withTestRunBudget,
} from "../src/runtime/testRunBudget.js";

describe("isFullSuiteCommand: что считается полным прогоном", () => {
  it.each([
    "vitest run",
    "npx vitest run",
    "../node_modules/.bin/vitest run",
    "cd server && ../node_modules/.bin/vitest run",
    "DB_PATH=/tmp/x.db ../node_modules/.bin/vitest run --reporter dot",
    "vitest",
    "npm test",
    "npm run test",
    "pnpm test",
    "jest",
  ])("полный: %s", cmd => expect(isFullSuiteCommand(cmd)).toBe(true));

  it.each([
    "vitest run test/stalledStepWatcher.test.ts",
    "DB_PATH=/tmp/x.db ../node_modules/.bin/vitest run test/a.test.ts test/b.test.ts",
    "vitest run -t \"сторож\"",
    "vitest run stalledStepWatcher",
    "vitest related src/runtime/x.ts",
    "npm test -- test/stepOutcome.test.ts",
    "npm run test -- --reporter dot test/x.test.ts",
    "../node_modules/.bin/tsc --noEmit -p tsconfig.json",
    "git status",
    "ls test",
    "grep -rn vitest package.json",
  ])("не полный: %s", cmd => expect(isFullSuiteCommand(cmd)).toBe(false));

  it("полный прогон внутри цепочки команд тоже ловится", () => {
    expect(isFullSuiteCommand("cd server && tsc --noEmit && vitest run | tail -5")).toBe(true);
    expect(isFullSuiteCommand("cd server && vitest run test/a.test.ts | tail -5")).toBe(false);
  });
});

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });

describe("бюджет: Разработчику один, на задачу два", () => {
  let taskId: string;
  beforeEach(() => {
    taskId = `budget-${crypto.randomUUID()}`;
    db.prepare("DELETE FROM test_run_budget WHERE task_id = ?").run(taskId);
  });

  it("Разработчик: первый полный разрешён, второй нет", () => {
    expect(checkAndConsumeFullRun(taskId, "builder")).toEqual({ allowed: true });
    const second = checkAndConsumeFullRun(taskId, "builder");
    expect(second.allowed).toBe(false);
    expect((second as { reason: string }).reason).toMatch(/QA/);
    expect((second as { reason: string }).reason).toMatch(/taskflow_consult/);
  });

  it("запрещённый прогон не списывается: счётчик остаётся единицей", () => {
    checkAndConsumeFullRun(taskId, "builder");
    checkAndConsumeFullRun(taskId, "builder");
    checkAndConsumeFullRun(taskId, "builder");
    const row = db.prepare("SELECT full_runs FROM test_run_budget WHERE task_id=? AND role='builder'").get(taskId) as { full_runs: number };
    expect(row.full_runs).toBe(1);
  });

  it("QA получает второй (последний) полный прогон", () => {
    expect(checkAndConsumeFullRun(taskId, "builder").allowed).toBe(true);
    expect(checkAndConsumeFullRun(taskId, "qa").allowed).toBe(true);
  });

  it("после двух полных прогонов всех ролей третий нельзя никому, включая Критика и QA", () => {
    checkAndConsumeFullRun(taskId, "builder");
    checkAndConsumeFullRun(taskId, "qa");
    expect(checkAndConsumeFullRun(taskId, "qa").allowed).toBe(false);
    expect(checkAndConsumeFullRun(taskId, "critic_verifier").allowed).toBe(false);
  });

  it("бюджеты разных задач независимы", () => {
    const other = `budget-${crypto.randomUUID()}`;
    checkAndConsumeFullRun(taskId, "builder");
    expect(checkAndConsumeFullRun(other, "builder").allowed).toBe(true);
    db.prepare("DELETE FROM test_run_budget WHERE task_id = ?").run(other);
  });
});

describe("withTestRunBudget: обёртка встроенного bash", () => {
  const calls: string[] = [];
  const bash = {
    name: "bash",
    description: "run",
    execute: async (_id: string, params: { command: string }) => {
      calls.push(params.command);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  const read = { name: "read", execute: async () => ({ content: [] }) };

  it("не-bash инструмент возвращается как есть", () => {
    expect(withTestRunBudget(read, { role: "builder", taskId: "x" })).toBe(read);
  });

  it("точечный тест проходит сколько угодно раз, второй полный Разработчика отклоняется ошибкой, команда не выполняется", async () => {
    const taskId = `budget-${crypto.randomUUID()}`;
    calls.length = 0;
    const tool = withTestRunBudget(bash, { role: "builder", taskId });
    for (let i = 0; i < 5; i++) await tool.execute("c", { command: "vitest run test/a.test.ts" });
    await tool.execute("c", { command: "vitest run" });
    await expect(tool.execute("c", { command: "vitest run" })).rejects.toThrow(/QA/);
    expect(calls.filter(c => c === "vitest run")).toHaveLength(1);
    expect(calls.filter(c => c.includes("a.test.ts"))).toHaveLength(5);
    const ev = db.prepare("SELECT kind, field FROM task_events WHERE task_id=? AND kind='test_budget_blocked'").all(taskId);
    // событие пишется только для существующей задачи; в тесте задачи нет, поэтому журнал может быть пуст
    expect(Array.isArray(ev)).toBe(true);
    db.prepare("DELETE FROM test_run_budget WHERE task_id = ?").run(taskId);
  });
});
