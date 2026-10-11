# Вебхуки TaskFlow → iOS подписки и пробуждение Codex-чата

Карточка: `c3c0c199-23b5-4114-a8b1-3df8d0f6cb68` (шаг `hook_server`).
Контракт сформирован Архитектором (commit `90b990f7`) и реализован
Разработчиком (commit ниже).

## Что входит в этот шаг

- CRUD API `/api/integrations/webhooks` под iPhone-владельца;
- durable delivery для всех активных подписок: фильтр `event_kinds`,
  фильтр `project_id`, секрет HMAC в `X-Webhook-Signature: sha256=…`,
  дедупликация по `(event_id, subscription_id)`, экспоненциальный
  backoff (1, 2, 4, 8, 16 минут, всего 5 попыток);
- отдельная wake-очередь `webhook_wake_queue`, которая после **любого**
  HTTP-успеха ставит follow-up в указанный Codex-тред через
  `codex queue --thread <UUID> --message <TEXT>` (см. скрипт
  `scripts/orchestrator/tf_wake_dispatch.py`);
- секрет HMAC **никогда не возвращается** через GET/PATCH — только
  `secret_preview` (`****xxxx`). Полный секрет виден ровно один раз
  в POST-ответе при создании и в PATCH-ответе при ротации;
- план владельца: только проект `c2fcbcdb-951f-449f-a1bd-123ea2a46a58`
  (`TaskFlow - NewTodoist`). Любой другой `project_id` на создании →
  400.

## Виды событий, на которые iPhone-подписка видит

| Вид | Откуда пишется |
|-----|----------------|
| `plan_subtask_started` | `runtime/planSubtaskAdmission.ts:201` — именно ради этого карточка и затевалась |
| `step_outcome` | `agentState.ts:logEvent` при завершении запуска шага |
| `review_recorded` | `agentState.ts:logEvent` при вердикте Критика |
| `branch_card_accepted` | (через `logEvent`) |
| `plan_rework_created` | `runtime/planSubtaskAdmission.ts:847` — раньше в `WATCHED_KINDS` не было |
| `subtask_blocked` | при блокировке шага ролью |
| `plan_subtask_stalled_blocked` | при срабатывании stalled watcher'а |
| `model_failover` | при автоматическом переключении провайдера |
| `test_budget_blocked` | при исчерпании лимита полных прогонов |

Виды синхронизированы с `WATCHED_KINDS` в `lib/orchestratorWebhook.ts` —
там же расширили существующий фильтр, чтобы iPhone-подписки и старый
оркестраторский вебхук читали из одной `orchestrator_events`.

## REST API

Все ручки под `authOrApiToken`; владелец видит все подписки, остальные —
только свои (`isOwner(userId)` в `routes/webhooks.ts`).

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/api/integrations/webhooks` | список подписок владельца |
| `POST` | `/api/integrations/webhooks` | создать подписку (в ответе — полный секрет) |
| `GET` | `/api/integrations/webhooks/:id` | одна подписка |
| `PATCH` | `/api/integrations/webhooks/:id` | правка (секрет ротируется; в ответе — новый секрет, если прислан) |
| `DELETE` | `/api/integrations/webhooks/:id` | снять подписку |
| `POST` | `/api/integrations/webhooks/:id/test` | синхронная проверка: HTTP-доставка + wake-пробуждение раздельно |
| `POST` | `/api/integrations/webhooks/_wake_now` | владелец: принудительно прогнать один проход wake (для QA-инструментов) |

### Тело `POST /api/integrations/webhooks`

```json
{
  "name": "iPhone Максима",
  "url": "https://example.com/hook",
  "secret": "very-long-secret-1234567890",
  "enabled": true,
  "event_kinds": ["plan_subtask_started", "review_recorded"],
  "project_id": "c2fcbcdb-951f-449f-a1bd-123ea2a46a58",
  "codex_thread_id": "01a120f9-1266-7331-a4ca-81f6da2a698b"
}
```

`project_id` опционален, но по умолчанию выставляется ровно на NewTodoist.
Другой UUID → `400`. `codex_thread_id` опционален и при наличии даёт
wake-канал.

### Тело `POST /api/integrations/webhooks/:id/test`

```json
{
  "codex_thread_id": "01a120f9-1266-7331-a4ca-81f6da2a698b"  // опционально, override
}
```

Ответ:

```json
{
  "delivered": true,
  "http_status": 200,
  "wake_queued": true,
  "wake_thread_id": "01a120f9-1266-7331-a4ca-81f6da2a698b",
  "error": null
}
```

`http_status` и `wake_queued` независимы — это критично для QA: HTTP 200
без wake означает «iPhone получил, но Codex ещё спит», а wake_queued=true
при http_status 0 означает «Codex будет разбужен, но iPhone сейчас
оффлайн».

## Что отправляется в `webhook_deliveries`

Один и тот же `event_id` доставляется **в каждую** подписку ровно один
раз. Запись в `webhook_deliveries(event_id, subscription_id)` под
UNIQUE-индексом защищает от повторов и при параллельных проходах
(INSERT OR IGNORE).

## Циклы

- `startWebhookDeliveryLoop()` (`server/src/index.ts`) — фон, тик **1 с**.
  В продакшене — на каждом тике processWebhookDeliveryPass прогоняет
  pending-события; в тестах вызываем вручную.
- `startWakeDeliveryLoop()` — фон, тик **2 с**, прогоняет pending-wake'и
  через `tf_wake_dispatch.py`. В тестах тоже вручную + DI runner.
- `testSubscriptionDelivery()` — синхронно дёргает оба канала для QA.

## Безопасность

- Секрет HMAC хранится как `SHA-256(secret)` в БД + `secret_preview` для
  UI. Полный секрет живёт **только в момент POST/PATCH** в оперативной
  памяти процесса (`rememberSecretForHash`) — этого достаточно, чтобы
  подписать доставку и для тестов. В боевой эксплуатации рекомендуется
  перенос секрета в защищённое хранилище (KMS / Vault); предупреждение
  пишется в лог при работе с фолбэк-секретом.
- Все ручки валидируют URL (только http/https), secret (≥16 символов),
  event_kinds (закрытый список), project_id (только NewTodoist или null
  при явном `null`), codex_thread_id (UUID).
- Нет автоматического подбора `codex_thread_id` — iOS берёт его явной
  кнопкой «обновить UUID», чтобы владелец контролировал, какой чат
  будится.

## Окружение: обязательный ключ шифрования

`server/.env` обязан содержать `TASKFLOW_WEBHOOK_SECRET_KEY` — 32 случайных
байта (base64 или 64 hex-символа). Без него:

- `bootstrapSecrets` падает `fail-closed` с понятной ошибкой в лог;
- `createSubscription` и `testSubscriptionDelivery` отбивают запрос;
- сторож `webhookWakeWatcher` раз в 30 минут поднимает инцидент
  «TASKFLOW_WEBHOOK_SECRET_KEY не задан в окружении» в проект
  «Серверные уведомления» (не чаще одного раза в сутки).

Ключ AES-256-GCM (`server/src/lib/secretBox.ts`). Старое имя
`TASKFLOW_WEBHOOK_SECRET` (использовалось до V2) в коде больше не
читается; если оно лежит в `.env`, его можно удалить, но безопаснее
оставить как есть — конфликта нет.

Карточка-инцидент `webhook-wake-watch-*` снимается заведением ключа и
перезапуском `taskflow-server.service` (tsx watch не перечитывает `.env`).

## Граница с предыдущим шагом

- `orchestrator_events` и `WATCHED_KINDS` — общий источник. Раньше
  `plan_subtask_started` и `plan_rework_created` не попадали в
  `WATCHED_KINDS`, поэтому весь замысел «будить iPhone при старте шага»
  не работал. Расширение сделано в этом же шаге (`lib/orchestratorWebhook.ts`).
- `scripts/orchestrator/tf_webhook_proto.py` (из шага `hook_contract`)
  остаётся как изолированный QA-инструмент; сервер использует свой
  `scripts/orchestrator/tf_wake_dispatch.py`.
