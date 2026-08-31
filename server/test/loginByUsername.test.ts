// Вход по логину, а не только по почте.
//
// Просьба Максима 01.09.2026, при первом входе в нативное приложение:
// «А можно не имейл, а просто логин и пароль». Отдельного поля `login` в
// таблице не заводили — логином считается имя учётки или короткое имя из
// почты (часть до @). Пароль проверяется тем же bcrypt, маршрут тот же.
//
// Отдельно проверяется отказ при неоднозначности: если под один логин
// подходят две учётки, вход не должен пускать «в первую попавшуюся» —
// иначе пароль одного человека открывал бы чужую запись.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Вход по логину", () => {
  let app: FastifyInstance;

  const ПАРОЛЬ = "password123";

  beforeAll(async () => {
    app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Логинов",
        email: "loginov@login.test",
        password: ПАРОЛЬ,
      },
    });
  });

  afterAll(async () => {
    db.prepare(
      "DELETE FROM users WHERE email LIKE '%@login.test' OR email LIKE '%@dup.test'",
    ).run();
    await app.close();
  });

  async function войти(identifier: string, password = ПАРОЛЬ) {
    return app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: identifier, password },
    });
  }

  it("пускает по полной почте — как было", async () => {
    expect((await войти("loginov@login.test")).statusCode).toBe(200);
  });

  it("пускает по короткому имени из почты", async () => {
    const ответ = await войти("loginov");
    expect(ответ.statusCode).toBe(200);
    expect(ответ.json().user.email).toBe("loginov@login.test");
  });

  it("пускает по имени учётки, не различая регистр", async () => {
    expect((await войти("логинов")).statusCode).toBe(200);
  });

  it("не пускает с неверным паролем", async () => {
    expect((await войти("loginov", "wrong-password")).statusCode).toBe(401);
  });

  it("отказывает, когда логин подходит двум учёткам", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Двойник",
        email: "dvoinik@login.test",
        password: ПАРОЛЬ,
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Другой", email: "dvoinik@dup.test", password: ПАРОЛЬ },
    });
    expect((await войти("dvoinik")).statusCode).toBe(401);
  });
});
