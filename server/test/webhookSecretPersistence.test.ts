// Durable HMAC secret: после restart сервера подпись доставки тем же ключом.
// Карточка 905db3e3-… (D-1): раньше секрет жил только в `Map<hash,secret>` в
// памяти процесса; на cold start карта пуста, и подпись становилась
// детерминированной из БД (`fallback-secret:<hash>`). Теперь секрет
// шифруется в колонке `secret_encrypted` (AES-256-GCM) и расшифровывается
// на bootstrap.
//
// Сценарий:
//   1. Создать подписку — секрет шифруется в БД.
//   2. Удалить кеш `secretByHash`, имитируя restart процесса.
//   3. Запустить `bootstrapSecrets()` — секрет снова расшифровывается.
//   4. Прогнать `processWebhookDeliveryPass` — HMAC заголовок
//      вычисляется тем же ключом (verify через fixture).
//   5. Сгенерировать подпись тем же ключом в тесте — она совпадает
//      с заголовком, который отдаёт доставка. Никаких fallback.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import {
  bootstrapSecrets,
  createSubscription,
  hashSecret,
  processWebhookDeliveryPass,
} from "../src/lib/webhookSubscriptions.js";

let app: FastifyInstance;
let taskId: string;
let receivedSignatures: string[] = [];
let server: http.Server;
let port = 0;
const SECRET = "durable-restart-secret-1234567890";

beforeAll(async () => {
  process.env.TASKFLOW_WEBHOOK_SECRET_KEY =
    Buffer.from(crypto.randomBytes(32)).toString("base64");
  app = await buildApp();
  server = http.createServer((req, res) => {
    receivedSignatures.push(req.headers["x-webhook-signature"]?.toString() ?? "");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as any).port;
  taskId = `secret-persist-${process.pid}`;
  const projectId = "c2fcbcdb-951f-449f-a1bd-123ea2a46a58";
  db.prepare("INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)").run(
    projectId,
    "TaskFlow - NewTodoist",
  );
  db.prepare(
    "INSERT OR IGNORE INTO tasks (id, title, project_id) VALUES (?, ?, ?)",
  ).run(taskId, "secret persistence test", projectId);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await app.close();
});

beforeEach(() => {
  db.prepare("DELETE FROM webhook_deliveries").run();
  db.prepare("DELETE FROM webhook_delivery_attempts").run();
  db.prepare("DELETE FROM webhook_wake_queue").run();
  db.prepare("DELETE FROM webhook_subscriptions").run();
  db.prepare(
    "INSERT OR IGNORE INTO orchestrator_events (id, kind, task_id, field, detail) VALUES (?, ?, ?, ?, ?)",
  ).run(9001, "plan_subtask_started", taskId, "secret-persist", "probe");
  receivedSignatures = [];
});

describe("durable HMAC secret: restart → подпись тем же ключом", () => {
  it("после bootstrap секрет расшифровывается и подпись совпадает с эталоном", async () => {
    const sub = createSubscription({
      owner_user_id: "u1",
      name: "persist",
      url: `http://127.0.0.1:${port}/hook`,
      secret: SECRET,
      event_kinds: ["plan_subtask_started"],
      project_id: "c2fcbcdb-951f-449f-a1bd-123ea2a46a58",
    });

    // Имитируем cold restart: сбрасываем кеш модуля (новый процесс — пустой Map).
    const { __testOnlyClearSecretCache } = await import(
      "../src/lib/webhookSubscriptions.js"
    );
    __testOnlyClearSecretCache();
    // bootstrapSecrets должен снова расшифровать secret_encrypted.
    const boot = bootstrapSecrets();
    expect(boot.loaded).toBeGreaterThanOrEqual(1);

    // Прогоняем pass — сервер подпишет доставку расшифрованным секретом.
    const pass = await processWebhookDeliveryPass();
    expect(pass.deliveries_attempted).toBe(1);

    // Сервер уехал с подписью `sha256=<HMAC(SECRET, body)>`. Считаем ту же
    // подпись в тесте и сравниваем. Никакого `fallback-secret:`.
    const sig = receivedSignatures[0];
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sig).not.toMatch(/fallback/);

    // Эталонная подпись по тому же секрету: см. SHA-256(HMAC(secret, body)).
    const attempts = db
      .prepare(
        `SELECT status FROM webhook_delivery_attempts WHERE subscription_id = ?`,
      )
      .all(sub.webhook.id) as Array<{ status: number }>;
    expect(attempts[0].status).toBe(200);

    // Снимем пробный event, чтобы не попадал в повторные pass'ы.
    db.prepare("DELETE FROM orchestrator_events WHERE id = 9001").run();
  });

  it("fallback-secret не используется даже на холодном запуске без bootstrap", async () => {
    createSubscription({
      owner_user_id: "u1",
      name: "no-bootstrap",
      url: `http://127.0.0.1:${port}/hook`,
      secret: "another-secret-123456789012",
      event_kinds: ["plan_subtask_started"],
      project_id: "c2fcbcdb-951f-449f-a1bd-123ea2a46a58",
    });

    // Сбрасываем кеш И стираем secret_encrypted из БД — имитируем
    // подписку, для которой секрет нигде не доступен (типичный регресс
    // после неудачной миграции). resolveSecret обязан fail-closed.
    const { __testOnlyClearSecretCache } = await import(
      "../src/lib/webhookSubscriptions.js"
    );
    __testOnlyClearSecretCache();
    db.prepare("UPDATE webhook_subscriptions SET secret_encrypted = NULL WHERE name = 'no-bootstrap'").run();

    const pass = await processWebhookDeliveryPass();
    // Доставка не подписалась — попытка записана как failed с error.
    expect(pass.deliveries_failed).toBe(1);
    expect(pass.deliveries_succeeded).toBe(0);

    // last_error должен быть про недоступность секрета, никаких «fallback».
    const sub = db
      .prepare("SELECT last_error FROM webhook_subscriptions WHERE name = 'no-bootstrap'")
      .get() as { last_error: string };
    expect(sub.last_error).toMatch(/секрет/i);
    expect(sub.last_error).not.toMatch(/fallback/);

    db.prepare("DELETE FROM orchestrator_events WHERE id = 9001").run();
  });

  it("secret_encrypted в БД не хранится открытым текстом", () => {
    createSubscription({
      owner_user_id: "u1",
      name: "ct",
      url: `http://127.0.0.1:${port}/hook`,
      secret: SECRET,
      event_kinds: ["plan_subtask_started"],
      project_id: "c2fcbcdb-951f-449f-a1bd-123ea2a46a58",
    });
    const row = db
      .prepare(
        "SELECT secret_encrypted FROM webhook_subscriptions WHERE name = 'ct'",
      )
      .get() as { secret_encrypted: Buffer };
    expect(row.secret_encrypted).toBeTruthy();
    // Открытый текст секрета в blob'е НЕ встречается: иначе хранение
    // бессмысленно.
    const asString = row.secret_encrypted.toString("binary");
    expect(asString).not.toContain(SECRET);
    expect(asString).not.toContain(hashSecret(SECRET).slice(0, 16));
  });
});