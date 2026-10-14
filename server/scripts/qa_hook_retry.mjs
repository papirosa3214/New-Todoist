// Прогон: один pass, событие уже в очереди с detail='500-test'.
// Подписка сменила URL на 500-приёмник. Проверяем, что delivery фиксируется с status=500
// и что retries/backoff активны (status=500 без delivered_at для сдедующих попыток).
import db from '../src/db.js';
import { processWebhookDeliveryPass } from '../src/lib/webhookSubscriptions.js';

const fakeFetch = async (url, init) => {
  return { ok: false, status: 500 };
};

async function main() {
  console.log('QUEUE_BEFORE=' + JSON.stringify(
    db.prepare("SELECT id, kind, task_id, field, detail FROM orchestrator_events WHERE detail='500-test'").all(),
  ));
  const r = await processWebhookDeliveryPass(fakeFetch);
  console.log('PASS=' + JSON.stringify(r));
  console.log('WEBHOOK_DELIVERIES=' + JSON.stringify(
    db.prepare("SELECT event_id, subscription_id, delivered_at, status, error FROM webhook_deliveries ORDER BY delivered_at DESC LIMIT 5").all(),
  ));
  console.log('SUBSCRIPTION=' + JSON.stringify(
    db.prepare("SELECT id, last_delivery_status, last_error FROM webhook_subscriptions").all(),
  ));
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });