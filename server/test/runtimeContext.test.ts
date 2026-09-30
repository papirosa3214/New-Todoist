import { describe, expect, it, beforeEach } from "vitest";
import crypto from "node:crypto";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { buildApp } from "../src/index.js";
import type { FastifyInstance } from "fastify";

const uid = () => crypto.randomUUID();

migrate();
runMigrations();

function seedRole(key: string): string {
  const unique = `${key}-${uid().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO roles (key, title, summary, enabled, position, prompt) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(unique, unique, "", 0, null);
  return unique;
}

function seedOwner(): string {
  // /api/auth/register всегда создаёт роль "agent" — для тестов этого
  // мало, ownerOrApiToken пропустит только role=owner/service. Владельца
  // создаём прямым INSERT (тот же email, что у register, но register
  // идёт другим email — коллизий не будет).
  const id = uid();
  const email = `${id}-owner@test`;
  db.prepare(
    "INSERT INTO users (id, name, email, password_hash, role, type) VALUES (?, ?, ?, ?, 'owner', 'human')",
  ).run(id, "Owner", email, "hash");
  return id;
}

function clearOverrides(): void {
  db.prepare("DELETE FROM role_context_overrides_history").run();
  db.prepare("DELETE FROM role_context_overrides").run();
}

beforeEach(() => {
  clearOverrides();
});

interface Session {
  ownerToken: string;
  ownerId: string;
  agentToken: string;
  agentId: string;
}

async function bootstrap(): Promise<{ app: FastifyInstance; session: Session }> {
  const app = await buildApp();
  await app.ready();

  // /api/auth/register всегда делает роль "agent" — ownerOrApiToken
  // пускает только role=owner/service. Владельца создаём прямым INSERT
  // с уникальным email, JWT — через /api/auth/login по паролю.
  // Сам пароль мы не знаем (хэш), поэтому делаем собственный секретный
  // пароль и bcrypt-нутый хэш — login сработает.
  const ownerId = seedOwner();
  // Перезаписываем хэш пароля на известный, чтобы login прошёл.
  const bcrypt = (await import("bcryptjs")).default;
  const ownerHash = bcrypt.hashSync("secret", 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(ownerHash, ownerId);
  const ownerEmail = db.prepare("SELECT email FROM users WHERE id = ?").get(ownerId) as { email: string };
  const loginOwner = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: ownerEmail.email, password: "secret" },
  });
  expect(loginOwner.statusCode).toBe(200);
  const ownerToken = (loginOwner.json() as { token: string }).token;

  // Агент — обычным register, чтобы получить валидный JWT.
  const agentId = uid();
  const regAgent = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Agent", email: `${agentId}@test`, password: "secret" },
  });
  expect(regAgent.statusCode).toBe(200);
  const agentToken = (regAgent.json() as { token: string }).token;

  return {
    app,
    session: { ownerToken, ownerId, agentToken, agentId },
  };
}

describe("/api/runtime/context — REST", () => {
  it("GET /catalog требует владельца", async () => {
    const { app, session } = await bootstrap();
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/context/catalog",
      headers: {authorization: `Bearer ${session.ownerToken}`},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { layers: Array<{ key: string }> };
    expect(body.layers.length).toBeGreaterThan(5);
    expect(body.layers.find((l) => l.key === "role.prompt")).toBeDefined();
    expect(body.layers.find((l) => l.key === "rules")).toBeDefined();
    await app.close();
  });

  it("GET list для неизвестной роли возвращает 404", async () => {
    const { app, session } = await bootstrap();
    const res = await app.inject({
      method: "GET",
      url: "/api/runtime/context?role=nope&mode=work",
      headers: { authorization: `Bearer ${session.ownerToken}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET list для известной роли отдаёт layers и version", async () => {
    const { app, session } = await bootstrap();
    const role = seedRole("builder");
    const res = await app.inject({
      method: "GET",
      url: `/api/runtime/context?role=${role}&mode=work`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { layers: Array<{ layer: string }>; version: number };
    expect(body.layers.length).toBeGreaterThan(0);
    expect(body.layers.find((l) => l.layer === "rules")).toBeDefined();
    expect(body.version).toBe(0);
    await app.close();
  });

  it("PATCH без If-Match отвечает 428", async () => {
    const { app, session } = await bootstrap();
    const role = seedRole("builder");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/runtime/context/${role}/role.prompt`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
      payload: { text: "новый текст" },
    });
    expect(res.statusCode).toBe(428);
    await app.close();
  });

  it("PATCH не-владельцем отвечает 403", async () => {
    const { app, session } = await bootstrap();
    const role = seedRole("builder");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/runtime/context/${role}/role.prompt`,
      headers: { authorization: `Bearer ${session.agentToken}` },
      payload: { text: "чужой текст", if_match: 0 },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("PATCH владельцем с правильной версией → 200 и новая версия", async () => {
    const { app, session } = await bootstrap();
    const role = seedRole("builder");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/runtime/context/${role}/role.prompt`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
      payload: { text: "v1 текст", if_match: 0 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { version: number; effective: string; source: string };
    expect(body.version).toBe(1);
    expect(body.effective).toBe("v1 текст");
    expect(body.source).toBe("override");

    // Повторный PATCH с устаревшим if_match=0 → 409
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/runtime/context/${role}/role.prompt`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
      payload: { text: "v2 попытка", if_match: 0 },
    });
    expect(stale.statusCode).toBe(409);
    const staleBody = stale.json() as { current: { version: number } };
    expect(staleBody.current.version).toBe(1);
    await app.close();
  });

  it("PATCH read_only-слоя → 422", async () => {
    const { app, session } = await bootstrap();
    const role = seedRole("builder");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/runtime/context/${role}/role_skills`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
      payload: { text: "test", if_match: 0 },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("POST /reset после правки возвращает effective=оригинал и пишет history", async () => {
    const { app, session } = await bootstrap();
    const role = seedRole("builder");
    // Сначала задать override
    await app.inject({
      method: "PATCH",
      url: `/api/runtime/context/${role}/role.prompt`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
      payload: { text: "чужой текст", if_match: 0 },
    });
    // Затем reset
    const res = await app.inject({
      method: "POST",
      url: `/api/runtime/context/${role}/role.prompt/reset`,
      payload: {if_match:1},
      headers: { authorization: `Bearer ${session.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { effective: string; version: number; source: string };
    expect(body.source).toBe("original"); // reset removes override
    expect(body.effective).toBe("");      // original для роли без промпта — пустой
    expect(body.version).toBe(2);          // set v1, потом reset v2
    await app.close();
  });

  it("POST /restore с версией из истории создаёт новую активную запись с action=restore", async () => {
    const { app, session } = await bootstrap();
    const role = seedRole("builder");
    await app.inject({
      method: "PATCH",
      url: `/api/runtime/context/${role}/role.prompt`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
      payload: { text: "v1", if_match: 0 },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/runtime/context/${role}/role.prompt`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
      payload: { text: "v2", if_match: 1 },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/runtime/context/${role}/role.prompt/restore`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
      payload: { version: 1, if_match:2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { effective: string; version: number };
    expect(body.effective).toBe("v1");
    expect(body.version).toBe(3);
    await app.close();
  });

  it("POST /restore с несуществующей версией → 404", async () => {
    const { app, session } = await bootstrap();
    const role = seedRole("builder");
    const res = await app.inject({
      method: "POST",
      url: `/api/runtime/context/${role}/role.prompt/restore`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
      payload: { version: 99, if_match:0 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET :role/:layer отдаёт ComposedLayer + history", async () => {
    const { app, session } = await bootstrap();
    const role = seedRole("builder");
    const res = await app.inject({
      method: "GET",
      url: `/api/runtime/context/${role}/rules`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      layer: string;
      source: string;
      history: unknown[];
      read_only: boolean;
    };
    expect(body.layer).toBe("rules");
    expect(body.source).toBe("original");
    expect(body.read_only).toBe(false);
    expect(Array.isArray(body.history)).toBe(true);
    await app.close();
  });

  it("GET :role/:layer для read_only-слоя показывает read_only=true", async () => {
    const { app, session } = await bootstrap();
    const role = seedRole("builder");
    const res = await app.inject({
      method: "GET",
      url: `/api/runtime/context/${role}/role_skills`,
      headers: { authorization: `Bearer ${session.ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { read_only: boolean };
    expect(body.read_only).toBe(true);
    await app.close();
  });
});