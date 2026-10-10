// Wake ack: различение queued и acked (карточка 905db3e3-…, D-5).
// Уточнение ведущего 2026-10-10: «ack только по независимому
// подтверждению turn started или явному callback чата; не маркировать
// confirmed по grep очереди».
//
// Что проверяем:
//   • После processWakePass с фейковым runner'ом, возвращающим
//     codex_followup_id, строка в webhook_wake_queue получает этот UUID.
//   • wake_acked_at остаётся NULL (queued, не acked).
//   • registerWakeAck() обновляет wake_acked_at и применяется ко всем
//     строкам wake_queue с таким follow-up UUID.
//   • Повторный processWakePass не трогает wake_acked_at.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import {
  __resetWakeAcksForTest,
  createSubscription,
  enqueueWake,
  processWakePass,
  registerWakeAck,
  type WakeCommandRunner,
} from "../src/lib/webhookSubscriptions.js";

let app: Awaited<ReturnType<typeof buildApp>>;

const fakeFollowup = "feed0000-0000-4000-8000-000000000abc";

const okRunnerWithFollowup: WakeCommandRunner = async () => ({
  ok: true,
  codex_followup_id: fakeFollowup,
});
const okRunnerNoFollowup: WakeCommandRunner = async () => ({ ok: true });
const failRunner: WakeCommandRunner = async () => ({
  ok: false,
  error: "ssh: connection refused",
});

beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  __resetWakeAcksForTest();
  db.prepare("DELETE FROM webhook_wake_queue").run();
  db.prepare("DELETE FROM webhook_subscriptions").run();
});

function makeSub(thread = "01a120f9-1266-7331-a4ca-81f6da2a698b") {
  return createSubscription({
    owner_user_id: "u1",
    name: `wake-ack-${Math.random().toString(36).slice(2, 8)}`,
    url: "http://example.com/hook",
    secret: "wake-ack-secret-1234567890",
    event_kinds: ["plan_subtask_started"],
    codex_thread_id: thread,
  });
}

describe("D-5: wake queued ≠ acked", () => {
  it("processWakePass пишет codex_followup_id и оставляет wake_acked_at NULL", async () => {
    const sub = makeSub();
    enqueueWake(sub.webhook.id, sub.webhook.wake.codex_thread_id!, "ev1", {
      kind: "plan_subtask_started",
      task_id: "t1",
    });
    const r = await processWakePass(okRunnerWithFollowup);
    expect(r.succeeded).toBe(1);
    expect(r.with_followup).toBe(1);
    const w = db
      .prepare("SELECT * FROM webhook_wake_queue WHERE event_id = ?")
      .get("ev1") as any;
    expect(w.codex_followup_id).toBe(fakeFollowup);
    expect(w.wake_acked_at).toBeNull();
    expect(w.wake_acked_kind).toBeNull();
  });

  it("registerWakeAck помечает строку acked и не зависит от повторных pass'ов", async () => {
    const sub = makeSub();
    enqueueWake(sub.webhook.id, sub.webhook.wake.codex_thread_id!, "ev2", {
      kind: "step_outcome",
      task_id: "t2",
    });
    await processWakePass(okRunnerWithFollowup);
    const r = registerWakeAck(fakeFollowup, "codex_chat_callback");
    expect(r.ok).toBe(true);
    const w = db
      .prepare("SELECT * FROM webhook_wake_queue WHERE event_id = ?")
      .get("ev2") as any;
    expect(w.wake_acked_at).toBeTruthy();
    expect(w.wake_acked_kind).toBe("codex_chat_callback");
    // Повторный pass НЕ сбрасывает ack.
    await processWakePass(okRunnerWithFollowup);
    const w2 = db
      .prepare("SELECT wake_acked_at, wake_acked_kind FROM webhook_wake_queue WHERE event_id = ?")
      .get("ev2") as any;
    expect(w2.wake_acked_at).toBe(w.wake_acked_at);
    expect(w2.wake_acked_kind).toBe("codex_chat_callback");
  });

  it("без followup runner'а queued=true, acked=false (queued ≠ acked)", async () => {
    const sub = makeSub();
    enqueueWake(sub.webhook.id, sub.webhook.wake.codex_thread_id!, "ev3", {
      kind: "plan_subtask_started",
      task_id: "t3",
    });
    await processWakePass(okRunnerNoFollowup);
    const w = db
      .prepare("SELECT * FROM webhook_wake_queue WHERE event_id = ?")
      .get("ev3") as any;
    expect(w.delivered_at).toBeTruthy();
    expect(w.codex_followup_id).toBeNull();
    expect(w.wake_acked_at).toBeNull();
  });

  it("runner error: queued остаётся false (delivered_at NULL), retry позже", async () => {
    const sub = makeSub();
    enqueueWake(sub.webhook.id, sub.webhook.wake.codex_thread_id!, "ev4", {
      kind: "plan_subtask_started",
      task_id: "t4",
    });
    await processWakePass(failRunner);
    const w = db
      .prepare("SELECT * FROM webhook_wake_queue WHERE event_id = ?")
      .get("ev4") as any;
    expect(w.delivered_at).toBeNull();
    expect(w.codex_followup_id).toBeNull();
    expect(w.attempts).toBe(1);
    expect(w.last_error).toMatch(/refused/);
    // Восстановление: pass с фейковым фоллоуапом переводит в queued.
    await processWakePass(okRunnerWithFollowup);
    const w2 = db
      .prepare("SELECT * FROM webhook_wake_queue WHERE event_id = ?")
      .get("ev4") as any;
    expect(w2.delivered_at).toBeTruthy();
    expect(w2.codex_followup_id).toBe(fakeFollowup);
    expect(w2.wake_acked_at).toBeNull();
    expect(w2.attempts).toBe(2);
  });

  it("registerWakeAck отвергает пустой followupId", () => {
    const r = registerWakeAck("", "codex_chat_callback");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/followupId/);
  });
});