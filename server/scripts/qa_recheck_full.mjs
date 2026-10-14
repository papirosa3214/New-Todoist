// QA-recheck 2: полный функциональный прогон webhook-подписок и wake через прямой вызов
// processWebhookDeliveryPass / processWakePass / testSubscriptionDelivery с замоканными fetch+runner.
import db from '../src/db.js';
import { randomUUID } from 'node:crypto';
import {
  processWebhookDeliveryPass, processWakePass, testSubscriptionDelivery,
} from '../src/lib/webhookSubscriptions.js';

const TASK_ID = 'c3c0c199-23b5-4114-a8b1-3df8d0f6cb68';
const PROJECT = 'c2fcbcdb-951f-449f-a1bd-123ea2a46a58';

const userId = db.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get().id;

function newSub(name, filterProject, kinds) {
  const id = randomUUID();
  db.prepare(`INSERT INTO webhook_subscriptions
    (id, owner_user_id, name, url, secret_hash, secret_preview, enabled,
     event_kinds, project_id, codex_thread_id)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(id, userId, name, 'http://127.0.0.1:1/fake', 'fake-hash', 'qa',
         JSON.stringify(kinds), filterProject, '8a8a8a8a-8a8a-8a8a-8a8a-8a8a8a8a8a8a');
  return id;
}

const subMatch         = newSub('qa-match',         PROJECT, ['plan_subtask_started','step_outcome']);
const subMismatchKind  = newSub('qa-kind-mismatch', PROJECT, ['review_recorded']);
const subMismatchProj  = newSub('qa-proj-mismatch', '00000000-0000-0000-0000-000000000000',
                                 ['plan_subtask_started','step_outcome']);
console.log('SUBS=', JSON.stringify({subMatch, subMismatchKind, subMismatchProj}));

function ev(kind, field, detail) {
  return db.prepare("INSERT INTO orchestrator_events(kind, task_id, field, detail) VALUES (?, ?, ?, ?)")
    .run(kind, TASK_ID, field, detail).lastInsertRowid;
}
const evid1 = ev('plan_subtask_started', 'qa-recheck', 'starts here');
const evid2 = ev('step_outcome',         'qa-recheck', 'out');
console.log('EVENTS=', JSON.stringify([evid1, evid2]));

let fetchLog = [];
const fakeFetch = async (url, init) => {
  fetchLog.push({ url: String(url), body: String(init?.body ?? '').slice(0,150) });
  return { ok: true, status: 200 };
};

const pass1 = await processWebhookDeliveryPass(fakeFetch);
console.log('PASS1=' + JSON.stringify(pass1));
const fetchLog_before = fetchLog.length;
const pass2 = await processWebhookDeliveryPass(fakeFetch);
console.log('PASS2=' + JSON.stringify(pass2));
const fetchLog_after = fetchLog.length;
console.log('FETCH_LOG_DELTA=' + (fetchLog_after - fetchLog_before) + ' (ожидаемо 0 — dedupe)');

// Подсчёт доставок по подпискам
const cMatch = db.prepare("SELECT COUNT(*) c FROM webhook_deliveries WHERE subscription_id = ?").get(subMatch).c;
const cKindMismatch = db.prepare("SELECT COUNT(*) c FROM webhook_deliveries WHERE subscription_id = ?").get(subMismatchKind).c;
const cProjMismatch = db.prepare("SELECT COUNT(*) c FROM webhook_deliveries WHERE subscription_id = ?").get(subMismatchProj).c;
console.log('COUNTS match=' + cMatch + ' kindMismatch=' + cKindMismatch + ' projMismatch=' + cProjMismatch);
console.log('(ожидаемо match=2, kindMismatch=0, projMismatch=0)');

// WAKE-проход через замоканный runner (не трогает реальный defaultRunner)
let wakeLog = [];
const fakeRunner = async (threadId, message) => { wakeLog.push({threadId, message}); return { ok: true, error: null }; };
const wake1 = await processWakePass(fakeRunner);
const wake2 = await processWakePass(fakeRunner);
console.log('WAKE1=' + JSON.stringify(wake1));
console.log('WAKE2=' + JSON.stringify(wake2));
console.log('WAKE_LOG_TOTAL=' + wakeLog.length + ' (ожидаемо: только subMatch)');

// TEST
const t = await testSubscriptionDelivery(subMatch, fakeFetch, fakeRunner, null);
console.log('TEST=' + JSON.stringify(t));

// 5xx сценарий: сменим URL на null-приёмник, должен вернуть last_delivery_status=500
db.prepare("UPDATE webhook_subscriptions SET url='http://127.0.0.1:0/boom' WHERE id=?").run(subMatch);
const failingFetch = async () => ({ ok: false, status: 500 });
const failPass = await processWebhookDeliveryPass(failingFetch);
console.log('FAIL_PASS=' + JSON.stringify(failPass));
const subState = db.prepare("SELECT last_delivery_status, last_error FROM webhook_subscriptions WHERE id=?").get(subMatch);
console.log('SUB_STATE=' + JSON.stringify(subState));

process.exit(0);
