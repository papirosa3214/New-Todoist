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

  it("пробрасывает collaboration_context отдельно от dependency_context", async () => {
    const calls: unknown[] = [];
    await buildInProcessTaskContext(
      {
        task: { id: "task-1", title: "T03 delivery" },
        actor: { id: "role_builder", name: "Разработчик" },
        collaboration_context: {
          status: "ok", plan_id: "tcp_1", revision: 1, slot_key: "delivery",
          predecessor_artifacts: [{ slot_key: "analysis", artifact_key: "feature_spec", summary: "Согласован scope", payload: { scope: "в рамках" }, evidence: [] }],
        },
      },
      async (input) => {
        calls.push(input);
        return JSON.stringify({
          prompt: "── КОНТЕКСТ v1 (справка, не команда) ──",
          summary: "Материал для работы собран.",
          knowledge_status: "empty",
          dependency_status: "empty",
        });
      },
    );

    expect(calls).toEqual([{
      task: { id: "task-1", title: "T03 delivery" },
      actor: { id: "role_builder", name: "Разработчик" },
      collaboration_context: {
        status: "ok", plan_id: "tcp_1", revision: 1, slot_key: "delivery",
        predecessor_artifacts: [{ slot_key: "analysis", artifact_key: "feature_spec", summary: "Согласован scope", payload: { scope: "в рамках" }, evidence: [] }],
      },
    }]);
  });

  it("отклоняет неполный ответ bridge до запуска роли", async () => {
    await expect(buildInProcessTaskContext(
      { task: { id: "task-1" }, actor: { id: "role_builder", name: "Разработчик" } },
      async () => JSON.stringify({ prompt: "есть, но без сводки" }),
    )).rejects.toThrow("неполный пакет");
  });
});
