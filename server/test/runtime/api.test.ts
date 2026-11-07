import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";

describe("runtime API — status, profiles, models", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: `RuntimeOwner${Date.now()}`,
        email: `runtime-api-${Date.now()}@test`,
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

  it("GET /api/runtime/status returns Runtime {id: runtime:pi}", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ runtime: { id: "runtime:pi", kind: "pi" } });
  });

  it("GET /api/runtime/profiles returns 7 profiles", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/profiles",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { profiles: Array<{ id: string; runtime_id: string }> };
    expect(body.profiles).toHaveLength(8);
    expect(body.profiles[0].runtime_id).toBe("runtime:pi");
  });

  it("GET /api/runtime/profiles/:id returns single profile", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/profiles/architect",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string };
    expect(body.id).toBe("architect");
  });

  it("GET /api/runtime/profiles/:id returns 404 for unknown role", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/profiles/no-such-role",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/runtime/models returns array of models", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/models",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { models: Array<{ runtime_id: string }> };
    expect(Array.isArray(body.models)).toBe(true);
    for (const m of body.models) expect(m.runtime_id).toBe("runtime:pi");
  });

  it("GET /api/runtime/* requires auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/status",
    });
    expect(res.statusCode).toBe(401);
  });
});
