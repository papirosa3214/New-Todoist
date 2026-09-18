import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";

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
