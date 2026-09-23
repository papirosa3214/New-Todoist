import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { ROLE_NAMES, refreshRoles, rolePromptText, roleTitle } from "../src/roleRouting.js";

// Экран «Команда»: завести роль, поправить, отключить — без правки кода.
describe("roles: создание и правка с экрана «Команда»", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let memberToken: string;
  const key = `probe_${Date.now().toString(36)}`;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: `TeamOwner${Date.now()}`, email: `team-owner-${Date.now()}@test`, password: "password123" },
    });
    ownerToken = owner.json().token;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.json().user.id);

    const member = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: `TeamMember${Date.now()}`, email: `team-member-${Date.now()}@test`, password: "password123" },
    });
    memberToken = member.json().token;
  });

  afterAll(async () => {
    db.prepare("DELETE FROM users WHERE id = ?").run(`role_${key}`);
    db.prepare("DELETE FROM roles WHERE key = ?").run(key);
    refreshRoles();
    await app.close();
  });

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  it("не владелец роль не заводит", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/roles", headers: auth(memberToken),
      payload: { key, title: "Проба" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("плохой ключ отклоняется", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/roles", headers: auth(ownerToken),
      payload: { key: "Плохой ключ", title: "Проба" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("владелец заводит роль — сразу в списке, с учёткой и инструкцией", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/roles", headers: auth(ownerToken),
      payload: { key, title: "Проба", summary: "проверить экран.", prompt: "Ты — проба." },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ role: key, title: "Проба", summary: "проверить экран.", enabled: true });
    // профиля Pi у новой роли нет — это не поломка
    expect(res.json().problems).not.toContain("системный промпт роли не найден");
    expect(res.json().problems.join(" ")).not.toMatch(/MCP-профиль/);
    expect(res.json().tools).toContain("taskflow_claim");

    expect(ROLE_NAMES).toContain(key);
    expect(roleTitle(key)).toBe("Проба");
    expect(rolePromptText(key)).toBe("Ты — проба.");
    const user = db.prepare("SELECT type, api_token, role, role_key FROM users WHERE id = ?").get(`role_${key}`) as
      { type: string; api_token: string | null; role: string; role_key: string };
    expect(user).toEqual({ type: "ai", api_token: null, role: "agent", role_key: key });

    const roleJwt = app.jwt.sign({ id: `role_${key}` }, { expiresIn: "5m" });
    const ownerOnlyPatch = await app.inject({
      method: "PATCH",
      url: `/api/roles/${key}`,
      headers: auth(roleJwt),
      payload: { summary: "эскалация не должна пройти" },
    });
    expect(ownerOnlyPatch.statusCode).toBe(403);

    const again = await app.inject({
      method: "POST", url: "/api/roles", headers: auth(ownerToken),
      payload: { key, title: "Проба 2" },
    });
    expect(again.statusCode).toBe(409);
  });

  it.each(["owner", "agent", "viewer", "orchestrator", "service"])(
    "зарезервированный ключ %s отклоняется без создания роли и account",
    async (reservedKey) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/roles",
        headers: auth(ownerToken),
        payload: { key: reservedKey, title: "Недопустимая роль" },
      });
      expect(res.statusCode).toBe(422);
      expect(db.prepare("SELECT 1 FROM roles WHERE key = ?").get(reservedKey)).toBeUndefined();
      expect(db.prepare("SELECT 1 FROM users WHERE id = ?").get(`role_${reservedKey}`)).toBeUndefined();
    },
  );

  it("не захватывает произвольного существующего пользователя role_<key>", async () => {
    const collisionKey = `${key}_collision`;
    const collisionId = `role_${collisionKey}`;
    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, type)
       VALUES (?, 'Existing human', ?, 'hash', 'viewer', 'human')`,
    ).run(collisionId, `${collisionKey}@test`);

    const res = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: auth(ownerToken),
      payload: { key: collisionKey, title: "Collision" },
    });
    expect(res.statusCode).toBe(409);
    expect(db.prepare("SELECT 1 FROM roles WHERE key = ?").get(collisionKey)).toBeUndefined();
    expect(
      db.prepare("SELECT role, role_key, type FROM users WHERE id = ?").get(collisionId),
    ).toEqual({ role: "viewer", role_key: null, type: "human" });
    db.prepare("DELETE FROM users WHERE id = ?").run(collisionId);
  });

  it("правка названия меняет и подпись учётки", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/api/roles/${key}`, headers: auth(ownerToken),
      payload: { title: "Проба-2", summary: "иначе." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: "Проба-2", summary: "иначе." });
    expect(roleTitle(key)).toBe("Проба-2");
  });

  it("отключённая роль уходит из работы, но видна с ?all=1 и включается обратно", async () => {
    const off = await app.inject({
      method: "PATCH", url: `/api/roles/${key}`, headers: auth(ownerToken),
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(ROLE_NAMES).not.toContain(key);

    const list = await app.inject({ method: "GET", url: "/api/roles", headers: auth(ownerToken) });
    expect(list.json().roles.map((r: { role: string }) => r.role)).not.toContain(key);
    const all = await app.inject({ method: "GET", url: "/api/roles?all=1", headers: auth(ownerToken) });
    const row = all.json().roles.find((r: { role: string }) => r.role === key);
    expect(row).toMatchObject({ enabled: false });

    const on = await app.inject({
      method: "PATCH", url: `/api/roles/${key}`, headers: auth(ownerToken),
      payload: { enabled: true },
    });
    expect(on.json().enabled).toBe(true);
    expect(ROLE_NAMES).toContain(key);
  });

  it("не владелец не правит; пустая правка и чужая роль — ошибки", async () => {
    expect((await app.inject({
      method: "PATCH", url: `/api/roles/${key}`, headers: auth(memberToken), payload: { enabled: false },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "PATCH", url: `/api/roles/${key}`, headers: auth(ownerToken), payload: {},
    })).statusCode).toBe(422);
    expect((await app.inject({
      method: "PATCH", url: "/api/roles/no_such_role", headers: auth(ownerToken), payload: { enabled: true },
    })).statusCode).toBe(404);
  });
});
