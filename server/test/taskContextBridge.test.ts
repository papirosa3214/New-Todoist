import { describe, expect, it, vi } from "vitest";
import { buildInProcessTaskContext, type LaunchContextInput } from "../src/runtime/taskContextBridge.js";

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

  it("пробрасывает блок «Что уже было по этой карточке» в сборщик", async () => {
    const calls: unknown[] = [];
    await buildInProcessTaskContext(
      {
        task: { id: "task-1", title: "T03 delivery" },
        actor: { id: "role_qa", name: "QA" },
        task_history: { status: "ok", past_steps: 1, block: "── Что уже было по этой карточке ──" },
      },
      async (input) => {
        calls.push(input);
        return JSON.stringify({
          prompt: "── КОНТЕКСТ v1 ──",
          summary: "Материал для работы собран. Прошлые шаги: 1 шаг.",
          knowledge_status: "empty",
          dependency_status: "empty",
        });
      },
    );

    expect(calls).toEqual([{
      task: { id: "task-1", title: "T03 delivery" },
      actor: { id: "role_qa", name: "QA" },
      task_history: { status: "ok", past_steps: 1, block: "── Что уже было по этой карточке ──" },
    }]);
  });

  it("отклоняет неполный ответ bridge до запуска роли", async () => {
    await expect(buildInProcessTaskContext(
      { task: { id: "task-1" }, actor: { id: "role_builder", name: "Разработчик" } },
      async () => JSON.stringify({ prompt: "есть, но без сводки" }),
    )).rejects.toThrow("неполный пакет");
  });
});

// Карточка 71651ad0: первый запуск роли падает на «TaskContext >15 с».
// `buildInProcessTaskContext` обязан один раз попробовать снова, прежде
// чем сдаваться. Два сбоя подряд — уже реальная проблема, а не флак.
describe("buildInProcessTaskContext — автоповтор", () => {
  const sampleInput: LaunchContextInput = {
    task: { id: "task-1" },
    actor: { id: "role_builder", name: "Разработчик" },
  };

  it("первый сбой → второй успех: пробрасывает результат", async () => {
    const runner = vi.fn<Parameters<typeof buildInProcessTaskContext>[1]>()
      .mockRejectedValueOnce(new Error("сборка TaskContext v1 превысила 15 секунд"))
      .mockResolvedValueOnce(JSON.stringify({ prompt: "p", summary: "s", knowledge_status: "ok", dependency_status: "ok" }));
    const out = await buildInProcessTaskContext(sampleInput, runner);
    expect(out.prompt).toBe("p");
    expect(out.summary).toBe("s");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("два сбоя подряд — пробрасывает последнюю ошибку с упоминанием автоповтора", async () => {
    const runner = vi.fn<Parameters<typeof buildInProcessTaskContext>[1]>()
      .mockRejectedValueOnce(new Error("сборка TaskContext v1 превысила 15 секунд"))
      .mockRejectedValueOnce(new Error("сборка TaskContext v1 превысила 15 секунд"));
    await expect(buildInProcessTaskContext(sampleInput, runner)).rejects.toThrow(/после автоповтора/);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("успех с первого раза — повтора нет", async () => {
    const runner = vi.fn<Parameters<typeof buildInProcessTaskContext>[1]>()
      .mockResolvedValueOnce(JSON.stringify({ prompt: "p", summary: "s" }));
    const out = await buildInProcessTaskContext(sampleInput, runner);
    expect(out.prompt).toBe("p");
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
