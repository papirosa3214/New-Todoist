// Номер запроса и лог ответов с ошибкой (27.09.2026): по номеру из лога
// телефона сразу находится строка сервера с телом ответа.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, errorBodyPreview, requestIdFor } from "../src/index.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

describe("номер запроса", () => {
  it("присланный клиентом X-Request-ID возвращается в ответе", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/no-such-route",
      headers: { "x-request-id": "ios-1a2b3c" },
    });
    expect(res.headers["x-request-id"]).toBe("ios-1a2b3c");
  });

  it("без заголовка или с мусором — свой номер srv-…", async () => {
    const plain = await app.inject({ method: "GET", url: "/api/no-such-route" });
    expect(String(plain.headers["x-request-id"])).toMatch(/^srv-\d+-[a-z0-9]+$/);
    expect(requestIdFor({ headers: { "x-request-id": "bad id\nwith newline" } })).toMatch(/^srv-/);
    expect(requestIdFor({ headers: { "x-request-id": "x".repeat(65) } })).toMatch(/^srv-/);
  });
});

describe("тело ответа с ошибкой для лога", () => {
  it("строка, буфер, объект; ключи затёрты; не длиннее 2 КБ", () => {
    expect(errorBodyPreview('{"error":"Чат не найден"}')).toBe('{"error":"Чат не найден"}');
    expect(errorBodyPreview(Buffer.from("oops"))).toBe("oops");
    expect(errorBodyPreview({ error: "x" })).toBe('{"error":"x"}');
    expect(errorBodyPreview('{"token":"eyJabc.def","error":"x"}')).toBe('{"token":"•••","error":"x"}');
    expect(errorBodyPreview("Authorization: Bearer abc.def")).toBe("Authorization: Bearer •••");
    expect(errorBodyPreview("a".repeat(5000))!.length).toBe(2048);
    expect(errorBodyPreview(undefined)).toBeUndefined();
  });
});
