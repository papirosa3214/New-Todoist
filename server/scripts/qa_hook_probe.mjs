// Синтетический QA-прогон webhook-подписок и wake-канала.
// Запускать: DB_PATH=<qa_db> QA_SUB_ID=<id> node scripts/qa_hook_probe.mjs
import db from '../src/db.js';
import {
  processWebhookDeliveryPass,
  processWakePass,
  testSubscriptionDelivery,
} from '../src/lib/webhookSubscriptions.js';

const SUB_ID = process.env.QA_SUB_ID;
const TASK_ID = 'c3c0c199-23b5-4114-a8b1-3df8d0f6cb68';
if (!SUB_ID) { console.error('QA_SUB_ID required'); process.exit(1); }

let wakeCalls = [];
const fakeRunner = async (threadId, message) => {
  wakeCalls.push({ threadId, message });
  return { ok: true, error: null };
};

function queueEvent(kind, task_id = TASK_ID, field = 'subtask', detail = 'synthetic-qa') {
  const r = db.prepare(`INSERT INTO orchestrator_events(kind, task_id, field, detail) VALUES (?, ?, ?, ?)`).run(kind, task_id, field, detail);
  return r.lastInsertRowid;
}

let httpCalls = [];
const fakeFetch = async (url, init) => {
  const body = init?.body ?? '';
  const sig = init?.headers?.['X-Webhook-Signature'] ?? '';
  httpCalls.push({ url, sig, bodyPreview: String(body).slice(0, 120) });
  return { ok: true, status: 200 };
};

async function main() {
  const ids = [
    queueEvent('plan_subtask_started', TASK_ID, 'hook_qa', 'subtask started'),
    queueEvent('step_outcome', TASK_ID, 'hook_qa', 'review'),
    queueEvent('review_recorded', TASK_ID, 'hook_qa', 'review'),
    queueEvent('plan_rework_created', TASK_ID, 'hook_qa', 'rework'),
  ];
  console.log('QUEUED=' + JSON.stringify(ids));

  const pass1 = await processWebhookDeliveryPass(fakeFetch);
  console.log('PASS1=' + JSON.stringify(pass1));
  const pass2 = await processWebhookDeliveryPass(fakeFetch);
  console.log('PASS2=' + JSON.stringify(pass2));
  console.log('HTTP_CALLS=' + JSON.stringify({ total: httpCalls.length }));

  const wake1 = await processWakePass(fakeRunner);
  console.log('WAKE1=' + JSON.stringify(wake1));
  console.log('WAKE_CALLS=' + JSON.stringify({ total: wakeCalls.length }));

  const wake2 = await processWakePass(fakeRunner);
  console.log('WAKE2=' + JSON.stringify(wake2));

  const test = await testSubscriptionDelivery(SUB_ID, fakeFetch, fakeRunner, null);
  console.log('TEST=' + JSON.stringify(test));

  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });