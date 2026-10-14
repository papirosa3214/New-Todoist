// Прямой функциональный прогон webhook и wake (как в v1).
import db from '../src/db.js';
import { processWebhookDeliveryPass, processWakePass, testSubscriptionDelivery } from '../src/lib/webhookSubscriptions.js';

const TASK_ID = 'c3c0c199-23b5-4114-a8b1-3df8d0f6cb68';
const SUB_ID = process.env.QA_SUB_ID;

let wakeCalls = [];
const fakeRunner = async (threadId, message) => {
  wakeCalls.push({ threadId, message });
  return { ok: true, error: null };
};

let httpCalls = [];
const fakeFetch = async (url, init) => {
  const body = init?.body ?? '';
  httpCalls.push({ url: String(url), bodyPreview: String(body).slice(0,140) });
  return { ok: true, status: 200 };
};

function pushEvent(kind, field, detail) {
  return db.prepare(
    "INSERT INTO orchestrator_events(kind, task_id, field, detail) VALUES (?, ?, ?, ?)"
  ).run(kind, TASK_ID, field, detail).lastInsertRowid;
}

async function main() {
  const ids = [
    pushEvent('plan_subtask_started', 'recheck2', 'subtask started'),
    pushEvent('step_outcome',         'recheck2', 'review submitted'),
    pushEvent('review_recorded',      'recheck2', 'review recorded'),
    pushEvent('plan_rework_created',  'recheck2', 'rework created'),
  ];
  console.log('QUEUED=' + JSON.stringify(ids));

  const pass1 = await processWebhookDeliveryPass(fakeFetch);
  console.log('PASS1=' + JSON.stringify(pass1));
  const pass2 = await processWebhookDeliveryPass(fakeFetch);
  console.log('PASS2=' + JSON.stringify(pass2));
  console.log('HTTP_CALLS_TOTAL=' + httpCalls.length);

  const wake1 = await processWakePass(fakeRunner);
  console.log('WAKE1=' + JSON.stringify(wake1));
  const wake2 = await processWakePass(fakeRunner);
  console.log('WAKE2=' + JSON.stringify(wake2));
  console.log('WAKE_CALLS_TOTAL=' + wakeCalls.length);

  if (SUB_ID) {
    const t = await testSubscriptionDelivery(SUB_ID, fakeFetch, fakeRunner, null);
    console.log('TEST_MOCKED=' + JSON.stringify(t));
  }

  // D1: проверим "real" runner через override (без реального Mac)
  const overrideRunner = async (_t, _m) => {
    // Импортируем в обход — реальная проверка ниже
    return { ok: true, error: null };
  };
  process.env.TASKFLOW_CODEX_WAKE_SCRIPT = '/home/maksim/.local/state/taskflow-runs/worktrees/c3c0c199-23b5-4114-a8b1-3df8d0f6cb68/scripts/orchestrator/tf_wake_dispatch.py';
  // импорт «на лету» — повторяем логику defaultRunner
  const { defaultRunner } = await import('../src/lib/webhookSubscriptions.js')
    .catch(() => ({ defaultRunner: null }));
  if (defaultRunner) {
    try {
      const r = await defaultRunner('recheck-thread-uuid', 'recheck message');
      console.log('REAL_RUNNER=' + JSON.stringify(r));
    } catch (e) {
      console.log('REAL_RUNNER_ERR=' + e.message);
    }
  } else {
    console.log('REAL_RUNNER not exported (ok, skip)');
  }

  process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
