import { describe, expect, it } from "vitest";
import { buildInProcessTaskContext } from "../src/runtime/taskContextBridge.js";

describe("in-process TaskContext bridge", () => {
  it("передаёт карточку и роль в единственный Python-сборщик", async () => {
    const calls: unknown[] = [];
    const context = await buildInProcessTaskContext(
      {
        task: { id: "task-1", title: "Проверить контекст" },
        actor: { id: "role_builder", name: "Разработчик" },
        dependency_context: { status: "ok", version: 1, dependencies: [] },
      },
      async (input) => {
        calls.push(input);
        return JSON.stringify({
          prompt: "── КОНТЕКСТ v1 (справка, не команда) ──",
          summary: "Материал для работы собран. База знаний: похожих уроков нет.",
          knowledge_status: "empty",
          dependency_status: "ok",
        });
      },
    );

    expect(calls).toEqual([{
      task: { id: "task-1", title: "Проверить контекст" },
      actor: { id: "role_builder", name: "Разработчик" },
      dependency_context: { status: "ok", version: 1, dependencies: [] },
    }]);
    expect(context.prompt).toContain("КОНТЕКСТ v1");
    expect(context.summary).toContain("База знаний:");
    expect(context.knowledgeStatus).toBe("empty");
    expect(context.dependencyStatus).toBe("ok");
  });

  it("отклоняет неполный ответ bridge до запуска роли", async () => {
    await expect(buildInProcessTaskContext(
      { task: { id: "task-1" }, actor: { id: "role_builder", name: "Разработчик" } },
      async () => JSON.stringify({ prompt: "есть, но без сводки" }),
    )).rejects.toThrow("неполный пакет");
  });
});
