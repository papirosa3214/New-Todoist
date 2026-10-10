// CRUD API подписок /api/integrations/webhooks: секрет write-only,
// фильтры event_kinds+project_id, проверка владельца, test-эндпоинт
// возвращает раздельные HTTP и wake признаки.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { FastifyInstance } from "fastify";

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { WEBHOOK_PROJECT_ID } from "../src/lib/webhookSubscriptions.js";

let app: FastifyInstance;
let apiToken: string;
let receivedSecret: string | null = null;
let receiverStatus = 200;
let server: http.Server;
let port = 0;
const VALID_SECRET = "super-secret-1234567890";

beforeAll(async () => {
  app = await buildApp();
  server = http.createServer((req, res) => {
    receivedSecret = req.headers["x-webhook-signature"]?.toString() ?? null;
    res.statusCode = receiverStatus;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as any).port;
  // Регистрируем владельца через API (как в других тестах) и берём JWT —
  // в свежей БД после runMigrations учётки u1 ещё нет, поэтому создаём
  // заново и поднимаем до owner. Это проще и устойчивее, чем завязываться
  // на конкретный ID заранее.
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "Webhook owner",
      email: `webhook-owner-${process.pid}@test`,
      password: "password123",
    },
  });
  expect(reg.statusCode).toBe(200);
  const body = reg.json();
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(body.user.id);
  apiToken = body.token as string;
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
  receivedSecret = null;
  receiverStatus = 200;
});

function token(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("webhooks API: CRUD, секрет write-only, фильтры", () => {
  it("POST создаёт подписку и НЕ возвращает секрет (write-only)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "iPhone Максима",
        url: `http://127.0.0.1:${port}/hook`,
        secret: VALID_SECRET,
        event_kinds: ["plan_subtask_started", "review_recorded"],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // уточнение ведущего 2026-10-10: секрет строго write-only во ВСЕХ
    // ответах, включая создание. Владелец знает секрет — он его прислал.
    expect((body as any).secret).toBeUndefined();
    expect(body.webhook.id).toBeTruthy();
    expect(body.webhook.secret_preview).toBe("****7890");
  });

  it("GET список не возвращает секрет, только preview", async () => {
    await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "listme",
        url: `http://127.0.0.1:${port}/hook`,
        secret: VALID_SECRET,
        event_kinds: ["plan_subtask_started"],
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.webhooks).toHaveLength(1);
    expect(body.webhooks[0].secret_preview).toBe("****7890");
    expect((body.webhooks[0] as any).secret).toBeUndefined();
  });

  it("PATCH без секрета не возвращает секрет", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "patchme",
        url: `http://127.0.0.1:${port}/hook`,
        secret: VALID_SECRET,
        event_kinds: ["plan_subtask_started"],
      },
    });
    const id = created.json().webhook.id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/integrations/webhooks/${id}`,
      headers: token(apiToken),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().secret).toBeUndefined();
  });

  it("PATCH с новым секретом НЕ возвращает секрет даже при ротации", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "rotate",
        url: `http://127.0.0.1:${port}/hook`,
        secret: VALID_SECRET,
        event_kinds: ["plan_subtask_started"],
      },
    });
    const id = created.json().webhook.id;
    const NEW_SECRET = "rotated-secret-9876543210";
    const res = await app.inject({
      method: "PATCH",
      url: `/api/integrations/webhooks/${id}`,
      headers: token(apiToken),
      payload: { secret: NEW_SECRET },
    });
    expect(res.json().secret).toBeUndefined();
  });

  it("DELETE снимает подписку", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "del",
        url: `http://127.0.0.1:${port}/hook`,
        secret: VALID_SECRET,
        event_kinds: ["plan_subtask_started"],
      },
    });
    const id = created.json().webhook.id;
    const r1 = await app.inject({
      method: "DELETE",
      url: `/api/integrations/webhooks/${id}`,
      headers: token(apiToken),
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: "GET",
      url: `/api/integrations/webhooks/${id}`,
      headers: token(apiToken),
    });
    expect(r2.statusCode).toBe(404);
  });

  it("project_id по умолчанию = TaskFlow - NewTodoist; другой — 400", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "wrong-project",
        url: `http://127.0.0.1:${port}/hook`,
        secret: VALID_SECRET,
        event_kinds: ["plan_subtask_started"],
        project_id: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/TaskFlow/);
    const ok = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "ok",
        url: `http://127.0.0.1:${port}/hook`,
        secret: VALID_SECRET,
        event_kinds: ["plan_subtask_started"],
        project_id: WEBHOOK_PROJECT_ID,
      },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("неподдерживаемый event_kinds — 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "bad-kind",
        url: `http://127.0.0.1:${port}/hook`,
        secret: VALID_SECRET,
        event_kinds: ["unknown_kind"],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("URL не-http(s) — 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "file-url",
        url: "file:///etc/passwd",
        secret: VALID_SECRET,
        event_kinds: ["plan_subtask_started"],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("секрет короче 16 символов — 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "short",
        url: `http://127.0.0.1:${port}/hook`,
        secret: "short",
        event_kinds: ["plan_subtask_started"],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /:id/test возвращает nested wake DTO и разделяет http/wake", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "testme",
        url: `http://127.0.0.1:${port}/hook`,
        secret: VALID_SECRET,
        event_kinds: ["plan_subtask_started"],
        codex_thread_id: "01a120f9-1266-7331-a4ca-81f6da2a698b",
      },
    });
    const id = created.json().webhook.id;
    receiverStatus = 503;
    const r = await app.inject({
      method: "POST",
      url: `/api/integrations/webhooks/${id}/test`,
      headers: token(apiToken),
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.http_status).toBe(503);
    // D-3: wake — nested объект, совместимый по shape с WebhookDTO.wake.
    expect(body.wake).toBeTruthy();
    expect(body.wake.codex_thread_id).toBe("01a120f9-1266-7331-a4ca-81f6da2a698b");
    expect(body.wake.has_thread).toBe(true);
    expect(typeof body.wake.queued).toBe("boolean");
    expect(typeof body.wake.acked).toBe("boolean");
    expect(body.wake.acked).toBe(false);
    // плоские поля wake_queued/wake_thread_id удалены
    expect((body as any).wake_queued).toBeUndefined();
    expect((body as any).wake_thread_id).toBeUndefined();
  });

  // D-5 DTO (rework 2026-10-10): last_wake_ack раньше всегда был
  // { codex_followup_id: null, acked: false, acked_at: null, kind: null }
  // из-за чтения несуществующей колонки `last_wake_followup_id`. Теперь
  // подтягиваем из webhook_wake_queue по LIMIT 1 ORDER BY id DESC.
  it("last_wake_ack подтягивается из webhook_wake_queue (D-5 DTO rework)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
      payload: {
        name: "ack-dto",
        url: `http://127.0.0.1:${port}/hook`,
        secret: VALID_SECRET,
        event_kinds: ["plan_subtask_started"],
        codex_thread_id: "01a120f9-1266-7331-a4ca-81f6da2a698b",
      },
    });
    const id = created.json().webhook.id;
    // Свежая подписка — wake_queue пуст, last_wake_ack «нейтральный».
    const fresh = await app.inject({
      method: "GET",
      url: `/api/integrations/webhooks/${id}`,
      headers: token(apiToken),
    });
    expect(fresh.json().webhook.last_wake_ack).toEqual({
      codex_followup_id: null,
      acked: false,
      acked_at: null,
      kind: null,
    });

    // Прямая вставка строки wake_queue с followup_id и wake_acked_at —
    // имитация постановки в очередь + ack через chat callback.
    db.prepare(
      `INSERT INTO webhook_wake_queue
         (event_id, subscription_id, codex_thread_id, message,
          delivered_at, attempts, codex_followup_id, wake_acked_at, wake_acked_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ev-ack-dto",
      id,
      "01a120f9-1266-7331-a4ca-81f6da2a698b",
      "тест",
      new Date().toISOString(),
      1,
      "feed0000-0000-4000-8000-000000000abc",
      new Date().toISOString(),
      "codex_chat_callback",
    );

    // Подписка с подтверждённым ack теперь видна в DTO как acked=true.
    const acked = await app.inject({
      method: "GET",
      url: `/api/integrations/webhooks/${id}`,
      headers: token(apiToken),
    });
    expect(acked.json().webhook.last_wake_ack.acked).toBe(true);
    expect(acked.json().webhook.last_wake_ack.codex_followup_id).toBe(
      "feed0000-0000-4000-8000-000000000abc",
    );
    expect(acked.json().webhook.last_wake_ack.kind).toBe("codex_chat_callback");
    expect(acked.json().webhook.last_wake_ack.acked_at).toBeTruthy();

    // Проверяем и list-эндпоинт.
    const listed = await app.inject({
      method: "GET",
      url: "/api/integrations/webhooks",
      headers: token(apiToken),
    });
    const found = (listed.json().webhooks as any[]).find((w) => w.id === id);
    expect(found.last_wake_ack.acked).toBe(true);

    // Добавляем свежую строку БЕЗ ack — должна выигрывать по id DESC.
    db.prepare(
      `INSERT INTO webhook_wake_queue
         (event_id, subscription_id, codex_thread_id, message,
          delivered_at, attempts, codex_followup_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ev-later",
      id,
      "01a120f9-1266-7331-a4ca-81f6da2a698b",
      "свежий wake",
      new Date().toISOString(),
      1,
      "feed0000-0000-4000-8000-00000000ffff",
    );
    const refreshed = await app.inject({
      method: "GET",
      url: `/api/integrations/webhooks/${id}`,
      headers: token(apiToken),
    });
    expect(refreshed.json().webhook.last_wake_ack.codex_followup_id).toBe(
      "feed0000-0000-4000-8000-00000000ffff",
    );
    expect(refreshed.json().webhook.last_wake_ack.acked).toBe(false);
  });
});
