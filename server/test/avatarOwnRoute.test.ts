// POST/DELETE /api/avatars — своя аватарка без id в пути (так ходит iOS-клиент).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Своя аватарка: /api/avatars", () => {
  let app: FastifyInstance;
  let token: string;
  let userId: string;
  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Аватар", email: "av@x.test", password: "password123" } });
    token = reg.json().token;
    userId = reg.json().user.id;
  });
  afterAll(async () => { await app.close(); });

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

  it("загружает и удаляет свою картинку", async () => {
    const up = await app.inject({ method: "POST", url: "/api/avatars", headers: { authorization: `Bearer ${token}`, "content-type": "image/png" }, payload: png });
    expect(up.statusCode).toBe(201);
    const url = up.json().avatar_url as string;
    expect(url).toMatch(/^\/api\/avatars\//);
    expect((db.prepare("SELECT avatar_url FROM users WHERE id=?").get(userId) as any).avatar_url).toBe(url);
    const del = await app.inject({ method: "DELETE", url: "/api/avatars", headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(200);
    expect((db.prepare("SELECT avatar_url FROM users WHERE id=?").get(userId) as any).avatar_url).toBeNull();
  });

  it("без входа — отказ, неверный формат — 415", async () => {
    const anon = await app.inject({ method: "POST", url: "/api/avatars", headers: { "content-type": "image/png" }, payload: png });
    expect(anon.statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/api/avatars", headers: { authorization: `Bearer ${token}`, "content-type": "image/heic" }, payload: png });
    expect(bad.statusCode).toBe(415);
  });
});
