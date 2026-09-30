import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";
import { piRuntime } from "../../src/runtime/index.js";
import { resetModelRuntime } from "../../src/runtime/PiRuntimeAdapter.js";
import { UnsupportedInFacadeError } from "../../src/runtime/RuntimeAdapter.js";
import {
  ModelNotAvailableError,
  RuntimeUnavailableError,
} from "../../src/runtime/errors.js";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";

// 18.09.2026 (доработка после ревью владельца). Что проверяем:
//  - agent_end НЕ завершает AgentRun и не гасит RpcClient.
//  - agent_settled завершает run; итог берётся из stopReason/cancel, а не
//    из несуществующего boolean success.
//  - sessionId берётся через client.getState(), а не из session_start.
//  - runId уникален (run_<uuid>).
//  - startRun реально передаёт выбранные provider/model в RpcClient.
//  - provider list строится из getProviders() (disconnected не исчезает).
//  - Pi offline → RuntimeUnavailableError; нет модели → ModelNotAvailableError.
//
// SDK замокан целиком: ModelRuntime.create() и RpcClient не поднимают Pi.

const CATALOG = [
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    name: "Sonnet 5",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
  },
  {
    id: "gpt-5",
    provider: "openai-codex",
    name: "GPT-5",
    contextWindow: 400_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
  },
  {
    id: "minimax-m3",
    provider: "minimax",
    name: "MiniMax M3",
    contextWindow: 200_000,
    maxTokens: 64_000,
    reasoning: false,
    input: ["text"],
  },
];

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", auth: { oauth: {}, apiKey: {} } },
  { id: "openai-codex", name: "OpenAI (Codex)", auth: { oauth: {} } },
  { id: "minimax", name: "MiniMax", auth: { apiKey: {} } },
];

// Разделяемое с vi.mock состояние. vi.mock хойстится, поэтому берём
// vi.hoisted — иначе factory окажется раньше инициализации.
const mockState = vi.hoisted(() => ({
  createShouldFail: false,
  connected: new Set<string>(),
  authTypeByProvider: {
    anthropic: "oauth",
    "openai-codex": "oauth",
    minimax: "api_key",
  } as Record<string, string>,
  loginBehavior: null as
    | null
    | ((args: { provider: string; type: string; interaction: any }) => Promise<any>),
}));

const mockRuntime = {
  getModels: vi.fn(() => CATALOG),
  getAvailable: vi.fn(async () =>
    CATALOG.filter((m) => mockState.connected.has(m.provider)),
  ),
  getProviders: vi.fn(() => PROVIDERS),
  getProvider: vi.fn((id: string) => PROVIDERS.find((p) => p.id === id)),
  getProviderAuthStatus: vi.fn((id: string) => ({
    configured: mockState.connected.has(id),
  })),
  checkAuth: vi.fn(async (id: string) =>
    mockState.connected.has(id)
      ? { type: mockState.authTypeByProvider[id] }
      : undefined,
  ),
  login: vi.fn(async (provider: string, type: string, interaction: any) => {
    if (mockState.loginBehavior) {
      return mockState.loginBehavior({ provider, type, interaction });
    }
    if (type === "api_key") {
      const key = await interaction.prompt({ type: "secret", message: "key" });
      mockState.connected.add(provider);
      return { type: "api_key", key };
    }
    interaction.notify({ type: "auth_url", url: "https://example.com/oauth" });
    await new Promise<never>((_resolve, reject) => {
      interaction.signal.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    });
    mockState.connected.add(provider);
    return { type: "oauth" };
  }),
  refresh: vi.fn(async () => ({})),
  getError: vi.fn(() => undefined),
  setRuntimeApiKey: vi.fn(async () => {}),
  isUsingOAuth: vi.fn(() => false),
  isUsingSubscription: vi.fn(() => false),
  hasConfiguredAuth: vi.fn((id: string) => mockState.connected.has(id)),
  logout: vi.fn(async (id: string) => {
    mockState.connected.delete(id);
  }),
};

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => { const actual=await importOriginal<any>(); return { ...actual,
  getPackageDir: () => "/mock/pi-pkg",
  ModelRuntime: {
    create: vi.fn(async () => {
      if (mockState.createShouldFail) throw new Error("pi offline");
      return mockRuntime;
    }),
  },
  RpcClient: vi.fn().mockImplementation(function (options: any) {
    return makeFakeRpcClient(options);
  }),
}; });

interface FakeRpcClient {
  options: any;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  getLastAssistantText: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  emit: (event: unknown) => void;
}

const fakeClients: FakeRpcClient[] = [];

function makeFakeRpcClient(options: any): FakeRpcClient {
  const listeners: Array<(event: unknown) => void> = [];
  const client: FakeRpcClient = {
    options,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    getState: vi.fn(async () => ({
      sessionId: "sess-real-1",
      model: {
        provider: options?.provider ?? "anthropic",
        id: options?.model ?? "claude-sonnet-5",
      },
    })),
    getLastAssistantText: vi.fn(async () => "final answer"),
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event);
    },
  };
  fakeClients.push(client);
  return client;
}

function lastClient(): FakeRpcClient {
  const client = fakeClients.at(-1);
  if (!client) throw new Error("no fake RpcClient created");
  return client;
}

async function tick(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function seedTask(id: string, dispatchedRole = "architect"): void {
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id, title, status, dispatched_role)
     VALUES (?, ?, 'active', ?)`,
  ).run(id, `test ${id}`, dispatchedRole);
}

function attemptRow(runId: string) {
  return db
    .prepare(
      `SELECT id, model, provider, session_id, ended_at, outcome, reason
         FROM attempts WHERE id = ?`,
    )
    .get(runId) as
    | {
        id: string;
        model: string | null;
        provider: string | null;
        session_id: string | null;
        ended_at: string | null;
        outcome: string | null;
        reason: string | null;
      }
    | undefined;
}

beforeEach(() => {
  fakeClients.length = 0;
  mockState.createShouldFail = false;
  mockState.connected.clear();
  mockState.loginBehavior = null;
  // Singleton ModelRuntime кэшируется между тестами: без сброса
  // createShouldFail=true не подействует (create уже вызывался).
  resetModelRuntime();
  mockRuntime.getModels.mockImplementation(() => CATALOG);
  mockRuntime.getAvailable.mockImplementation(async () =>
    CATALOG.filter((m) => mockState.connected.has(m.provider)),
  );
  mockRuntime.getProviders.mockImplementation(() => PROVIDERS);
});

describe("PiRuntimeAdapter", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    db.prepare(`INSERT OR IGNORE INTO users
      (id, name, email, password_hash, role, role_key, type, is_system_bot) VALUES
      ('role_architect', 'Архитектор', 'architect-runtime@test', '!test', 'agent', 'architect', 'ai', 1),
      ('role_qa', 'QA', 'qa-runtime@test', '!test', 'agent', 'qa', 'ai', 1)`).run();
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
  });

  it("listProfiles returns 8 profiles, all runtime_id = runtime:pi", async () => {
    const profiles = await piRuntime.listProfiles();
    expect(profiles).toHaveLength(8);
    expect(profiles.find((p) => p.role === "secretary")?.title).toBe("Секретарь");
    for (const p of profiles) expect(p.runtime_id).toBe("runtime:pi");
  });

  // === RUN LIFECYCLE ===

  it("1. agent_end НЕ завершает AgentRun", async () => {
    seedTask("task-lifecycle-1");
    const { runId } = await piRuntime.startRun({
      taskId: "task-lifecycle-1",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
    });
    const client = lastClient();
    client.emit({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
      willRetry: false,
    });
    await tick();

    expect(client.stop).not.toHaveBeenCalled();
    const row = attemptRow(runId);
    expect(row?.ended_at).toBeNull();
    const task = db
      .prepare("SELECT agent_state FROM tasks WHERE id = ?")
      .get("task-lifecycle-1") as { agent_state: string };
    expect(task.agent_state).toBe("in_progress");
  });

  it("2. agent_end + retry не приводит к blocked", async () => {
    seedTask("task-lifecycle-2");
    const { runId } = await piRuntime.startRun({
      taskId: "task-lifecycle-2",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
    });
    const client = lastClient();
    client.emit({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider_limit" }],
      willRetry: true,
    });
    await tick();
    const task = db
      .prepare("SELECT agent_state FROM tasks WHERE id = ?")
      .get("task-lifecycle-2") as { agent_state: string };
    expect(task.agent_state).toBe("in_progress");
    expect(attemptRow(runId)?.ended_at).toBeNull();
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("3. agent_settled завершает run", async () => {
    seedTask("task-lifecycle-3");
    const { runId } = await piRuntime.startRun({
      taskId: "task-lifecycle-3",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
    });
    const client = lastClient();
    client.emit({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
      willRetry: false,
    });
    client.emit({ type: "agent_settled" });
    await tick();

    expect(client.stop).toHaveBeenCalledTimes(1);
    const row = attemptRow(runId);
    expect(row?.ended_at).not.toBeNull();
    expect(row?.outcome).toBe("completed");
    const task = db
      .prepare("SELECT agent_state FROM tasks WHERE id = ?")
      .get("task-lifecycle-3") as { agent_state: string };
    expect(task.agent_state).toBe("review");
    const run = await piRuntime.getRun(runId);
    expect(run.status).toBe("completed");
  });

  // Роль ходит в трекер пропуском, который подписал сам сервер, — без
  // ключей из хранилища (23.09.2026). Файл подключения живёт только на
  // время запуска.
  it("5. запуск роли получает временный доступ к трекеру и теряет его по завершении", async () => {
    const fs = await import("node:fs");
    const { resolveUserIdFromToken } = await import("../../src/auth.js");
    seedTask("task-access-5");
    await piRuntime.startRun({
      taskId: "task-access-5",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
    });
    const client = lastClient();
    const args: string[] = client.options.args ?? [];
    expect(args[0]).toBe("--mcp-config");
    const file = args[1];
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const env = config.mcpServers.taskflow.env;
    expect(env.TASKFLOW_MCP_ROLE).toBe("architect");
    expect(env.TASKFLOW_MCP_TOOLS).toContain("taskflow_claim");
    expect(resolveUserIdFromToken(app, env.TASKFLOW_TOKEN)).toBe("role_architect");
    expect(fs.statSync(file).mode & 0o077).toBe(0);

    client.emit({ type: "agent_settled" });
    await tick();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("4. client.stop() не вызывается автоматически на agent_end", async () => {
    seedTask("task-lifecycle-4");
    await piRuntime.startRun({
      taskId: "task-lifecycle-4",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
    });
    const client = lastClient();
    client.emit({ type: "agent_end", messages: [], willRetry: false });
    await tick();
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("1b. успешная continuation затирает промежуточную ошибку, run completed", async () => {
    seedTask("task-lastturn");
    const { runId } = await piRuntime.startRun({
      taskId: "task-lastturn",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
    });
    const client = lastClient();
    // Ход с ошибкой (например, provider_limit) — agent_end НЕ терминален:
    // run продолжается, term-полей нет.
    client.emit({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider_limit" }],
      willRetry: false,
    });
    await tick();
    expect(client.stop).not.toHaveBeenCalled();
    expect(attemptRow(runId)?.ended_at).toBeNull();
    const mid = db
      .prepare("SELECT agent_state FROM tasks WHERE id = ?")
      .get("task-lastturn") as { agent_state: string };
    expect(mid.agent_state).toBe("in_progress");

    // Успешная continuation после compaction перезаписывает промежуточную
    // ошибку; итог считается только на agent_settled.
    client.emit({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
    });
    client.emit({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
      willRetry: false,
    });
    client.emit({ type: "agent_settled" });
    await tick();

    const run = await piRuntime.getRun(runId);
    expect(run.status).toBe("completed");
    expect(attemptRow(runId)?.outcome).toBe("completed");
    const task = db
      .prepare("SELECT agent_state FROM tasks WHERE id = ?")
      .get("task-lastturn") as { agent_state: string };
    expect(task.agent_state).toBe("review");
  });

  it("3. второй startRun на тот же task штатно отменяет первый run", async () => {
    seedTask("task-single-run");
    const first = await piRuntime.startRun({
      taskId: "task-single-run",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "one",
    });
    const client1 = lastClient();
    const second = await piRuntime.startRun({
      taskId: "task-single-run",
      agentId: "architect",
      provider: "openai-codex",
      model: "gpt-5",
      prompt: "two",
    });
    const client2 = lastClient();
    expect(client1).not.toBe(client2);
    expect(client1.abort).toHaveBeenCalledTimes(1);

    expect((await piRuntime.getRun(first.runId)).status).toBe("cancelled");
    expect((await piRuntime.getRun(second.runId)).status).toBe("running");

    // На задачу остаётся ровно одна активная попытка, и указывает она на
    // новый run.
    const active = db
      .prepare(
        `SELECT COUNT(*) AS n FROM attempts
          WHERE task_id = ? AND subtask_id IS NULL AND ended_at IS NULL`,
      )
      .get("task-single-run") as { n: number };
    expect(active.n).toBe(1);
    const task = db
      .prepare("SELECT current_attempt_id FROM tasks WHERE id = ?")
      .get("task-single-run") as { current_attempt_id: string };
    expect(task.current_attempt_id).toBe(second.runId);
  });

  // === SESSION ===

  it("5. sessionId после start берётся через getState()", async () => {
    seedTask("task-session-5");
    const result = await piRuntime.startRun({
      taskId: "task-session-5",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
    });
    expect(lastClient().getState).toHaveBeenCalled();
    expect(result.sessionId).toBe("sess-real-1");
    expect(result.status).toBe("running");
  });

  it("6. AgentRun сохраняет реальный sessionId", async () => {
    seedTask("task-session-6");
    const { runId } = await piRuntime.startRun({
      taskId: "task-session-6",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
    });
    expect(attemptRow(runId)?.session_id).toBe("sess-real-1");
    const task = db
      .prepare("SELECT agent_session_id FROM tasks WHERE id = ?")
      .get("task-session-6") as { agent_session_id: string };
    expect(task.agent_session_id).toBe("sess-real-1");
    const run = await piRuntime.getRun(runId);
    expect(run.session_id).toBe("sess-real-1");
  });

  // === MODEL ===

  it("7. startRun с Sonnet реально запускает Sonnet", async () => {
    seedTask("task-model-7");
    const { runId } = await piRuntime.startRun({
      taskId: "task-model-7",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
    });
    expect(lastClient().options.model).toBe("claude-sonnet-5");
    expect(lastClient().options.provider).toBe("anthropic");
    // cliPath — JS-энтрипоинт SDK, не shell-обёртка (RpcClient спавнит node).
    expect(String(lastClient().options.cliPath)).toMatch(/dist[/\\]cli\.js$/);
    expect(attemptRow(runId)?.model).toBe("claude-sonnet-5");
    expect(attemptRow(runId)?.provider).toBe("anthropic");
  });

  it("8. startRun с GPT model реально запускает эту GPT model", async () => {
    seedTask("task-model-8");
    const { runId } = await piRuntime.startRun({
      taskId: "task-model-8",
      agentId: "architect",
      provider: "openai-codex",
      model: "gpt-5",
      prompt: "hi",
    });
    expect(lastClient().options.model).toBe("gpt-5");
    expect(lastClient().options.provider).toBe("openai-codex");
    expect(attemptRow(runId)?.model).toBe("gpt-5");
  });

  it("9. Pi unavailable → RuntimeUnavailableError", async () => {
    mockState.createShouldFail = true;
    await expect(piRuntime.listModels()).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );
  });

  it("10. неизвестная model → ModelNotAvailableError", async () => {
    seedTask("task-model-10");
    await expect(
      piRuntime.startRun({
        taskId: "task-model-10",
        agentId: "architect",
        provider: "anthropic",
        model: "no-such-model",
        prompt: "hi",
      }),
    ).rejects.toBeInstanceOf(ModelNotAvailableError);
  });

  // === FALLBACK HISTORY ===

  it("11+12. fallback создаёт новый attempt, старый сохраняет модель", async () => {
    seedTask("task-fallback-history");
    const first = await piRuntime.startRun({
      taskId: "task-fallback-history",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "attempt one",
    });
    lastClient().emit({ type: "agent_settled" });
    await tick();

    const second = await piRuntime.startRun({
      taskId: "task-fallback-history",
      agentId: "architect",
      provider: "openai-codex",
      model: "gpt-5",
      prompt: "attempt two",
    });
    lastClient().emit({ type: "agent_settled" });
    await tick();

    const run = await piRuntime.getRun(second.runId);
    const attempts = run.attempts ?? [];
    expect(attempts.length).toBe(2);
    const a1 = attempts.find((a) => a.id === first.runId);
    const a2 = attempts.find((a) => a.id === second.runId);
    // Attempt #1 навсегда остаётся с первоначальной моделью.
    expect(a1?.model).toBe("claude-sonnet-5");
    expect(a1?.provider).toBe("anthropic");
    expect(a1?.status).toBe("completed");
    // Attempt #2 — с fallback-моделью.
    expect(a2?.model).toBe("gpt-5");
    expect(a2?.provider).toBe("openai-codex");
  });

  // === PROVIDERS ===

  it("14. Disconnected provider присутствует в списке", async () => {
    const providers = await piRuntime.listProviders();
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("minimax");
    expect(providers.every((p) => p.status === "disconnected")).toBe(true);
    expect(providers.find((p) => p.id === "anthropic")?.authMethods).toContain("oauth");
    expect(providers.find((p) => p.id === "minimax")?.authMethods).toContain("api_key");
  });

  it("runId уникален (run_<uuid>)", async () => {
    seedTask("task-uuid");
    const result = await piRuntime.startRun({
      taskId: "task-uuid",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-sonnet-5",
      prompt: "hi",
    });
    expect(result.runId).toMatch(
      /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("sendMessage и cancelRun(неизвестный) кидают UnsupportedInFacadeError", async () => {
    await expect(piRuntime.sendMessage("run-x", "hi")).rejects.toBeInstanceOf(
      UnsupportedInFacadeError,
    );
    await expect(piRuntime.cancelRun("run-x")).rejects.toBeInstanceOf(
      UnsupportedInFacadeError,
    );
  });
});
