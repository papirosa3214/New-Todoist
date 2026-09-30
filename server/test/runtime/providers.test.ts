import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { buildApp } from "../../src/index.js";
import db, { hashApiToken } from "../../src/db.js";
import { resetModelRuntime } from "../../src/runtime/PiRuntimeAdapter.js";

// 18.09.2026 (доработка после ревью владельца): авторизация идёт через
// AuthSession (§3-6), а не одним синхронным запросом. Проверяем:
//  - disconnected провайдер остаётся в GET /providers (§9);
//  - POST /auth отвечает сразу authSessionId, не дожидаясь OAuth (§3);
//  - auth_url доходит до клиента до завершения login;
//  - manual_code из POST /input реально возвращается в prompt() (§6);
//  - DELETE останавливает login (§17);
//  - api_key пишется persistent-механизмом login(), не setRuntimeApiKey (§8);
//  - GET /providers не отдаёт credentials (§17).

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", auth: { oauth: {}, apiKey: {} } },
  { id: "openai-codex", name: "OpenAI (Codex)", auth: { oauth: {} } },
  { id: "minimax", name: "MiniMax", auth: { apiKey: {} } },
];

const CATALOG = [
  { id: "claude-sonnet-5", provider: "anthropic", name: "Sonnet 5" },
  { id: "gpt-5", provider: "openai-codex", name: "GPT-5" },
  { id: "minimax-m3", provider: "minimax", name: "MiniMax M3" },
];

const mockState = vi.hoisted(() => ({
  connected: new Set<string>(),
  lastManualCode: null as string | null,
  lastSelect: null as string | null,
  abortPrompt: null as null | (() => void),
  createShouldFail: false,
  loginBehavior: null as
    | null
    | ((args: { provider: string; type: string; interaction: any }) => Promise<any>),
}));

const mockRuntime = {
  getProviders: vi.fn(() => PROVIDERS),
  getProvider: vi.fn((id: string) => PROVIDERS.find((p) => p.id === id)),
  getProviderAuthStatus: vi.fn((id: string) => ({
    configured: mockState.connected.has(id),
  })),
  checkAuth: vi.fn(async (id: string) =>
    mockState.connected.has(id)
      ? { type: id === "minimax" ? "api_key" : "oauth" }
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
    await new Promise<never>((_r, reject) => {
      interaction.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    mockState.connected.add(provider);
    return { type: "oauth" };
  }),
  setRuntimeApiKey: vi.fn(async () => {}),
  getModels: vi.fn(() => CATALOG),
  getAvailable: vi.fn(async () => []),
  refresh: vi.fn(async () => ({})),
  getError: vi.fn(() => undefined),
};

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => { const actual=await importOriginal<any>(); return { ...actual,
  getPackageDir: () => "/mock/pi-pkg",
  ModelRuntime: {
    create: vi.fn(async () => {
      if (mockState.createShouldFail) throw new Error("pi offline");
      return mockRuntime;
    }),
  },
  RpcClient: vi.fn(),
}; });

async function tick(ms = 25): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("runtime providers API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken: string;
  let userToken: string;
  let userId: string;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: `ProvOwner${Date.now()}`,
        email: `prov-owner-${Date.now()}@test`,
        password: "password123",
      },
    });
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner.json().user.id);
    ownerToken = owner.json().token as string;

    const user = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: `ProvUser${Date.now()}`,
        email: `prov-user-${Date.now()}@test`,
        password: "password123",
      },
    });
    userToken = user.json().token as string;
    userId = user.json().user.id as string;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    mockState.loginBehavior = null;
    mockState.lastManualCode = null;
    mockState.lastSelect = null;
    mockState.abortPrompt = null;
    mockState.createShouldFail = false;
    resetModelRuntime();
    mockRuntime.login.mockClear();
    mockRuntime.setRuntimeApiKey.mockClear();
  });

  it("GET /providers returns all providers incl. disconnected, without credentials", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/providers",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      providers: Array<{
        provider: string;
        name: string;
        status: string;
        authType: string | null;
        authMethods: string[];
      }>;
    };
    const ids = body.providers.map((p) => p.provider);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai-codex");
    expect(ids).toContain("minimax");
    // Неподключённые остаются в списке (спека §9).
    expect(body.providers.every((p) => p.status === "disconnected")).toBe(true);
    // Никаких credential details (спека §17).
    const raw = res.body.toLowerCase();
    expect(raw).not.toContain("apikey");
    expect(raw).not.toContain("access_token");
    expect(raw).not.toContain("refresh");
    expect(raw).not.toContain("secret");
  });

  it("POST /auth (OAuth) отвечает сразу authSessionId, не дожидаясь login", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/anthropic/auth",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { authSessionId: string; provider: string; status: string };
    expect(body.provider).toBe("anthropic");
    expect(body.authSessionId).toMatch(/^auth_/);
    // login() запущен в фоне; к моменту ответа он уже мог отдать auth_url,
    // поэтому статус — starting или waiting_user (но не терминальный).
    expect(["starting", "waiting_user"]).toContain(body.status);

    // auth_url уже в сессии — клиент получит его, не дожидаясь OAuth.
    await tick();
    const session = await app.inject({
      method: "GET",
      url: `/api/runtime/auth/${body.authSessionId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(session.statusCode).toBe(200);
    const view = session.json() as {
      status: string;
      events: Array<{ type: string; data: { url?: string } }>;
    };
    const authUrl = view.events.find((e) => e.type === "auth_url");
    expect(authUrl?.data.url).toBe("https://example.com/oauth");
    expect(view.status).toBe("waiting_user");
  });

  it("manual_code из POST /input реально возвращается в prompt()", async () => {
    mockState.loginBehavior = async ({ provider, interaction }) => {
      const code = await interaction.prompt({
        type: "manual_code",
        message: "Enter code from browser",
      });
      mockState.lastManualCode = code;
      mockState.connected.add(provider);
      return { type: "oauth" };
    };

    const start = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/anthropic/auth",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const { authSessionId } = start.json() as { authSessionId: string };
    await tick();

    const waiting = await app.inject({
      method: "GET",
      url: `/api/runtime/auth/${authSessionId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const view = waiting.json() as { currentPrompt: { type: string } | null };
    expect(view.currentPrompt?.type).toBe("manual_code");

    const input = await app.inject({
      method: "POST",
      url: `/api/runtime/auth/${authSessionId}/input`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { type: "manual_code", value: "ABC-123" },
    });
    expect(input.statusCode).toBe(202);
    await tick();

    expect(mockState.lastManualCode).toBe("ABC-123");
    const done = await app.inject({
      method: "GET",
      url: `/api/runtime/auth/${authSessionId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect((done.json() as { status: string }).status).toBe("connected");
  });

  it("DELETE /auth/:id останавливает login", async () => {
    mockState.loginBehavior = async ({ interaction }) => {
      await new Promise<never>((_r, reject) => {
        interaction.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return { type: "oauth" };
    };
    const start = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/anthropic/auth",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const { authSessionId } = start.json() as { authSessionId: string };
    await tick();
    const del = await app.inject({
      method: "DELETE",
      url: `/api/runtime/auth/${authSessionId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(del.statusCode).toBe(204);
    await tick();
    const after = await app.inject({
      method: "GET",
      url: `/api/runtime/auth/${authSessionId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect((after.json() as { status: string }).status).toBe("cancelled");
  });

  it("api_key пишется через persistent login(), не setRuntimeApiKey", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/minimax/auth",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { apiKey: "sk-test-key" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { provider: string; status: string; authType: string };
    expect(body.status).toBe("connected");
    expect(body.authType).toBe("api_key");
    expect(mockRuntime.login).toHaveBeenCalledWith(
      "minimax",
      "api_key",
      expect.anything(),
    );
    expect(mockRuntime.setRuntimeApiKey).not.toHaveBeenCalled();
    // После подключения провайдер виден как connected.
    const list = await app.inject({
      method: "GET",
      url: "/api/runtime/providers",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const minimax = (list.json() as {
      providers: Array<{ provider: string; status: string }>;
    }).providers.find((p) => p.provider === "minimax");
    expect(minimax?.status).toBe("connected");
  });

  it("обычный пользователь не может менять auth (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/anthropic/auth",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("обычный api_token без runtime:auth не может менять auth (403)", async () => {
    const raw = `agent-token-${Date.now()}`;
    db.prepare("UPDATE users SET api_token = ? WHERE id = ?").run(
      hashApiToken(raw),
      userId,
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/anthropic/auth",
      headers: { authorization: `Bearer ${raw}` },
    });
    // Токен валиден (пользователь существует), но роль не owner/service →
    // ownerOrApiToken отказывает. Именно этого требует спека §17.
    expect(res.statusCode).toBe(403);
  });

  it("POST /auth без токена → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/anthropic/auth",
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /auth unknown provider → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/nope/auth",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("Pi offline → GET /models 503 runtime_unavailable", async () => {
    mockState.createShouldFail = true;
    resetModelRuntime();
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/models",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe("runtime_unavailable");
  });

  it("неизвестная модель в routing → 422 model_not_available", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/runtime/routing/architect",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { primary: "no-such-model", fallbacks: [] },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toContain("model_not_available");
  });

  it("Pi offline на routing → 503 runtime_unavailable", async () => {
    mockState.createShouldFail = true;
    resetModelRuntime();
    const res = await app.inject({
      method: "PUT",
      url: "/api/runtime/routing/architect",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { primary: "minimax-m3", fallbacks: [] },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe("runtime_unavailable");
  });

  it("13. порядок fallbacks сохраняется как задан (без sort)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/runtime/routing/architect",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        primary: "minimax-m3",
        fallbacks: ["gpt-5", "claude-sonnet-5"],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { fallbacks: string[] };
    expect(body.fallbacks).toEqual(["gpt-5", "claude-sonnet-5"]);

    const read = await app.inject({
      method: "GET",
      url: "/api/runtime/routing",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const routing = read.json() as { routing: { fallbacks: Record<string, string[]> } };
    expect(routing.routing.fallbacks.architect).toEqual([
      "gpt-5",
      "claude-sonnet-5",
    ]);
  });

  it("2. AuthPrompt.signal: abort чистит currentPrompt, после успеха — null", async () => {
    mockState.loginBehavior = async ({ provider, interaction }) => {
      const ac = new AbortController();
      mockState.abortPrompt = () => ac.abort();
      const pending = interaction.prompt({
        type: "manual_code",
        message: "code",
        signal: ac.signal,
      });
      try {
        await pending;
      } catch {
        // ожидаемо: prompt отклонён по abort сигнала конкретного промпта
      }
      mockState.connected.add(provider);
      return { type: "oauth" };
    };

    const start = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/anthropic/auth",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const { authSessionId } = start.json() as { authSessionId: string };

    await tick();
    const waiting = await app.inject({
      method: "GET",
      url: `/api/runtime/auth/${authSessionId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(
      (waiting.json() as { currentPrompt: { type: string } | null }).currentPrompt?.type,
    ).toBe("manual_code");

    // Callback-сервер победил: Pi гасит manual_code через signal промпта.
    mockState.abortPrompt?.();
    await tick();
    const done = await app.inject({
      method: "GET",
      url: `/api/runtime/auth/${authSessionId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const view = done.json() as {
      status: string;
      currentPrompt: unknown;
    };
    expect(view.status).toBe("connected");
    // После успешного OAuth currentPrompt обязан стать null.
    expect(view.currentPrompt).toBeNull();
  });

  it("4. select: options уходят в currentPrompt, option.id — в login", async () => {
    mockState.lastSelect = null;
    mockState.loginBehavior = async ({ provider, interaction }) => {
      const chosen = await interaction.prompt({
        type: "select",
        message: "Choose auth method",
        options: [
          { id: "opt-a", label: "Option A" },
          { id: "opt-b", label: "Option B" },
        ],
      });
      mockState.lastSelect = chosen;
      mockState.connected.add(provider);
      return { type: "oauth" };
    };

    const start = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/anthropic/auth",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const { authSessionId } = start.json() as { authSessionId: string };
    await tick();

    const waiting = await app.inject({
      method: "GET",
      url: `/api/runtime/auth/${authSessionId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const view = waiting.json() as {
      currentPrompt: {
        type: string;
        options: Array<{ id: string; label: string }>;
      } | null;
    };
    expect(view.currentPrompt?.type).toBe("select");
    expect(view.currentPrompt?.options.map((o) => o.id)).toEqual(["opt-a", "opt-b"]);

    const input = await app.inject({
      method: "POST",
      url: `/api/runtime/auth/${authSessionId}/input`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { type: "select", value: "opt-b" },
    });
    expect(input.statusCode).toBe(202);
    await tick();
    expect(mockState.lastSelect).toBe("opt-b");
  });

  it("18. api_key переживает пересоздание ModelRuntime", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/minimax/auth",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { apiKey: "sk-persist" },
    });
    expect(res.statusCode).toBe(200);

    // Симулируем рестарт TaskFlow: singleton ModelRuntime создаётся заново,
    // а credential (его пишет SDK login) остаётся в хранилище.
    resetModelRuntime();
    const list = await app.inject({
      method: "GET",
      url: "/api/runtime/providers",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const minimax = (list.json() as {
      providers: Array<{ provider: string; status: string }>;
    }).providers.find((p) => p.provider === "minimax");
    expect(minimax?.status).toBe("connected");
  });
});
