// Архивные учётки (владелец 01.10.2026): «Оркестратор Claude» из архива
// всё ещё мог войти паролем. Вход и JWT архивной учётки — отказ; api_token
// служб трекера (taskflow-trigger ходит учёткой Pi Agent из архива) — живёт.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import db, { hashApiToken } from "../src/db.js";
import { buildApp } from "../src/index.js";

describe("архивные учётки", () => {
  let app: FastifyInstance;
  let userId: string;
  let jwt: string;
  const email = `archived-${Date.now()}@test`;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Архивный", email, password: "password123" } });
    userId = reg.json().user.id;
    jwt = reg.json().token;
    db.prepare("UPDATE users SET archived = 1, api_token = ? WHERE id = ?").run(hashApiToken("service-key-archived"), userId);
  });

  afterAll(async () => {
    await app.close();
  });

  it("вход паролем — отказ", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "password123" } });
    expect(res.statusCode).toBe(401);
  });

  it("выданный раньше JWT больше не действует", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${jwt}` } });
    expect(res.statusCode).toBe(401);
  });

  it("api_token службы работает", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: "Bearer service-key-archived" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(userId);
  });
});
