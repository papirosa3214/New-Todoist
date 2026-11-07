// Спек 1.2, задача 1.2.4: POST /api/tasks/:id/consultation. Тесты
// проверяют серверную часть — лимит 1 на попытку и запись в
// consultation_log. Сам вызов модели подменён: настоящая консультация
// зависит от Ollama/Anthropic/Gemini, и в CI это было бы медленно и
// невоспроизводимо. Контракт с моделью — отдельная проверка в живом
// прогоне на одной из ступеней (см. заметку в документации проекта).
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";

const callAiMock = vi.hoisted(() => vi.fn());

vi.mock("../src/routes/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/ai.js")>();
  return {
    ...actual,
    callUnifiedAi: (...args: any[]) => callAiMock(...args),
  };
});

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { markReadyForPickup } = await import("./helpers.js");

describe("POST /api/tasks/:id/consultation (спек 1.2, 1.2.4)", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OwnerConsult",
        email: "owner-consult@test",
        password: "password123",
      },
    });
    ownerToken = owner.json().token;

    const agent = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "AgentConsult",
        email: "agent-consult@test",
        password: "password123",
      },
    });
    agentId = agent.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);
    agentToken = (
      await app.inject({
        method: "POST",
        url: "/api/auth/api-token",
        headers: { authorization: `Bearer ${agent.json().token}` },
      })
    ).json().api_token;
  });

  afterAll(async () => {
    await app.close();
  });

  async function setupTask(title: string): Promise<{
    taskId: string;
    attemptId: string;
  }> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title },
    });
    const taskId = created.json().task.id as string;
    markReadyForPickup(taskId);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(
      agentId,
      taskId,
    );
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { session_id: `seed-${taskId}` },
    });
    expect(claim.statusCode).toBe(200);
    return { taskId, attemptId: claim.json().task.current_attempt_id as string };
  }

  it("первая консультация проходит, вторая на том же attempt → 400 limit_exceeded", async () => {
    const { taskId, attemptId } = await setupTask("consult лимит");
    callAiMock.mockReset();
    callAiMock.mockResolvedValue("TEST_ANSWER_1");

    const first = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: attemptId,
        consultant_model: "opus",
        question: "как лучше: A или B?",
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().answer).toBe("TEST_ANSWER_1");
    expect(first.json().consultation_count).toBe(1);
    expect(callAiMock).toHaveBeenCalledTimes(1);

    // Счётчик вырос — попытка учтена как «использованная».
    const afterFirst = db
      .prepare("SELECT consultation_count FROM attempts WHERE id = ?")
      .get(attemptId) as { consultation_count: number };
    expect(afterFirst.consultation_count).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: attemptId,
        consultant_model: "opus",
        question: "а теперь?",
      },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toMatch(/limit_exceeded/);
    expect(second.json().error).toContain(attemptId);
    // Модель не дёрнули на втором запросе.
    expect(callAiMock).toHaveBeenCalledTimes(1);
  });

  it("consultation_log создаётся со всеми обязательными полями", async () => {
    const { taskId, attemptId } = await setupTask("consult лог");
    callAiMock.mockReset();
    callAiMock.mockResolvedValue("LOG_ANSWER");

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: attemptId,
        consultant_model: "sonnet",
        question: "Что делать с моим diff?",
        context: { git_diff_lines: 312 },
        triggered_by: "auto:diff_size",
      },
    });
    expect(res.statusCode).toBe(200);

    const rows = db
      .prepare(
        `SELECT id, attempt_id, task_id, consultant_model, question,
                context_json, answer, duration_ms, triggered_by, created_at
           FROM consultation_log
          WHERE attempt_id = ?
          ORDER BY created_at DESC`,
      )
      .all(attemptId) as Array<{
      id: string;
      attempt_id: string;
      task_id: string;
      consultant_model: string;
      question: string;
      context_json: string;
      answer: string;
      duration_ms: number;
      triggered_by: string;
      created_at: string;
    }>;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.attempt_id).toBe(attemptId);
    expect(row.task_id).toBe(taskId);
    expect(row.consultant_model).toBe("sonnet");
    expect(row.question).toBe("Что делать с моим diff?");
    expect(row.answer).toBe("LOG_ANSWER");
    expect(row.triggered_by).toBe("auto:diff_size");
    expect(typeof row.duration_ms).toBe("number");
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);

    const ctx = JSON.parse(row.context_json);
    expect(ctx.agent_context).toEqual({ git_diff_lines: 312 });
    expect(ctx.question).toBe("Что делать с моим diff?");
    expect(Array.isArray(ctx.attempts_history)).toBe(true);
    expect(ctx.current_attempt.id).toBe(attemptId);
  });

  it("consultant_model 'opus' идёт в callUnifiedAi как claude+opus, haiku — как local+qwen", async () => {
    const { taskId: t1, attemptId: a1 } = await setupTask("consult map opus");
    const { taskId: t2, attemptId: a2 } = await setupTask("consult map haiku");
    callAiMock.mockReset();
    const seen: Array<{ provider: string; aiModel?: string; localModel?: string }> = [];
    callAiMock.mockImplementation(async (opts: any) => {
      seen.push({
        provider: opts.provider,
        aiModel: opts.aiModel,
        localModel: opts.localModel,
      });
      return "OK";
    });

    await app.inject({
      method: "POST",
      url: `/api/tasks/${t1}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: a1,
        consultant_model: "opus",
        question: "q1",
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/tasks/${t2}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: a2,
        consultant_model: "haiku",
        question: "q2",
      },
    });

    expect(seen[0]).toEqual({
      provider: "claude",
      aiModel: "claude-opus-4-6-thinking",
      localModel: undefined,
    });
    expect(seen[1]).toEqual({
      provider: "local",
      aiModel: undefined,
      localModel: "qwen3.6-27b-iq4-16k:latest",
    });
  });

  it("ошибка модели → 502, счётчик НЕ инкрементируется (повторная попытка пройдёт)", async () => {
    const { taskId, attemptId } = await setupTask("consult error path");
    callAiMock.mockReset();
    callAiMock.mockImplementation(async () => {
      throw new Error("ollama is sad");
    });

    const failed = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: attemptId,
        consultant_model: "haiku",
        question: "q",
      },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toMatch(/ollama is sad/);
    expect(failed.json().consultation_count).toBe(0);
    expect(callAiMock).toHaveBeenCalledTimes(1);

    // Счётчик не вырос — лимит ещё доступен.
    const after = db
      .prepare("SELECT consultation_count FROM attempts WHERE id = ?")
      .get(attemptId) as { consultation_count: number };
    expect(after.consultation_count).toBe(0);

    // Лог записан и помечен как ошибочный для аудита.
    const row = db
      .prepare(
        "SELECT answer, triggered_by FROM consultation_log WHERE attempt_id = ?",
      )
      .get(attemptId) as { answer: string | null; triggered_by: string };
    expect(row.answer).toBeNull();
    expect(row.triggered_by).toMatch(/^error:/);

    // Восстанавливаем модель — повторный вызов проходит и съедает лимит.
    callAiMock.mockReset();
    callAiMock.mockResolvedValue("RECOVERED");
    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: attemptId,
        consultant_model: "haiku",
        question: "q2",
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().answer).toBe("RECOVERED");
    expect(callAiMock).toHaveBeenCalledTimes(1);
  });

  it("consult с чужим attempt_id → 400 attempt_id_mismatch", async () => {
    const { taskId } = await setupTask("consult wrong attempt");
    callAiMock.mockReset();
    callAiMock.mockResolvedValue("OK");

    const fake = "00000000-0000-0000-0000-000000000000";
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: fake,
        consultant_model: "opus",
        question: "q",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/attempt_id_mismatch/);
    expect(res.json().error).toContain(fake);
  });

  it("пустой question или отсутствующие поля → 400", async () => {
    const { taskId, attemptId } = await setupTask("consult validation");
    callAiMock.mockReset();
    callAiMock.mockResolvedValue("OK");

    const noQuestion = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { attempt_id: attemptId, consultant_model: "opus" },
    });
    expect(noQuestion.statusCode).toBe(400);

    const noModel = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { attempt_id: attemptId, question: "q" },
    });
    expect(noModel.statusCode).toBe(400);

    const noAttempt = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { consultant_model: "opus", question: "q" },
    });
    expect(noAttempt.statusCode).toBe(400);
  });
});
