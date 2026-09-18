import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";
import { piRuntime } from "../../src/runtime/index.js";
import { UnsupportedInFacadeError } from "../../src/runtime/RuntimeAdapter.js";

describe("PiRuntimeAdapter", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    // Подсеять ролевые учётки для listProfiles. Миграция 005 их создаёт,
    // но в тестовой БД может не быть — добавляем idempotently.
    db.prepare(`INSERT OR IGNORE INTO users (id, name, role, type) VALUES
      ('role_architect', 'Архитектор', 'architect', 'ai'),
      ('role_qa', 'QA', 'qa', 'ai')`).run();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("id is runtime:pi", () => {
    expect(piRuntime.id).toBe("runtime:pi");
  });

  it("status returns a Runtime with required fields", async () => {
    const status = await piRuntime.status();
    expect(status.id).toBe("runtime:pi");
    expect(status.kind).toBe("pi");
    expect(["ready", "starting", "down"]).toContain(status.status);
    expect(typeof status.version).toBe("string");
    expect(typeof status.endpoint).toBe("string");
  });

  it("listProfiles returns 8 profiles, all runtime_id = runtime:pi", async () => {
    const profiles = await piRuntime.listProfiles();
    expect(profiles).toHaveLength(8);
    for (const p of profiles) {
      expect(p.runtime_id).toBe("runtime:pi");
      expect(typeof p.title).toBe("string");
      expect(p.modelPolicy).toBeDefined();
    }
  });

  it("listModels returns unique models with runtime_id", async () => {
    const models = await piRuntime.listModels();
    expect(models.length).toBeGreaterThan(0);
    const ids = new Set(models.map((m) => m.id));
    expect(ids.size).toBe(models.length); // все уникальны
    for (const m of models) expect(m.runtime_id).toBe("runtime:pi");
  });

  it("listProviders returns 3 known providers with managedBy=pi", async () => {
    const providers = await piRuntime.listProviders();
    expect(providers.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(providers.map((p) => p.id));
    expect(ids.has("anthropic")).toBe(true);
    expect(ids.has("openai")).toBe(true);
    expect(ids.has("minimax")).toBe(true);
    for (const p of providers) {
      expect(p.runtime_id).toBe("runtime:pi");
      expect(p.managedBy).toBe("pi");
    }
  });

  it("startRun throws UnsupportedInFacadeError mentioning trigger.py", async () => {
    await expect(
      piRuntime.startRun({
        taskId: "task-x",
        agentId: "architect",
        prompt: "do thing",
      }),
    ).rejects.toBeInstanceOf(UnsupportedInFacadeError);
    await expect(
      piRuntime.startRun({
        taskId: "task-x",
        agentId: "architect",
        prompt: "do thing",
      }),
    ).rejects.toThrow(/trigger\.py/);
  });

  it("sendMessage and cancelRun throw UnsupportedInFacadeError", async () => {
    await expect(piRuntime.sendMessage("run-1", "hi")).rejects.toBeInstanceOf(
      UnsupportedInFacadeError,
    );
    await expect(piRuntime.cancelRun("run-1")).rejects.toBeInstanceOf(
      UnsupportedInFacadeError,
    );
  });

  it("getRun returns AgentRun facade for an existing task", async () => {
    // Создать задачу для теста — assignor_id может быть любым.
    db.prepare(
      `INSERT OR IGNORE INTO tasks (id, title, status) VALUES (?, ?, 'active')`,
    ).run("task-facade-test", "test");
    const run = await piRuntime.getRun("task-facade-test");
    expect(run.task_id).toBe("task-facade-test");
    expect(run.runtime_id).toBe("runtime:pi");
  });

  it("getRun throws for missing task", async () => {
    await expect(piRuntime.getRun("nonexistent-task-id")).rejects.toThrow(
      /не найдена/,
    );
  });
});
