// Вход без пароля из домашней сети: кому он положен, а кому нет.
//
// Правило появилось 19.08.2026 («в своей домашней сети не хочу постоянно
// вбивать пароли») и тогда же выяснилось, чем оно опасно: под учётку
// владельца попадал ЛЮБОЙ запрос из локальной сети, а агенты живут на этой
// же машине — их curl проходил мимо всех запретов «агент не закрывает шаги».
// Поэтому послабление действует только для клиента, который может быть
// только приложением: браузер (Sec-Fetch-*, Origin, Mozilla) или нативный
// клиент со своим заголовком X-TaskFlow-Client (добавлен 01.09.2026, когда
// приложение на iPhone дома всё равно просило пароль).
//
// Голый запрос без заголовков должен получать 404 — как будто маршрута нет.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Вход без пароля из домашней сети", () => {
  let app: FastifyInstance;
  const БЫЛО = process.env.TASKFLOW_LAN_NO_AUTH;

  beforeAll(async () => {
    process.env.TASKFLOW_LAN_NO_AUTH = "1";
    app = await buildApp();
    // Владелец в тестовой базе: регистрация роль не выдаёт (role приходит
    // от клиента и намеренно игнорируется), а без владельца маршрут отвечает
    // 404 независимо от заголовков — проверять было бы нечего.
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Хозяин", email: "owner@lan.test", password: "password123" },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE email = ?").run("owner@lan.test");
  });

  afterAll(async () => {
    if (БЫЛО === undefined) delete process.env.TASKFLOW_LAN_NO_AUTH;
    else process.env.TASKFLOW_LAN_NO_AUTH = БЫЛО;
    await app.close();
  });

  async function войти(headers: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/api/auth/lan",
      remoteAddress: "192.168.1.77",
      headers,
      payload: {},
    });
  }

  it("пускает нативное приложение по его заголовку", async () => {
    const ответ = await войти({ "x-taskflow-client": "ios-native" });
    expect(ответ.statusCode).toBe(200);
    expect(ответ.json().token).toBeTruthy();
  });

  it("пускает браузер", async () => {
    const ответ = await войти({ "user-agent": "Mozilla/5.0 (iPhone)" });
    expect(ответ.statusCode).toBe(200);
  });

  it("НЕ пускает голый скрипт без заголовков", async () => {
    const ответ = await войти({ "user-agent": "curl/8.5.0" });
    expect(ответ.statusCode).toBe(404);
  });

  it("НЕ пускает с чужим значением заголовка клиента", async () => {
    const ответ = await войти({
      "x-taskflow-client": "script",
      "user-agent": "curl/8.5.0",
    });
    expect(ответ.statusCode).toBe(404);
  });
});
