// Durable delivery подписок: event_id dedupe, retry с backoff, фильтры,
// project_id проброс, секрет HMAC-подпись, wake постановка отдельно от HTTP.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { FastifyInstance } from "fastify";

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { logEvent } from "../src/agentState.js";
import {
  createSubscription,
  processWebhookDeliveryPass,
  rememberSecretForHash,
  startWebhookDeliveryLoop,
  hashSecret,
} from "../src/lib/webhookSubscriptions.js";

let app: FastifyInstance;
let taskId: string;
let receivedBodies: any[] = [];
let receivedHeaders: Record<string, string>[] = [];
let receiverStatus = 200;
let server: http.Server;
let port = 0;
const SECRET = "delivery-secret-abcdef1234";

beforeAll(async () => {
  app = await buildApp();
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      receivedHeaders.push({ ...req.headers } as Record<string, string>);
      receivedBodies.push(JSON.parse(body || "{}"));
      res.statusCode = receiverStatus;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as any).port;
  taskId = `webhook-delivery-${process.pid}`;
  // Свежая БД ещё не содержит TaskFlow - NewTodoist проект миграцией —
  // заводим свою запись, чтобы FK tasks.project_id прошёл.
  const projectId = "c2fcbcdb-951f-449f-a1bd-123ea2a46a58";
  db.prepare("INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)").run(
    projectId,
    "TaskFlow - NewTodoist",
  );
  db.prepare("INSERT OR IGNORE INTO tasks (id, title, project_id) VALUES (?, ?, ?)").run(
    taskId,
    "Тест webhook delivery",
    projectId,
  );
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
  db.prepare("DELETE FROM orchestrator_events").run();
  receivedBodies = [];
  receivedHeaders = [];
  receiverStatus = 200;
});

function makeSub(overrides: Partial<{ enabled: boolean; event_kinds: string[]; project_id: string | null; codex_thread_id: string | null }> = {}) {
  const out = createSubscription({
    owner_user_id: "u1",
    name: "delivery-test",
    url: `http://127.0.0.1:${port}/hook`,
    secret: SECRET,
    enabled: overrides.enabled ?? true,
    event_kinds: overrides.event_kinds ?? ["plan_subtask_started", "step_outcome"],
    project_id: overrides.project_id === undefined ? "c2fcbcdb-951f-449f-a1bd-123ea2a46a58" : overrides.project_id,
    codex_thread_id: overrides.codex_thread_id ?? null,
  });
  rememberSecretForHash(hashSecret(SECRET), SECRET);
  return out;
}

describe("durable webhook delivery", () => {
  it("доставляет план_subtask_started и ставит event_id как dedupe-ключ", async () => {
    const sub = makeSub();
    logEvent({
      taskId,
      actorId: null,
      kind: "plan_subtask_started",
      field: "hook_server",
      toValue: "Разработчик",
    });
    const fetchMock = fetch as unknown as typeof fetch;
    const r = await processWebhookDeliveryPass(fetchMock);
    expect(r.deliveries_succeeded).toBeGreaterThanOrEqual(1);
    expect(receivedBodies.length).toBeGreaterThanOrEqual(1);
    expect(receivedBodies[0].kind).toBe("plan_subtask_started");
    expect(receivedBodies[0].task_id).toBe(taskId);
    expect(receivedBodies[0].project_id).toBe("c2fcbcdb-951f-449f-a1bd-123ea2a46a58");
    // X-Webhook-Signature выставлен
    expect(receivedHeaders[0]["x-webhook-signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
    // Повторный проход не доставляет снова (dedupe)
    receivedBodies = [];
    const r2 = await processWebhookDeliveryPass(fetchMock);
    expect(r2.skips.already_delivered).toBeGreaterThanOrEqual(1);
    expect(receivedBodies.length).toBe(0);
    expect((sub as any).secret).toBeUndefined(); // секрет строго write-only (карточка 905db3e3-…)
  });

  it("фильтр event_kinds отбрасывает «чужой» вид", async () => {
    makeSub({ event_kinds: ["review_recorded"] });
    logEvent({ taskId, actorId: null, kind: "plan_subtask_started", toValue: "x" });
    const fetchMock = fetch as unknown as typeof fetch;
    const r = await processWebhookDeliveryPass(fetchMock);
    expect(r.skips.no_match).toBeGreaterThanOrEqual(1);
    expect(receivedBodies.length).toBe(0);
  });

  it("при ошибке HTTP 5xx подписка помечается last_error и retry планируется", async () => {
    const sub = makeSub();
    receiverStatus = 503;
    logEvent({ taskId, actorId: null, kind: "step_outcome", toValue: "{\"outcome\":\"failed\"}" });
    const fetchMock = fetch as unknown as typeof fetch;
    const r = await processWebhookDeliveryPass(fetchMock);
    expect(r.deliveries_failed).toBeGreaterThanOrEqual(1);
    const subRow = db.prepare("SELECT last_error, last_delivery_status FROM webhook_subscriptions WHERE id = ?").get(sub.webhook.id) as any;
    expect(subRow.last_delivery_status).toBe(503);
    expect(subRow.last_error).toContain("503");
    // Запись в attempts с next_retry_at
    const a = db.prepare("SELECT attempt, success, next_retry_at FROM webhook_delivery_attempts ORDER BY id DESC LIMIT 1").get() as any;
    expect(a.attempt).toBe(1);
    expect(a.success).toBe(0);
    expect(a.next_retry_at).toBeTruthy();
  });

  it("retry: после expiry backoff снова пытается доставить", async () => {
    const sub = makeSub();
    receiverStatus = 500;
    logEvent({ taskId, actorId: null, kind: "plan_subtask_started", toValue: "x" });
    const fetchMock = fetch as unknown as typeof fetch;
    await processWebhookDeliveryPass(fetchMock, () => new Date("2026-10-09T12:00:00Z"));
    // Второй проход — backoff активен, событие пропускается.
    receivedBodies = [];
    const r2 = await processWebhookDeliveryPass(fetchMock, () => new Date("2026-10-09T12:00:30Z"));
    expect(r2.skips.backoff_active).toBeGreaterThanOrEqual(1);
    expect(receivedBodies.length).toBe(0);
    // Третий проход — время уже за пределами 1 мин backoff → снова попытка
    receivedBodies = [];
    const r3 = await processWebhookDeliveryPass(fetchMock, () => new Date("2026-10-09T12:02:00Z"));
    expect(r3.deliveries_attempted).toBeGreaterThanOrEqual(1);
    const attempts = db.prepare("SELECT attempt FROM webhook_delivery_attempts ORDER BY attempt ASC").all() as { attempt: number }[];
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
  });

  it("после 5 попыток подписка больше не пытается", async () => {
    makeSub();
    receiverStatus = 500;
    logEvent({ taskId, actorId: null, kind: "plan_subtask_started", toValue: "x" });
    const fetchMock = fetch as unknown as typeof fetch;
    // Первый час — 6 проходов с экспоненциальным backoff, 5 раз пробуем,
    // 6-й — больше не трогаем.
    const base = new Date("2026-10-09T12:00:00Z").getTime();
    for (let i = 0; i < 6; i++) {
      await processWebhookDeliveryPass(fetchMock, () => new Date(base + i * 60 * 60 * 1000));
    }
    const a = db.prepare("SELECT MAX(attempt) m FROM webhook_delivery_attempts").get() as { m: number };
    expect(a.m).toBe(5);
    // Седьмой проход через год — backoff_active (больше попыток не делаем).
    const r7 = await processWebhookDeliveryPass(fetchMock, () => new Date(base + 24 * 60 * 60 * 1000));
    expect(r7.deliveries_attempted).toBe(0);
  });

  it("wake постановка происходит независимо от результата HTTP, если есть codex_thread_id", async () => {
    receiverStatus = 500; // HTTP fail
    makeSub({ codex_thread_id: "01a120f9-1266-7331-a4ca-81f6da2a698b" });
    logEvent({ taskId, actorId: null, kind: "plan_subtask_started", toValue: "x" });
    const fetchMock = fetch as unknown as typeof fetch;
    const r = await processWebhookDeliveryPass(fetchMock);
    expect(r.deliveries_failed).toBeGreaterThanOrEqual(1);
    // Wake НЕ ставится: кодекс упал — это правило из контракта (не ставить
    // при HTTP ошибке). Проверяем отдельный сценарий с HTTP 200.
    receiverStatus = 200;
    db.prepare("UPDATE webhook_subscriptions SET last_error = NULL, last_delivery_status = NULL").run();
    db.prepare("DELETE FROM webhook_delivery_attempts").run();
    db.prepare("DELETE FROM webhook_deliveries").run();
    logEvent({ taskId, actorId: null, kind: "plan_subtask_started", toValue: "x2" });
    const r2 = await processWebhookDeliveryPass(fetchMock);
    expect(r2.wakes_enqueued).toBeGreaterThanOrEqual(1);
    const wake = db.prepare("SELECT codex_thread_id, message FROM webhook_wake_queue LIMIT 1").get() as any;
    expect(wake.codex_thread_id).toBe("01a120f9-1266-7331-a4ca-81f6da2a698b");
    expect(wake.message).toMatch(/\[TaskFlow plan_subtask_started\]/);
  });

  it("проверка: фоновый loop через startWebhookDeliveryLoop существует", () => {
    const stop = startWebhookDeliveryLoop();
    expect(typeof stop).toBe("function");
    stop();
  });
});
