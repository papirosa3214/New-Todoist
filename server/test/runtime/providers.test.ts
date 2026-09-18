import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";


// 18.09.2026 (manual_code fix): подменяем SDK, чтобы login() не дёргал
// реальный anthropic OAuth flow — иначе SDK бросает «Missing authorization
// code» после пустого manual_code ввода, vitest ловит unhandled rejection.
// Мок notify-ит auth_url, чтобы тест AuthInteractive видел event.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: vi.fn(async () => ({
      getAvailable: vi.fn(async () => []),
      // listProviders фильтрует провайдеров, для которых checkAuth
      // вернул undefined — поэтому объявляем все три KNOWN_PROVIDERS.
      checkAuth: vi.fn(async (provider: string) => {
        if (provider === "anthropic" || provider === "openai-codex")
          return { type: "oauth" };
        if (provider === "minimax") return { type: "api_key" };
        return undefined;
      }),
      getProviderAuthStatus: vi.fn(() => ({ configured: false })),
      setRuntimeApiKey: vi.fn(async () => undefined),
      // login() имитирует OAuth flow: notify auth_url и зависает
      // (completed не резолвится), чтобы тест видел событие в events.
      // Никакого реального anthropic.js — иначе он бросит unhandled
      // «Missing authorization code» при manual_code prompt.
      login: vi.fn(async (_p: string, _t: string, interaction: {
        notify: (e: unknown) => void;
        prompt: (p: unknown) => Promise<string>;
      }) => {
        interaction.notify({ type: "auth_url", url: "https://example.com/oauth" });
        await new Promise((r) => setTimeout(r, 5));
      }),
    })),
  },
}));

describe("runtime providers API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: `ProvOwner${Date.now()}`,
        email: `prov-${Date.now()}@test`,
        password: "password123",
      },
    });
    const ownerId = owner.json().user.id as string;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
    token = owner.json().token as string;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("GET /api/runtime/providers returns >=3 providers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/providers",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    // 18.09.2026 (правка AuthInteraction): роут фильтрует HTTP-ответ до
    // {provider, status, authType} — внутренние поля runtime_id и
    // managedBy владельцу не нужны (см. routes/runtime.ts:47-55).
    const body = res.json() as { providers: Array<{
      provider: string; status: string; authType: "oauth" | "api_key" | null;
    }> };
    expect(body.providers.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(body.providers.map((p) => p.provider));
    expect(ids.has("anthropic")).toBe(true);
    expect(ids.has("openai-codex")).toBe(true);
    expect(ids.has("minimax")).toBe(true);
    for (const p of body.providers) {
      expect(["connected", "disconnected", "expired"]).toContain(p.status);
    }
  });

  it("POST /api/runtime/providers/anthropic/auth returns AuthInteractive for OAuth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/anthropic/auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    // 18.09.2026 (правка AuthInteraction): для OAuth провайдера роут
    // возвращает AuthInteractive (status="auth_required" + events), а не
    // старую AuthInstruction с командой для TUI. Раньше тест ждал
    // {provider, status, note} под старый заглушечный контракт.
    const body = res.json() as {
      provider: string;
      status: string;
      events: Array<{ kind: string }>;
    };
    expect(body.provider).toBe("anthropic");
    expect(body.status).toBe("auth_required");
    expect(Array.isArray(body.events)).toBe(true);
    // Минимум одно событие (auth_url или device_code) пришло из SDK.
    expect(body.events.length).toBeGreaterThan(0);
  });

  it("POST /api/runtime/providers/unknown/auth returns 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/unknown-provider/auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("providers endpoint requires auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/providers",
    });
    expect(res.statusCode).toBe(401);
  });
});
