import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";

describe("Интеграции: статус и Google Tasks", () => {
  let app: FastifyInstance;
  let userToken: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // Регистрация тестового пользователя
    const email = `test_integrations_${Date.now()}@example.com`;
    const regRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email, password: "password123", name: "Integrations Tester" },
    });
    userToken = regRes.json().token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("отдаёт статус интеграций для авторизованного пользователя", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/status",
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.google).toBeDefined();
    expect(data.google.connected).toBe(false);
  });

  it("требует авторизацию для работы с интеграциями", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/status",
    });
    expect(res.statusCode).toBe(401);
  });

  it("без подключённого Google отдаёт пустой список, а не 401", async () => {
    // /api/integrations/google/lists в routes/integrations.ts держит
    // «Google не подключён» отдельно от сессии: APIClient на любой 401
    // чистит токен и разлогинивает, а здесь состояние «не подключён» — это
    // про интеграцию, а не про сессию. Сервер возвращает 200 + { lists: [] },
    // клиент рисует пустой список и кнопку «Подключить Google». Раньше
    // тест ждал 401 — этот контракт был до фикса «401 чистит токен».
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/google/lists",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lists: [] });
  });
});
