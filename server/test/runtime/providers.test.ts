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

  it("GET /api/runtime/providers returns >=3 providers, all managedBy=pi", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/providers",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: Array<{ id: string; runtime_id: string; managedBy: string }> };
    expect(body.providers.length).toBeGreaterThanOrEqual(3);
    for (const p of body.providers) {
      expect(p.runtime_id).toBe("runtime:pi");
      expect(p.managedBy).toBe("pi");
    }
  });

  it("POST /api/runtime/providers/anthropic/auth returns current status (заглушка)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/runtime/providers/anthropic/auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { provider: string; status: string; note: string };
    expect(body.provider).toBe("anthropic");
    expect(["connected", "disconnected", "expired"]).toContain(body.status);
    expect(body.note).toMatch(/connectProvider/i);
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
