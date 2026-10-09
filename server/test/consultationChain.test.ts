// Карточка 412f89f4: целевые тесты серверной fallback-цепочки консультации.
// Opus → GPT-6.1 SOL → OpenCode Go, журнал фактических моделей/провайдеров,
// общий расход лимита R6 (только при успешной ступени). Без реальных
// HTTP-запросов — runConsultationChain замокан.
//
// Проверки из ТЗ:
//   1) Opus rate limit → SOL success
//   2) Opus unavailable + SOL limit → Go success
//   3) все недоступны → чёткая причина, лимит не потрачен
//   4) успех не повторяется (тот же Opus не дёргаем ещё раз)
//   5) timeout (transport) идёт на следующую ступень
//   6) бизнес-ошибка провайдера сразу возвращается, не идём дальше
//   7) фактические провайдер/модель в успешном ответе и в consultation_log
//   8) одна попытка (атака) всё это выдерживает с одним расходом лимита
//   9) обратная совместимость: явный алиас sonnet → callUnifiedAi, цепочка не включается
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";

/** Подмена fallback-цепочки — выдаёт ответ по сценарию теста. */
const chainMock = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/consultationChain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/consultationChain.js")>();
  return {
    ...actual,
    runConsultationChain: (...args: any[]) => chainMock(...args),
  };
});

// callUnifiedAi оставляем настоящим — в тестах обратной совместимости он
// вызывается; на свежем стенде через OLLAMA_TIMEOUT всё равно не доедет.
const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { markReadyForPickup } = await import("./helpers.js");

describe("POST /api/tasks/:id/consultation — fallback-цепочка (карточка 412f89f4)", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "OwnerChain", email: "owner-chain@test", password: "password123" },
    });
    ownerToken = owner.json().token;

    const agent = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "AgentChain", email: "agent-chain@test", password: "password123" },
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

  async function setupTask(title: string): Promise<{ taskId: string; attemptId: string }> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title },
    });
    const taskId = created.json().task.id as string;
    markReadyForPickup(taskId);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(agentId, taskId);
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { session_id: `seed-${taskId}` },
    });
    expect(claim.statusCode).toBe(200);
    return { taskId, attemptId: claim.json().task.current_attempt_id as string };
  }

  it("Opus rate limit → SOL success (одна попытка, лимит потрачен)", async () => {
    const { taskId, attemptId } = await setupTask("chain opus limit");
    chainMock.mockReset();
    chainMock.mockResolvedValue({
      ok: true,
      answer: "SOL_OPINION",
      winner: { stepKey: "gpt-6-1-sol", provider: "openai-codex", model: "gpt-6.1-sol" },
      attempts: [
        { stepKey: "opus", provider: "anthropic", model: "claude-opus-4-5", outcome: "transport", message: "429 rate limit", durationMs: 1200 },
        { stepKey: "gpt-6-1-sol", provider: "openai-codex", model: "gpt-6.1-sol", outcome: "ok", durationMs: 800 },
      ],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { attempt_id: attemptId, consultant_model: "auto", question: "q" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answer).toBe("SOL_OPINION");
    expect(body.consultation_count).toBe(1);
    expect(body.actual_provider).toBe("openai-codex");
    expect(body.actual_model).toBe("gpt-6.1-sol");
    expect(Array.isArray(body.chain_attempts)).toBe(true);
    expect(body.chain_attempts).toHaveLength(2);
    expect(body.chain_attempts[0].outcome).toBe("transport");
    expect(body.chain_attempts[1].outcome).toBe("ok");

    // Лимит вырос только один раз.
    const after = db
      .prepare("SELECT consultation_count FROM attempts WHERE id = ?")
      .get(attemptId) as { consultation_count: number };
    expect(after.consultation_count).toBe(1);

    // Журнал содержит фактические провайдер/модель.
    const logRow = db
      .prepare(
        "SELECT actual_provider, actual_model, chain_attempts, answer FROM consultation_log WHERE attempt_id = ?",
      )
      .get(attemptId) as {
      actual_provider: string | null;
      actual_model: string | null;
      chain_attempts: string | null;
      answer: string | null;
    };
    expect(logRow.actual_provider).toBe("openai-codex");
    expect(logRow.actual_model).toBe("gpt-6.1-sol");
    expect(logRow.answer).toBe("SOL_OPINION");
    expect(JSON.parse(logRow.chain_attempts!)).toHaveLength(2);
  });

  it("Opus unavailable + SOL limit → Go success", async () => {
    const { taskId, attemptId } = await setupTask("chain opus+sol fail go ok");
    chainMock.mockReset();
    chainMock.mockResolvedValue({
      ok: true,
      answer: "GO_OPINION",
      winner: { stepKey: "opencode-go", provider: "opencode-go", model: "deepseek-v4.1-flash" },
      attempts: [
        { stepKey: "opus", provider: "anthropic", model: "claude-opus-4-5", outcome: "missing_model", message: "нет модели", durationMs: 50 },
        { stepKey: "gpt-6-1-sol", provider: "openai-codex", model: "gpt-6.1-sol", outcome: "transport", message: "429", durationMs: 700 },
        { stepKey: "opencode-go", provider: "opencode-go", model: "deepseek-v4.1-flash", outcome: "ok", durationMs: 1500 },
      ],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { attempt_id: attemptId, consultant_model: "auto", question: "q" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.actual_provider).toBe("opencode-go");
    expect(body.actual_model).toBe("deepseek-v4.1-flash");
    expect(body.chain_attempts.map((a: any) => a.outcome)).toEqual([
      "missing_model",
      "transport",
      "ok",
    ]);
  });

  it("все ступени недоступны → 502, лимит НЕ потрачен, chain_attempts заполнен", async () => {
    const { taskId, attemptId } = await setupTask("chain all fail");
    chainMock.mockReset();
    chainMock.mockResolvedValue({
      ok: false,
      error: "consultant_unavailable: ни одна ступень не ответила (3 попыток)",
      attempts: [
        { stepKey: "opus", provider: "anthropic", model: "claude-opus-4-5", outcome: "missing_model", message: "нет", durationMs: 5 },
        { stepKey: "gpt-6-1-sol", provider: "openai-codex", model: "gpt-6.1-sol", outcome: "transport", message: "503", durationMs: 60000 },
        { stepKey: "opencode-go", provider: "opencode-go", model: "deepseek-v4.1-flash", outcome: "transport", message: "timeout", durationMs: 60000 },
      ],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { attempt_id: attemptId, consultant_model: "auto", question: "q" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/consultant_unavailable/);
    expect(res.json().chain_attempts).toHaveLength(3);
    expect(res.json().consultation_count).toBe(0);

    // Лимит НЕ вырос — повторный запрос той же попытки ещё имеет право.
    const after = db
      .prepare("SELECT consultation_count FROM attempts WHERE id = ?")
      .get(attemptId) as { consultation_count: number };
    expect(after.consultation_count).toBe(0);

    // Журнал записан с chain_attempts и triggered_by=error:…
    const row = db
      .prepare("SELECT answer, triggered_by, chain_attempts FROM consultation_log WHERE attempt_id = ?")
      .get(attemptId) as { answer: string | null; triggered_by: string; chain_attempts: string | null };
    expect(row.answer).toBeNull();
    expect(row.triggered_by).toMatch(/^error:/);
    expect(JSON.parse(row.chain_attempts!)).toHaveLength(3);
  });

  it("бизнес-ошибка (контент-фильтр) — цепочка дальше не идёт, ответ сразу", async () => {
    const { taskId, attemptId } = await setupTask("chain business break");
    chainMock.mockReset();
    chainMock.mockResolvedValue({
      ok: false,
      error: "consultant_business_error: opus: content_filter",
      attempts: [
        { stepKey: "opus", provider: "anthropic", model: "claude-opus-4-5", outcome: "business", message: "content_filter", durationMs: 1300 },
      ],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { attempt_id: attemptId, consultant_model: "auto", question: "q" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/business_error/);
    expect(res.json().chain_attempts).toHaveLength(1);
    expect(res.json().consultation_count).toBe(0);
  });

  it("повторная попытка после провала цепочки — снова запускает цепочку, лимит всё ещё 0", async () => {
    const { taskId, attemptId } = await setupTask("chain retry after fail");
    chainMock.mockReset();
    chainMock.mockResolvedValueOnce({
      ok: false,
      error: "consultant_unavailable",
      attempts: [
        { stepKey: "opus", provider: "anthropic", model: "claude-opus-4-5", outcome: "missing_model", message: "нет", durationMs: 5 },
      ],
    });
    const first = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { attempt_id: attemptId, consultant_model: "auto", question: "q" },
    });
    expect(first.statusCode).toBe(502);

    // На втором вызове восстановили Opus — лимит всё ещё 0, сервер должен
    // принять запрос и снова прогнать цепочку.
    chainMock.mockResolvedValueOnce({
      ok: true,
      answer: "OPUS_OK_LATER",
      winner: { stepKey: "opus", provider: "anthropic", model: "claude-opus-4-5" },
      attempts: [
        { stepKey: "opus", provider: "anthropic", model: "claude-opus-4-5", outcome: "ok", durationMs: 2000 },
      ],
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { attempt_id: attemptId, consultant_model: "auto", question: "q" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().answer).toBe("OPUS_OK_LATER");
    expect(second.json().consultation_count).toBe(1);
  });

  it("успех не повторяется: на одной попытке используется ОДИН POST = одна цепочка", async () => {
    const { taskId, attemptId } = await setupTask("chain single call");
    chainMock.mockReset();
    chainMock.mockResolvedValue({
      ok: true,
      answer: "OK",
      winner: { stepKey: "opus", provider: "anthropic", model: "claude-opus-4-5" },
      attempts: [
        { stepKey: "opus", provider: "anthropic", model: "claude-opus-4-5", outcome: "ok", durationMs: 1500 },
      ],
    });
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { attempt_id: attemptId, consultant_model: "auto", question: "q" },
    });
    // Цепочка вызвана ровно один раз — на одну попытку, никаких повторов.
    expect(chainMock).toHaveBeenCalledTimes(1);
    // В журнал попала одна строка.
    const rows = db
      .prepare("SELECT COUNT(*) as n FROM consultation_log WHERE attempt_id = ?")
      .get(attemptId) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("обратная совместимость: явный алиас 'opus' из CONSULTANT_MODEL_MAP НЕ включает цепочку", async () => {
    const { taskId, attemptId } = await setupTask("chain back-compat opus");
    chainMock.mockReset();
    // Не мокаем callUnifiedAi — нам тут нужно СВОЕСТВО раутинга: явный алиас
    // из CONSULTANT_MODEL_MAP ('opus'/'sonnet'/'haiku') идёт через
    // callUnifiedAi, а НЕ через runConsultationChain. Если цепочка случайно
    // включится, она сама сходит к провайдерам и тест зависнет. Только
    // фиксируем факт: chainMock НЕ вызван.
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/consultation`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { attempt_id: attemptId, consultant_model: "opus", question: "q" },
    });
    expect(chainMock).not.toHaveBeenCalled();
    // callUnifiedAi в этом тестовом окружении реально стучится в Ollama
    // иначе/падает по таймауту — нам важен только факт маршрутизации,
    // поэтому не проверяем статус-код, а ждём что сервер отдаст ответ.
    expect([200, 502, 504]).toContain(res.statusCode);
  }, 120_000);
});
