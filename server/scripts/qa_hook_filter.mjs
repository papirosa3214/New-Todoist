import db from '../src/db.js';
import { processWebhookDeliveryPass } from '../src/lib/webhookSubscriptions.js';
const fakeFetch = async () => ({ ok: true, status: 200 });
const r = await processWebhookDeliveryPass(fakeFetch);
console.log('PASS=' + JSON.stringify(r));
// Проверим, что только подписки с подходящим kind получили доставку
const only_step = db.prepare("SELECT event_id, subscription_id, status FROM webhook_deliveries WHERE event_id LIKE '%kind-match%' OR event_id LIKE '%kind-mismatch%'").all();
console.log('ONLY_STEP_MATCH=' + JSON.stringify(only_step));
process.exit(0);
