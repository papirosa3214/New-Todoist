// Тесты ролям запрещены (владелец 02.11.2026): в обычной работе роль не
// гоняет ни полный набор, ни точечные тесты, ни UI-прогоны, ни съёмку кадров.
// Разрешение даёт владелец на конкретную карточку.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import {
  checkTestPermission,
  isTestCommand,
  testsAllowedForTask,
  withTestCommandGuard,
} from "../src/runtime/testRunBudget.js";

describe("isTestCommand: что считается тестовым запуском", () => {
  it.each([
    "vitest run",
    "npx vitest run",
    "../node_modules/.bin/vitest run",
    "cd server && ../node_modules/.bin/vitest run",
    "vitest run test/stalledStepWatcher.test.ts",
    "vitest run -t \"сторож\"",
    "npm test",
    "npm test -- test/x.test.ts",
    "npm run test",
    "pnpm test",
    "yarn test",
    "jest",
    "playwright test e2e/ui.spec.ts",
    "cypress run",
    "maestro test flows/x.yaml",
    "swift test",
    "xcodebuild -scheme TaskFlow test",
    "xcodebuild build-for-testing && xcodebuild test-without-building",
    "xcrun simctl io booted screenshot /tmp/shot.png",
  ])("запрещён: %s", cmd => expect(isTestCommand(cmd)).toBe(true));

  it.each([
    "git status",
    "ls test",
    "grep -rn vitest package.json",
    "cat test/foo.test.ts",
    "../node_modules/.bin/tsc --noEmit -p tsconfig.json",
    "npm run build",
    "npm run lint",
    "xcodebuild -scheme TaskFlow build",
    "curl -sS -m 8 -x http://127.0.0.1:10811 https://linear.app",
  ])("разрешён: %s", cmd => expect(isTestCommand(cmd)).toBe(false));

  it("тест внутри цепочки команд тоже ловится", () => {
    expect(isTestCommand("cd server && tsc --noEmit && vitest run | tail -5")).toBe(true);
    expect(isTestCommand("cd server && git status && npm run build")).toBe(false);
  });
});

let app: FastifyInstance;
const taskId = "test-permission-task";

beforeAll(async () => {
  app = await buildApp();
  db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  db.prepare("INSERT INTO tasks (id, title, creator_id, status) VALUES (?,?,?,?)").run(
    taskId,
    "Карточка без разрешения на тесты",
    (db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as { id: string }).id,
    "active",
  );
});

afterAll(async () => {
  // Чистка не обязана удачиться: тестовая база временная, а по карточке
  // могли остаться служебные строки с внешним ключом.
  try {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  } catch {
    /* временная база — не страшно */
  }
  await app?.close();
});

describe("разрешение на тесты", () => {
  it("без разрешения тесты запрещены, а карточка не тронута", () => {
    db.prepare("UPDATE tasks SET tests_allowed = 0 WHERE id = ?").run(taskId);
    expect(testsAllowedForTask(taskId)).toBe(false);
    const decision = checkTestPermission(taskId, "qa");
    expect(decision.allowed).toBe(false);
    expect((decision as { reason: string }).reason).toMatch(/запрещены/);
    expect((decision as { reason: string }).reason).toMatch(/разрешение/);
  });

  it("с разрешением владельца тесты проходят", () => {
    db.prepare("UPDATE tasks SET tests_allowed = 1 WHERE id = ?").run(taskId);
    expect(testsAllowedForTask(taskId)).toBe(true);
    expect(checkTestPermission(taskId, "qa")).toEqual({ allowed: true });
    db.prepare("UPDATE tasks SET tests_allowed = 0 WHERE id = ?").run(taskId);
  });

  it("владелец может дать и снять разрешение маршрутом", async () => {
    const owner = (db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as { id: string }).id;
    const token = app.jwt.sign({ id: owner });
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/allow-tests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { allowed: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { tests_allowed: boolean }).tests_allowed).toBe(true);
    expect(testsAllowedForTask(taskId)).toBe(true);

    const off = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/allow-tests`,
      headers: { authorization: `Bearer ${token}` },
      payload: { allowed: false },
    });
    expect(off.statusCode).toBe(200);
    expect(testsAllowedForTask(taskId)).toBe(false);
  });
});

describe("обёртка bash роли", () => {
  it("запрещённый запуск не выполняется и объясняет правило", async () => {
    let executed = false;
    const tool = {
      name: "bash",
      execute: async () => {
        executed = true;
        return "ok";
      },
    };
    const guarded = withTestCommandGuard(tool, { role: "qa", taskId });
    db.prepare("UPDATE tasks SET tests_allowed = 0 WHERE id = ?").run(taskId);
    await expect(
      guarded.execute("call-1", { command: "npx vitest run" }),
    ).rejects.toThrow(/запрещены/);
    expect(executed).toBe(false);

    // С разрешением — запуск проходит.
    db.prepare("UPDATE tasks SET tests_allowed = 1 WHERE id = ?").run(taskId);
    await guarded.execute("call-2", { command: "npx vitest run" });
    expect(executed).toBe(true);
    db.prepare("UPDATE tasks SET tests_allowed = 0 WHERE id = ?").run(taskId);
  });
});
