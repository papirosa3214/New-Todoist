// Wake-канал для пробуждения Codex-чата: один проход processWakePass
// подменяет runner (без реального SSH), чтобы в QA повторимо проверять
// «получено, не доставлено» и обратное. UNIQUE(event_id,subscription_id)
// защищает от повторной постановки того же wake.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import {
  createSubscription,
  enqueueWake,
  processWakePass,
  type WakeCommandRunner,
} from "../src/lib/webhookSubscriptions.js";

let app: FastifyInstance;
let taskId: string;

let runnerCalls: Array<{ threadId: string; message: string }> = [];
let nextResult: { ok: boolean; error?: string | null } = { ok: true };
const fakeRunner: WakeCommandRunner = async (threadId, message) => {
  runnerCalls.push({ threadId, message });
  return nextResult;
};

beforeAll(async () => {
  app = await buildApp();
  taskId = `wake-test-${process.pid}`;
  db.prepare("INSERT OR IGNORE INTO tasks (id, title) VALUES (?, ?)").run(taskId, "wake");
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  db.prepare("DELETE FROM webhook_wake_queue").run();
  db.prepare("DELETE FROM webhook_subscriptions").run();
  runnerCalls = [];
  nextResult = { ok: true };
});

describe("wake-канал для пробуждения Codex-чата", () => {
  it("постановка в очередь: enqueueWake делает строку и инкрементит wake_count", () => {
    const sub = createSubscription({
      owner_user_id: "u1",
      name: "wake",
      url: "http://example.com/hook",
      secret: "wake-secret-1234567890",
      event_kinds: ["plan_subtask_started"],
      codex_thread_id: "01a120f9-1266-7331-a4ca-81f6da2a698b",
    });
    const ok = enqueueWake(sub.webhook.id, "01a120f9-1266-7331-a4ca-81f6da2a698b", "ev1", {
      kind: "plan_subtask_started",
      task_id: taskId,
      title: "Тест",
    });
    expect(ok).toBe(true);
    const row = db.prepare("SELECT wake_count FROM webhook_subscriptions WHERE id = ?").get(sub.webhook.id) as any;
    expect(row.wake_count).toBe(1);
  });

  it("повторный enqueueWake для той же пары (event_id,sub) не ставит второй wake", () => {
    const sub = createSubscription({
      owner_user_id: "u1",
      name: "wake-dedupe",
      url: "http://example.com/hook",
      secret: "wake-secret-1234567890",
      event_kinds: ["plan_subtask_started"],
      codex_thread_id: "01a120f9-1266-7331-a4ca-81f6da2a698b",
    });
    enqueueWake(sub.webhook.id, "01a120f9-1266-7331-a4ca-81f6da2a698b", "dup", {
      kind: "step_outcome",
      task_id: taskId,
    });
    const second = enqueueWake(sub.webhook.id, "01a120f9-1266-7331-a4ca-81f6da2a698b", "dup", {
      kind: "step_outcome",
      task_id: taskId,
    });
    expect(second).toBe(false);
    const n = db.prepare("SELECT COUNT(*) c FROM webhook_wake_queue WHERE event_id = ?").get("dup") as { c: number };
    expect(n.c).toBe(1);
  });

  it("processWakePass вызывает runner и помечает delivered_at", async () => {
    const sub = createSubscription({
      owner_user_id: "u1",
      name: "wake-pass",
      url: "http://example.com/hook",
      secret: "wake-secret-1234567890",
      event_kinds: ["plan_subtask_started"],
      codex_thread_id: "01a120f9-1266-7331-a4ca-81f6da2a698b",
    });
    enqueueWake(sub.webhook.id, "01a120f9-1266-7331-a4ca-81f6da2a698b", "pass1", {
      kind: "review_recorded",
      task_id: taskId,
    });
    const r = await processWakePass(fakeRunner);
    expect(r.succeeded).toBe(1);
    expect(runnerCalls[0].threadId).toBe("01a120f9-1266-7331-a4ca-81f6da2a698b");
    const row = db.prepare("SELECT delivered_at FROM webhook_wake_queue LIMIT 1").get() as any;
    expect(row.delivered_at).toBeTruthy();
    const subRow = db.prepare("SELECT last_wake_at, last_wake_error FROM webhook_subscriptions WHERE id = ?").get(sub.webhook.id) as any;
    expect(subRow.last_wake_at).toBeTruthy();
    expect(subRow.last_wake_error).toBeNull();
  });

  it("processWakePass при ошибке runner пишет last_error и НЕ помечает delivered_at", async () => {
    const sub = createSubscription({
      owner_user_id: "u1",
      name: "wake-fail",
      url: "http://example.com/hook",
      secret: "wake-secret-1234567890",
      event_kinds: ["plan_subtask_started"],
      codex_thread_id: "01a120f9-1266-7331-a4ca-81f6da2a698b",
    });
    enqueueWake(sub.webhook.id, "01a120f9-1266-7331-a4ca-81f6da2a698b", "fail1", {
      kind: "plan_subtask_started",
      task_id: taskId,
    });
    nextResult = { ok: false, error: "ssh: connect to host timeout" };
    const r = await processWakePass(fakeRunner);
    expect(r.failed).toBe(1);
    expect(r.succeeded).toBe(0);
    const w = db.prepare("SELECT delivered_at, last_error, attempts FROM webhook_wake_queue LIMIT 1").get() as any;
    expect(w.delivered_at).toBeNull();
    expect(w.last_error).toMatch(/ssh/);
    expect(w.attempts).toBe(1);
    const subRow = db.prepare("SELECT last_wake_error FROM webhook_subscriptions WHERE id = ?").get(sub.webhook.id) as any;
    expect(subRow.last_wake_error).toMatch(/ssh/);
  });

  it("повторный processWakePass с восстановленным runner'ом доводит wake до succeeded", async () => {
    const sub = createSubscription({
      owner_user_id: "u1",
      name: "wake-retry",
      url: "http://example.com/hook",
      secret: "wake-secret-1234567890",
      event_kinds: ["plan_subtask_started"],
      codex_thread_id: "01a120f9-1266-7331-a4ca-81f6da2a698b",
    });
    enqueueWake(sub.webhook.id, "01a120f9-1266-7331-a4ca-81f6da2a698b", "retry1", {
      kind: "step_outcome",
      task_id: taskId,
    });
    nextResult = { ok: false, error: "Codex Desktop closed" };
    await processWakePass(fakeRunner);
    nextResult = { ok: true };
    const r2 = await processWakePass(fakeRunner);
    expect(r2.succeeded).toBe(1);
    const w = db.prepare("SELECT delivered_at, attempts FROM webhook_wake_queue LIMIT 1").get() as any;
    expect(w.delivered_at).toBeTruthy();
    expect(w.attempts).toBe(2);
  });

  it("формат wake-сообщения содержит kind и task_id", async () => {
    const sub = createSubscription({
      owner_user_id: "u1",
      name: "wake-fmt",
      url: "http://example.com/hook",
      secret: "wake-secret-1234567890",
      event_kinds: ["plan_subtask_started"],
      codex_thread_id: "01a120f9-1266-7331-a4ca-81f6da2a698b",
    });
    enqueueWake(sub.webhook.id, "01a120f9-1266-7331-a4ca-81f6da2a698b", "fmt1", {
      kind: "plan_subtask_started",
      task_id: "ab12cd34-1234-5678-9abc-def012345678",
      title: "Тестовая карточка",
    });
    await processWakePass(fakeRunner);
    expect(runnerCalls[0].message).toMatch(/\[TaskFlow plan_subtask_started\]/);
    expect(runnerCalls[0].message).toMatch(/ab12cd34/);
  });
});
