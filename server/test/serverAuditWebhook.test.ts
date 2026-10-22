import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { createSubscription, processWebhookDeliveryPass, WEBHOOK_PROJECT_ID } from "../src/lib/webhookSubscriptions.js";
beforeAll(() => { migrate(); runMigrations();
  db.prepare("INSERT OR IGNORE INTO projects(id,name) VALUES (?, 'audit')").run(WEBHOOK_PROJECT_ID);
  db.prepare("INSERT INTO tasks(id,title,project_id) VALUES ('audit-webhook','fixture',?)").run(WEBHOOK_PROJECT_ID);
});
beforeEach(() => {
  db.prepare("DELETE FROM webhook_delivery_attempts").run();
  db.prepare("DELETE FROM webhook_deliveries").run();
  db.prepare("DELETE FROM webhook_wake_queue").run();
  db.prepare("DELETE FROM webhook_subscriptions").run();
  db.prepare("DELETE FROM orchestrator_events").run();
  createSubscription({ name: "audit", url: "https://fixture.invalid/hook", secret: "fixture-secret-123456", owner_user_id:"u1", event_kinds:["step_outcome"], project_id:WEBHOOK_PROJECT_ID });
});
function event() {
  return Number(db.prepare("INSERT INTO orchestrator_events(task_id,kind) VALUES ('audit-webhook','step_outcome')").run().lastInsertRowid);
}
const calls: string[] = [];
const fakeFetch = (async (_url: unknown, init: RequestInit) => {
  calls.push(JSON.parse(String(init.body)).event_id);
  return new Response("ok", { status: 200 });
}) as typeof fetch;
describe("server audit: webhook backlog and durable identity", () => {
  it("advances beyond 200 old events on subsequent passes", async () => {
    calls.length=0;
    for(let i=0;i<201;i++)event();
    await processWebhookDeliveryPass(fakeFetch);
    await processWebhookDeliveryPass(fakeFetch);
    expect(new Set(calls).size).toBe(201);
    expect(calls).toHaveLength(201);
  });
  it("does not redeliver when an earlier event leaves the day window", async () => {
    calls.length=0;
    const first=event(); event();
    await processWebhookDeliveryPass(fakeFetch);
    db.prepare("UPDATE orchestrator_events SET expired=1 WHERE id=?").run(first);
    await processWebhookDeliveryPass(fakeFetch);
    expect(calls).toHaveLength(2);
  });
  it("honors a legacy successful delivery even when its old page index is unknown", async () => {
    calls.length=0;
    const id=event();
    const sub=db.prepare("SELECT id FROM webhook_subscriptions").get() as {id:string};
    db.prepare("INSERT INTO webhook_deliveries(event_id,subscription_id,status) VALUES (?,?,200)")
      .run(`orch:${id}:37:step_outcome`,sub.id);
    await processWebhookDeliveryPass(fakeFetch);
    expect(calls).toHaveLength(0);
  });
  it("retains a legacy retry id and attempt counter", async () => {
    calls.length=0;
    const id=event();
    const sub=db.prepare("SELECT id FROM webhook_subscriptions").get() as {id:string};
    const legacy=`orch:${id}:37:step_outcome`;
    db.prepare(`INSERT INTO webhook_delivery_attempts
      (event_id,subscription_id,attempt,next_retry_at,status,success) VALUES (?,?,1,datetime('now','-1 minute'),503,0)`)
      .run(legacy,sub.id);
    await processWebhookDeliveryPass(fakeFetch);
    expect(calls).toEqual([legacy]);
    expect(db.prepare("SELECT MAX(attempt) AS n FROM webhook_delivery_attempts WHERE event_id=?").get(legacy)).toEqual({n:2});
  });
  it("revisits a failed first page after progressing through the backlog", async () => {
    calls.length=0;
    for(let i=0;i<201;i++)event();
    await processWebhookDeliveryPass((async()=>new Response("no",{status:503})) as typeof fetch);
    await processWebhookDeliveryPass(fakeFetch);
    db.prepare("UPDATE webhook_delivery_attempts SET next_retry_at=datetime('now','-1 minute')").run();
    await processWebhookDeliveryPass(fakeFetch);
    expect(new Set(calls).size).toBe(201);
  });

});
