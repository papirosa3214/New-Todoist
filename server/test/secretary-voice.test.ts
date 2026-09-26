import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner } from "./helpers/seedOwner.js";

describe("POST /api/secretary/voice-token — только владелец", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentToken: string;

  beforeAll(async () => {
    process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret-at-least-32-bytes-long!!";

    app = await buildApp();
    // Миграция 039_seed_owner сидит 'u1' как владельца на каждой свежей БД;
    // без понижения ownerIdOrNull() в роуте видит u1, а не тестового
    // владельца, и отдаёт 403 вместо 200 (см. test/helpers/seedOwner.ts).
    demoteSeededOwner(db);

    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "OwnerVoice", email: "owner@voice.test", password: "password123" },
    });
    ownerToken = ownerReg.json().token;
    ownerId = ownerReg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "AgentVoice", email: "agent@voice.test", password: "password123" },
    });
    agentToken = agentReg.json().token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("владельцу — 200 с url/token/room", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/secretary/voice-token",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toBe("wss://test.livekit.cloud");
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.room.startsWith(`secretary-voice-${ownerId}-`)).toBe(true);
  });

  it("каждый звонок — новая комната (иначе второй звонок подряд остаётся без Секретаря)", async () => {
    const call = () => app.inject({
      method: "POST",
      url: "/api/secretary/voice-token",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const [a, b] = [await call(), await call()];
    expect(a.json().room).not.toBe(b.json().room);
  });

  function tokenAttributes(token: string): Record<string, string> | undefined {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return payload.attributes;
  }

  it("голос из тела запроса попадает в атрибуты участника", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/secretary/voice-token",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { voice: "Kore" },
    });
    expect(res.statusCode).toBe(200);
    expect(tokenAttributes(res.json().token)).toEqual({ voice: "Kore" });
  });

  it("неизвестный голос не пропускается в токен", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/secretary/voice-token",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { voice: "Robot" },
    });
    expect(res.statusCode).toBe(200);
    expect(tokenAttributes(res.json().token)?.voice).toBeUndefined();
  });

  it("не-владельцу — 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/secretary/voice-token",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("без токена — 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/secretary/voice-token" });
    expect(res.statusCode).toBe(401);
  });
});
