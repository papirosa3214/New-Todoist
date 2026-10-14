import db from '../src/db.js';
import { randomUUID } from 'node:crypto';
const userId = db.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get().id;
const id = randomUUID();
db.prepare(`INSERT INTO webhook_subscriptions
  (id, owner_user_id, name, url, secret_hash, secret_preview, enabled,
   event_kinds, project_id, codex_thread_id)
  VALUES (?, ?, ?, ?, 'fake-hash', 'qa', 1, ?, ?, ?)`)
  .run(id, userId, 'qa-real-wake-good',
       'http://httpbin.org/status/200',
       JSON.stringify(['plan_subtask_started']),
       'c2fcbcdb-951f-449f-a1bd-123ea2a46a58',
       '8a8a8a8a-8a8a-8a8a-8a8a-8a8a8a8a8a8a');
console.log('REAL_SUB_ID=' + id);
