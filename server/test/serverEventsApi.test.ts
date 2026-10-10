// Интеграционные тесты API чтения/выгрузки серверного журнала
// (карточка e87cd93f, шаг «Разработка API чтения и выгрузки
// диагностики»). Через buildApp + app.inject: проверяем права,
// форматы экспорта и фильтры на уровне HTTP.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import {
  logServerEvent,
  recordServerOperation,
} from "../src/lib/serverEvents.js";

let app: FastifyInstance;
let ownerToken: string;
let nonOwnerToken: string;
let ownerId = "";

beforeAll(async () => {
  app = await buildApp();
  // Регистрируем владельца и случайного пользователя через тот же /api/auth/register,
  // что и остальные тесты: регистрация открыта под TASKFLOW_ALLOW_REGISTRATION=1.
  const ownerRes = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "Journal owner",
      email: `journal-owner-${process.pid}@test`,
      password: "password123",
    },
  });
  expect(ownerRes.statusCode).toBe(200);
  const ownerBody = ownerRes.json();
  ownerId = ownerBody.user.id;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  ownerToken = ownerBody.token;

  const otherRes = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "Journal non-owner",
      email: `journal-other-${process.pid}@test`,
      password: "password123",
    },
  });
  nonOwnerToken = otherRes.json().token;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  // Чистим только тестовые события (по префиксу сообщения).
  db.exec("DELETE FROM server_events WHERE message LIKE 'sapi-%'");
});

/** Создать одну запись с предсказуемыми полями — обёртка для краткости. */
function writeEvent(opts: {
  scope?: "lifecycle" | "queue" | "role_run" | "mcp" | "enricher" | "http_error" | "system";
  kind?: string;
  taskId?: string;
  operationId?: string;
  message: string;
}) {
  return logServerEvent({
    scope: opts.scope ?? "role_run",
    kind: opts.kind ?? "role_run_started",
    message: opts.message,
    taskId: opts.taskId ?? null,
    operationId: opts.operationId ?? null,
  });
}

describe("API чтения /api/admin/server-events", () => {
  it("возвращает 403 для не-владельца", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-events",
      headers: { authorization: `Bearer ${nonOwnerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("возвращает 401 без токена", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/server-events" });
    expect(res.statusCode).toBe(401);
  });

  it("для владельца отдаёт список событий с фильтром по scope", async () => {
    writeEvent({ scope: "http_error", message: "sapi-scope-http" });
    writeEvent({ scope: "queue", message: "sapi-scope-queue" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-events?scope=http_error&message=sapi-scope-",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events.length).toBe(1);
    expect(body.events[0].message).toBe("sapi-scope-http");
    expect(body.events[0].scope).toBe("http_error");
  });

  it("cursor продолжает список: limit=2 + cursor даёт следующие записи", async () => {
    for (let i = 0; i < 5; i += 1) writeEvent({ message: `sapi-page-${i}` });

    const r1 = await app.inject({
      method: "GET",
      url: "/api/admin/server-events?message=sapi-page-&limit=2",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(r1.statusCode).toBe(200);
    const body1 = r1.json();
    expect(body1.events.length).toBe(2);
    expect(body1.nextCursor).not.toBeNull();

    const r2 = await app.inject({
      method: "GET",
      url: `/api/admin/server-events?message=sapi-page-&limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const body2 = r2.json();
    expect(body2.events.length).toBe(2);
    const ids = new Set([...body1.events.map((e: any) => e.id), ...body2.events.map((e: any) => e.id)]);
    expect(ids.size).toBe(4);
  });

  it("невалидный scope отдаёт 400 с понятным сообщением", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-events?scope=garbage",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/scope/);
  });

  it("GET /:id отдаёт 404 для несуществующего id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-events/sev_does_not_exist",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /:id отдаёт событие по известному id", async () => {
    const ev = writeEvent({ message: "sapi-byid" });
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/server-events/${ev!.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe("sapi-byid");
  });

  it("GET /operation/:operationId возвращает всю цепочку", async () => {
    const op = recordServerOperation({
      scope: "role_run",
      kind: "role_run",
      message: "sapi-op-1",
    });
    logServerEvent({
      scope: "mcp",
      kind: "mcp_call_ok",
      operationId: op.operationId,
      message: "sapi-op-2",
    });
    op.ok({ message: "sapi-op-3" });

    const res = await app.inject({
      method: "GET",
      url: `/api/admin/server-events/operation/${op.operationId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const messages = body.events.map((e: any) => e.message);
    expect(messages).toContain("sapi-op-1");
    expect(messages).toContain("sapi-op-2");
    expect(messages).toContain("sapi-op-3");
  });

  it("GET /stats возвращает счётчики по scope", async () => {
    writeEvent({ scope: "queue", message: "sapi-stats-q1" });
    writeEvent({ scope: "queue", message: "sapi-stats-q2" });
    writeEvent({ scope: "system", message: "sapi-stats-s" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-events/stats?message=sapi-stats-",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    const queue = body.byScope.find((s: any) => s.scope === "queue");
    expect(queue.count).toBe(2);
  });
});

describe("API экспорта /api/admin/server-events/export", () => {
  it("json: возвращает один документ с events/settings/filters", async () => {
    writeEvent({ message: "sapi-exp-1" });
    writeEvent({ message: "sapi-exp-2" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-events/export?message=sapi-exp-&format=json",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    const body = res.json();
    expect(body.format_version).toBe(1);
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(body.settings).toBeTypeOf("object");
    expect(body.server.node).toMatch(/^v\d+/);
  });

  it("ndjson: возвращает по одной записи на строку", async () => {
    writeEvent({ message: "sapi-ndjson-1" });
    writeEvent({ message: "sapi-ndjson-2" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-events/export?message=sapi-ndjson-&format=ndjson",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/ndjson/);
    const lines = res.body.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("gzip: возвращает gzip-архив, распаковывается в валидный JSON", async () => {
    writeEvent({ message: "sapi-gzip-1" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-events/export?message=sapi-gzip-&format=gzip",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/gzip/);
    const buf = Buffer.from(res.rawPayload as ArrayBuffer);
    const text = gunzipSync(buf).toString("utf8");
    const json = JSON.parse(text);
    expect(json.format_version).toBe(1);
    expect(json.events.length).toBeGreaterThanOrEqual(1);
  });

  it("неподдерживаемый формат отдаёт 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-events/export?format=csv",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("без токена возвращает 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/server-events/export",
    });
    expect(res.statusCode).toBe(401);
  });
});