// Регрессии безопасности, найденные аудитом 24.10.2026.
//
// Каждая проверка — реальный запрос к настоящему приложению (app.inject),
// а не «функция вернула число». Проверяется то, что видит атакующий.
//
// Закрытые векторы:
//  1. Роль выпускала машинный ключ с allowed_roots:["/"] через
//     /api/pairing/exchange — то есть удалённое выполнение команд на
//     маке-хосте (bash/write/edit/git_push по всему диску).
//  2. Код привязки выдавался любому авторизованному, не только владельцу.
//  3. Вложение с text/html отдавалось inline — постоянный XSS в origin
//     приложения (фронт ходит через Vite-прокси, ответ same-origin).
//  4. SVG-аватар отдавался публично, без auth, как image/svg+xml — XSS без
//     единого заголовка авторизации.
//  5. Отчёт markdown → HTML без санитайзера: <script> попадал в документ
//     и исполнялся при просмотре отчёта и при сборке PDF на сервере.
//  6. URL подписки webhook проверялся только на схему — SSRF во внутреннюю
//     сеть с oracle по http_status.
//  7. /api/auth/lan выдавал JWT владельца без rate-limit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Безопасность: правки по итогам аудита 24.10.2026", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let roleToken: string;
  let taskId: string;

  beforeAll(async () => {
    app = await buildApp();
    // Владелец. Регистрация может быть закрыта (уже есть пользователи) —
    // тогда берём существующего владельца и подписываем его JWT.
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Владелец", email: "sec-owner@test", password: "password123" },
    });
    if (owner.statusCode === 200 && owner.json().token) {
      ownerToken = owner.json().token;
      db.prepare("UPDATE users SET role='owner' WHERE email='sec-owner@test'").run();
    } else {
      const владелец = db
        .prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1")
        .get() as { id: string } | undefined;
      if (!владелец) throw new Error("в тестовой БД нет владельца");
      ownerToken = app.jwt.sign({ id: владелец.id });
      // Проверяем, что токен действительно пускает: если нет — падаем с
      // понятным текстом, а не «400 unexplained» в следующем тесте.
      const проверка = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      if (проверка.statusCode !== 200) {
        throw new Error(
          `владелец ${владелец.id} не пускает с JWT: ${проверка.statusCode} ${проверка.body}`,
        );
      }
    }

    // Роль: type='ai', свой api_token
    db.prepare(
      `INSERT OR IGNORE INTO users (id,name,email,password_hash,role,type,is_system_bot)
       VALUES ('sec-role','Роль','sec-role@test','!no-login','agent','ai',1)`,
    ).run();
    roleToken = app.jwt.sign({ id: "sec-role" });

    // Задача для вложений
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Задача для проверки вложений" },
    });
    const тело = task.json();
    // Ответ POST /api/tasks — {task:{id,…}}.
    taskId = (тело.task?.id ?? тело.id) as string;
    expect(taskId, `задача не создана: ${task.body}`).toBeTruthy();
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── 1 и 2: pairing ────────────────────────────────────────────────────

  it("роль НЕ получает код привязки", async () => {
    const ответ = await app.inject({
      method: "POST",
      url: "/api/pairing/code",
      headers: { authorization: `Bearer ${roleToken}` },
      payload: {},
    });
    expect(ответ.statusCode).toBe(403);
  });

  it("роль НЕ обменивает код на машинный ключ с корнем /", async () => {
    // Даже если у роли есть код (например, выданный до правки), обмен
    // machine-машины не должен выдавать ключ с корнями из тела запроса.
    const код = await app.inject({
      method: "POST",
      url: "/api/pairing/code",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {},
    });
    const значение = код.json().code as string;
    expect(значение, `код не выдан: ${код.body}`).toBeTruthy();

    const обмен = await app.inject({
      method: "POST",
      url: "/api/pairing/exchange",
      payload: {
        code: значение,
        target: "machine",
        name: "несуществующая-машина-аудита",
        allowed_roots: ["/"],
      },
    });
    // Машина не заведена владельцем — обмен отказывает.
    expect(обмен.statusCode).toBe(400);
    expect(обмен.json().error).toBe("invalid_code");
  });

  it("корни машинного ключа берутся из реестра, а не из тела запроса", async () => {
    // Владелец заводит машину с конкретным корнем.
    const завёл = await app.inject({
      method: "POST",
      url: "/api/machines",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "аудит-машина", allowedRoots: ["/Users/only/this"] },
    });
    expect(завёл.statusCode, `машина не заведена: ${завёл.body}`).toBe(200);

    const код = await app.inject({
      method: "POST",
      url: "/api/pairing/code",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {},
    });
    expect(код.statusCode, `код не выдан: ${код.body}`).toBe(200);
    const обмен = await app.inject({
      method: "POST",
      url: "/api/pairing/exchange",
      payload: {
        code: код.json().code,
        target: "machine",
        name: "аудит-машина",
        allowed_roots: ["/"],
      },
    });
    expect(обмен.statusCode, `обмен отклонён: ${обмен.body}`).toBe(200);
    // Ключ выдан, но с корнями ИЗ РЕЕСТРА — просьба из тела проигнорирована.
    expect(обмен.json().allowed_roots).toEqual(["/Users/only/this"]);
    expect(обмен.json().allowed_roots).not.toContain("/");

    // Убираем за собой: машина отзывается.
    const машина = db
      .prepare("SELECT id FROM machines WHERE name='аудит-машина'")
      .get() as { id: string };
    db.prepare(
      "UPDATE machines SET revoked_at=datetime('now'), revoke_reason='audit' WHERE id=?",
    ).run(машина.id);
  });

  // ─── 3: XSS в вложениях ───────────────────────────────────────────────

  it("вложение отдаётся как attachment + nosniff (не исполняемый HTML)", async () => {
    const загрузка = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/attachments?name=audit.html`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "text/html",
      },
      payload: "<html><body><script>alert(1)</script>SECRET</body></html>",
    });
    expect(
      загрузка.statusCode,
      `загрузка отклонена (taskId=${taskId}): ${загрузка.body}`,
    ).toBe(201);
    // Ответ загрузки — {attachment:{id,…}}.
    const id = загрузка.json().attachment.id as string;
    expect(id, `вложение не создано: ${загрузка.body}`).toBeTruthy();

    const раздача = await app.inject({
      method: "GET",
      url: `/api/attachments/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(раздача.statusCode).toBe(200);
    const disposition = String(раздача.headers["content-disposition"] || "");
    expect(disposition).toContain("attachment");
    expect(disposition).not.toContain("inline");
    expect(раздача.headers["x-content-type-options"]).toBe("nosniff");

    db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  });

  // ─── 4: SVG-аватар ────────────────────────────────────────────────────

  it("SVG больше не принимается к загрузке аватара", async () => {
    const ответ = await app.inject({
      method: "POST",
      url: "/api/avatars",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "image/svg+xml",
      },
      payload: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    expect(ответ.statusCode).not.toBe(201);
  });

  it("публичная раздача аватара несёт защитные заголовки", async () => {
    // Кладём файл напрямую — минуя загрузку (SVG уже не принимается).
    const fs = await import("fs");
    const path = await import("path");
    const { AVATAR_DIR } = await import("../src/routes/avatars.js");
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    const имя = "аудит-проверка.svg";
    fs.writeFileSync(
      path.join(AVATAR_DIR, имя),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );

    const ответ = await app.inject({ method: "GET", url: `/api/avatars/${имя}` });
    expect(ответ.statusCode).toBe(200);
    expect(ответ.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(ответ.headers["content-security-policy"] || "")).toContain("sandbox");

    fs.rmSync(path.join(AVATAR_DIR, имя), { force: true });
  });

  // ─── 5: XSS в отчётах ──────────────────────────────────────────────────

  it("markdown в отчёте очищается от <script>", async () => {
    const { markdownToHtmlForTest } = await import("../src/lib/report.js");
    const html = await markdownToHtmlForTest(
      "# Заголовок\n\nОбычный текст.\n\n<script>alert('xss')</script>\n\n<img src=x onerror=alert(1)>",
    );
    expect(html).toContain("Заголовок");
    expect(html).toContain("Обычный текст");
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain("onerror");
  });

  // ─── 6: SSRF в вебхуках ───────────────────────────────────────────────

  it("подписка на внутренний адрес не заводится", async () => {
    // В тестах 127.0.0.1 и localhost разрешены явно (test/setup.ts) — фейковый
    // приёмник стоит локально. Поэтому проверяем адреса, которых в списке
    // исключений нет: link-local (метаданные облака) и частные сети.
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://[::1]:3001/",
    ]) {
      const ответ = await app.inject({
        method: "POST",
        url: "/api/integrations/webhooks",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          name: "аудит-подписка",
          url,
          secret: "0123456789abcdef0123",
          event_kinds: ["plan_subtask_started"],
        },
      });
      expect(ответ.statusCode, `${url} не отклонён`).toBeGreaterThanOrEqual(400);
    }
  });

  it("публичный адрес подписки принимается", async () => {
    const ответ = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: "аудит-подписка",
        url: "https://example.com/hook",
        secret: "0123456789abcdef0123",
        event_kinds: ["plan_subtask_started"],
      },
    });
    expect(ответ.statusCode, `подписка отклонена: ${ответ.body}`).toBe(200);
    const id = ответ.json().webhook.id as string;
    db.prepare("DELETE FROM webhook_subscriptions WHERE id = ?").run(id);
  });

  // ─── 7: rate-limit на /api/auth/lan ────────────────────────────────────

  it("/api/auth/lan ограничен по частоте", async () => {
    let коды: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const ответ = await app.inject({
        method: "POST",
        url: "/api/auth/lan",
        remoteAddress: "192.168.1.99",
        headers: {
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
        },
        payload: {},
      });
      коды.push(ответ.statusCode);
    }
    expect(коды.some((к) => к === 429), "лимит не сработал").toBe(true);
  });
});
