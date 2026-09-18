import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";
import { piRuntime } from "../../src/runtime/index.js";
import { UnsupportedInFacadeError } from "../../src/runtime/RuntimeAdapter.js";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";

// 18.09.2026 (Этап 2, правки 5+6+7): startRun теперь идёт через
// RpcClient (официальный SDK-клиент из @earendil-works/pi-coding-agent),
// connectProvider/authInstruction — через ModelRuntime.login с
// AuthInteraction. Оба не мокаются на уровне child_process.spawn (RpcClient
// ждёт реальный RPC-handshake), и не мокаются на уровне ModelRuntime
// (SDK сам читает ~/.pi/agent/auth.json). Подход:
//
// 1. vi.mock("@earendil-works/pi-coding-agent", ...) подменяет модуль
//    целиком. Реальный ModelRuntime.create() и RpcClient.new() не
//    выполняются — мы отдаём свои моки, у которых есть нужные нам
//    методы (getAvailable, checkAuth, getProviderAuthStatus, setRuntimeApiKey,
//    login, create).
//
// 2. Для каждого теста задаём поведение моков (mockResolvedValue,
//    mockRejectedValue) и проверяем, что piRuntime.startRun вернул
//    правильный shape, а connectProvider вернул правильный union-тип.
//
// 3. RpcClient мокается как EventEmitter с методами start/prompt/stop/
//    onEvent. При вызове start() сразу резолвится и эмитирует session_start
//    через onEvent-listener'ов. agent_end эмитируется вручную.

// === ModelRuntime мок ===
const mockRuntime = {
  getAvailable: vi.fn(async () => [
    { id: "claude-3-5-sonnet-latest", provider: "anthropic" },
    { id: "gpt-4.1", provider: "openai-codex" },
    { id: "minimax-text-01", provider: "minimax" },
  ]),
  checkAuth: vi.fn(async (provider: string) => {
    if (provider === "anthropic") return { type: "oauth" } as const;
    if (provider === "openai-codex") return { type: "oauth" } as const;
    if (provider === "minimax") return { type: "api_key" } as const;
    return undefined;
  }),
  getProviderAuthStatus: vi.fn((provider: string) => {
    if (provider === "minimax") return { configured: false };
    return { configured: false };
  }),
  setRuntimeApiKey: vi.fn(async (_provider: string, _key: string) => {
    // помечаем провайдер сконфигурированным
    mockRuntime.getProviderAuthStatus.mockImplementation((p: string) =>
      p === "minimax" ? { configured: true } : { configured: false },
    );
  }),
  login: vi.fn(async () => {
    // По умолчанию login успешно завершается через 10 мс — тесты,
    // которым нужно другое поведение, переопределяют.
    await new Promise((r) => setTimeout(r, 10));
  }),
};
vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: vi.fn(async () => mockRuntime),
  },
  RpcClient: vi.fn().mockImplementation(makeFakeRpcClient),
}));

// === RpcClient мок ===
function makeFakeRpcClient(_options: unknown) {
  const emitter = new EventEmitter();
  const start = vi.fn(async () => {
    // Эмитим session_start сразу после start, как это делает реальный
    // Pi в RPC-режиме.
    queueMicrotask(() => {
      emitter.emit("event", {
        type: "session_start",
        sessionId: "fake-session-uuid",
      } as unknown);
    });
  });
  const prompt = vi.fn(async () => {
    // Ничего — эмитим agent_end вручную через helper `complete`.
    return;
  });
  const stop = vi.fn(async () => {});
  const onEvent = vi.fn((listener: (ev: unknown) => void) => {
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  });
  return {
    start,
    prompt,
    stop,
    onEvent,
    /** Хелпер: ручной trigger agent_end с указанным success. */
    complete: (success: boolean) => {
      queueMicrotask(() => {
        emitter.emit("event", {
          type: "agent_end",
          success,
        } as unknown);
      });
    },
    /** Хелпер: ошибка запуска RPC (process exited). */
    failStart: (msg: string) => {
      start.mockRejectedValueOnce(new Error(msg));
    },
  };
}

/** Возвращает options, переданные в RpcClient-конструктор. */
function lastRpcOptions(): unknown {
  const calls = (piCodingAgent.RpcClient as unknown as {
    mock: { calls: Array<unknown[]> };
  }).mock.calls;
  return calls[calls.length - 1]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Переустанавливаем моки после clearAllMocks. clearAllMocks стирает
  // calls/instances/mockImplementationOnce, но mockImplementation (без
  // Once), заданный внутри vi.mock factory, остаётся — он был
  // присвоен через .mockImplementation в самой фабрике. Поэтому
  // дефолтный makeFakeRpcClient работает, пока тест не переопределит
  // через mockImplementationOnce.
  mockRuntime.getAvailable.mockResolvedValue([
    { id: "claude-3-5-sonnet-latest", provider: "anthropic" },
    { id: "gpt-4.1", provider: "openai-codex" },
    { id: "minimax-text-01", provider: "minimax" },
  ]);
  mockRuntime.checkAuth.mockImplementation(async (provider: string) => {
    if (provider === "anthropic") return { type: "oauth" } as const;
    if (provider === "openai-codex") return { type: "oauth" } as const;
    if (provider === "minimax") return { type: "api_key" } as const;
    return undefined;
  });
  mockRuntime.getProviderAuthStatus.mockImplementation(
    (provider: string) => (provider === "minimax"
      ? { configured: false }
      : { configured: false }),
  );
  mockRuntime.setRuntimeApiKey.mockImplementation(
    async (_provider: string, _key: string) => {
      mockRuntime.getProviderAuthStatus.mockImplementation((p: string) =>
        p === "minimax" ? { configured: true } : { configured: false },
      );
    },
  );
  mockRuntime.login.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  // Возвращаем дефолтную реализацию RpcClient (clearAllMocks её стирает).
  (piCodingAgent.RpcClient as unknown as {
    mockImplementation: (impl: unknown) => unknown;
  }).mockImplementation(makeFakeRpcClient);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // 18.09.2026: имя провайдера OpenAI через Codex OAuth — openai-codex,
    // не openai (Pi его не знает). См. PiRuntimeAdapter.KNOWN_PROVIDERS.
    expect(ids.has("openai-codex")).toBe(true);
    expect(ids.has("minimax")).toBe(true);
    for (const p of providers) {
      expect(p.runtime_id).toBe("runtime:pi");
      expect(p.managedBy).toBe("pi");
    }
  });

  // === startRun через RpcClient ===

  it("startRun returns UUID-format runId", async () => {
    db.prepare(
      `INSERT OR IGNORE INTO tasks (id, title, status) VALUES (?, ?, 'active')`,
    ).run("task-startrun-uuid", "test startRun");

    const result = await piRuntime.startRun({
      taskId: "task-startrun-uuid",
      agentId: "architect",
      prompt: "do uuid check",
    });
    expect(result.runId).toMatch(UUID_RE);
    expect(result.sessionId).toBe("");
    expect(result.status).toBe("queued");
  });

  it("startRun propagates provider and model into RpcClient options", async () => {
    db.prepare(
      `INSERT OR IGNORE INTO tasks (id, title, status) VALUES (?, ?, 'active')`,
    ).run("task-startrun-flags", "test startRun flags");

    await piRuntime.startRun({
      taskId: "task-startrun-flags",
      agentId: "architect",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      prompt: "check flags",
    });

    const opts = lastRpcOptions() as {
      cliPath?: string;
      provider?: string;
      model?: string;
      env?: Record<string, string>;
    };
    expect(opts.cliPath).toBe("/home/maksim/.local/bin/pi");
    expect(opts.provider).toBe("anthropic");
    expect(opts.model).toBe("claude-3-5-sonnet-latest");
    expect(opts.env?.NODE_USE_ENV_PROXY).toBe("1");
  });

  it("startRun omits provider/model when not supplied", async () => {
    db.prepare(
      `INSERT OR IGNORE INTO tasks (id, title, status) VALUES (?, ?, 'active')`,
    ).run("task-startrun-noflag", "test startRun noflag");

    await piRuntime.startRun({
      taskId: "task-startrun-noflag",
      agentId: "architect",
      prompt: "no flags here",
    });

    const opts = lastRpcOptions() as {
      provider?: string;
      model?: string;
    };
    expect(opts.provider).toBeUndefined();
    expect(opts.model).toBeUndefined();
  });

  // === connectProvider ===

  it("connectProvider for api_key returns ProviderConnection with authType=api_key", async () => {
    const result = await piRuntime.connectProvider("minimax", {
      apiKey: "sk-test-key",
    });
    // Узкий union — проверяем, что НЕ AuthInteractive.
    expect("events" in result).toBe(false);
    if ("events" in result) throw new Error("expected ProviderConnection");
    expect(result.id).toBe("minimax");
    expect(result.status).toBe("connected");
    expect(result.authType).toBe("api_key");
    expect(mockRuntime.setRuntimeApiKey).toHaveBeenCalledWith(
      "minimax",
      "sk-test-key",
    );
  });

  it("connectProvider for OAuth returns AuthInteractive with events stream", async () => {
    // Настроим login так, чтобы он сразу эмитил auth_url и завершался.
    const events: Array<{ kind?: string }> = [];
    mockRuntime.login.mockImplementation(async (provider, _type, interaction) => {
      const notify = (interaction as { notify: (ev: unknown) => void }).notify;
      notify({ type: "auth_url", url: "https://example.com/oauth" });
      notify({ type: "progress", message: "Opening browser…" });
      // Не вызываем никаких prompt — text/secret/select/manual_code не
      // поддержаны и должны реджектить login (см. реализацию).
    });

    const result = await piRuntime.connectProvider("anthropic", {});
    expect("events" in result).toBe(true);
    if (!("events" in result)) throw new Error("expected AuthInteractive");
    const ai = result;
    expect(ai.status).toBe("auth_required");
    expect(ai.provider).toBe("anthropic");

    // AsyncIterable → push в массив
    for await (const ev of ai.events) events.push(ev);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].kind).toBe("auth_url");
    expect(events[1].kind).toBe("progress");
  });

  it("sendMessage and cancelRun throw UnsupportedInFacadeError", async () => {
    await expect(piRuntime.sendMessage("run-1", "hi")).rejects.toBeInstanceOf(
      UnsupportedInFacadeError,
    );
    await expect(piRuntime.cancelRun("run-1")).rejects.toBeInstanceOf(
      UnsupportedInFacadeError,
    );
  });

  // === getRun (после миграции 044) ===

  it("getRun returns AgentRun facade for an existing task", async () => {
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
