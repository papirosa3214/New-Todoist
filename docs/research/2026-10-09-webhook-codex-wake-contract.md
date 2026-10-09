# Вебхуки TaskFlow → постоянное пробуждение Codex-чата

Карточка: c3c0c199-23b5-4114-a8b1-3df8d0f6cb68.
Шаг: b8ae6073-56d3-4198-b35e-bdeb1c95de3d, slot `hook_contract`, ревизия плана 3.
Автор: Архитектор. Дата: 2026-10-09.

## Цель

Подтвердить поддерживаемый путь для постоянного пробуждения указанного
Codex-чата (по thread UUID) с сервера TaskFlow при передаче хода между ролями,
и зафиксировать точный API подписок для iOS (CRUD + test, события, диагностика,
подтверждение wake). Нативный UI делает внешний Codex в каноническом Mac-репозитории;
здесь — только серверный контракт и мост.

## Что уже есть

- `server/src/lib/orchestratorWebhook.ts` + таблица `orchestrator_events`:
  - доставляет события `step_outcome`, `review_recorded`,
    `branch_card_accepted`, `test_budget_blocked`, `subtask_blocked`,
    `plan_subtask_stalled_blocked`, `model_failover`;
  - использует локальный реестр-файл `~/.local/state/taskflow/orchestrator-hook.json`
    с url+token, проверяет pid и POST-ит пачку раз в 2 с;
  - рассчитан на **один** короткоживущий приёмник (оркестратор), а не на
    несколько iPhone-подписок с независимыми фильтрами и состоянием доставки.
- `scripts/orchestrator/tf_hook_wait.py` — одноразовый приёмник: поднимает
  HTTP на 127.0.0.1, ждёт первую пачку и завершается. Не persistent.
- Плановая ветка плана: `hook_contract → hook_server → hook_qa → hook_critic`.

## Что показало исследование Mac Codex

Проверено 09.10.2026 на MacBook-Pro-Maksim.local под пользователем `max`.

### Установленные бинари

- `/opt/homebrew/bin/codex` (CLI, версия `codex-cli 0.155.1`).
- `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`
  — тот же CLI, встроенный в ChatGPT.app, который запускает `codex app-server
  --listen stdio://` для каждого thread и worktree.
- Standalone install Codex **отсутствует**: директория
  `~/.codex/packages/standalone/current/codex` не существует.

### Что реально будит чат

Из всех способов подтвердился один — **постановка follow-up в очередь чата**.
Команда `codex queue --thread <UUID> --message<TEXT>`:

- кладёт сообщение в структуру `queued-follow-ups` (см.
  `~/.codex/.codex-global-state.json`, ключ
  `electron-initial-follow-up-queue-mode: "queue"`);
- Codex Desktop ChatGPT.app подхватывает её и **возобновляет thread**;
- это и есть постоянное пробуждение конкретного чата.

Проверено вживую 09.10.2026:

```
$ codex queue --thread 01a120f9-1266-7331-a4ca-81f6da2a698b \
              --message "test wake from taskflow hook investigation"
Queued message 01a12132-b72c-7cf2-991a-319fec5716b5
for thread 01a120f9-1266-7331-a4ca-81f6da2a698b.
```

Это **реальное пробуждение**, а не HTTP-эхо. Имя потока в global state —
именно наш `01a120f9-1266-7331-a4ca-81f6da2a698b` (`thread-reference-capability:...`
в JSON), и проект у него правильный
(`selected-project:{id:62a1d6e9-cccf-4a7b-9609-04d2f8416979}` = TaskFlowNativeBuild).

### Что не сработало / что не подходит

- `codex remote-control start` — требует standalone install, который отсутствует;
  ошибка `managed standalone Codex install not found`.
- `codex app-server daemon start` — то же требование.
- `codex agents` — TUI-просмотр сессий, требует TTY; не подходит для серверной
  доставки.
- `--remote ws://host:port` / `--remote unix://...` для `codex queue` —
  поддерживается в CLI как опция, но remote app-server нужно сначала
  поднять, а у нас сейчас единственный app-server — внутри ChatGPT.app
  (stdio, не TCP). Использовать из серверного скрипта нельзя.

### Альтернатива на будущее: app-server JSON-RPC

Сгенерирована JSON-схема `codex app-server generate-json-schema` от CLI
(37 файлов в `docs/research/codex-app-server-schema/`). Релевантные методы:

- `initialize` (с `clientInfo`) — handshake.
- `thread/resume` — `ThreadResumeParams{ threadId, history?, path?, ... }`,
  привязывает thread к текущему app-server (для нашего случая — к нашему
  CLI-процессу, который в свою очередь подключён к ChatGPT.app).
- `turn/start` — `TurnStartParams{ threadId, input:[UserInput], model?, ... }`,
  возвращает `TurnStartResponse{ turn }`. Это и есть «новый turn» — реальный
  запуск Codex-агента в указанном чате.
- `thread/unsubscribe` — корректно отписаться.

Это путь «нового уровня» (нативный wake без очереди). Использовать его
можно только если удастся держать долгоживущий `codex app-server --listen
unix:///path` процесс с собственным Codex-инстансом. На сегодня это **не
наш путь**: единственный app-server — внутри ChatGPT.app, доступа к его
socket снаружи нет. Поэтому wake-канал остаётся `codex queue --thread`.

## Архитектурное решение

### Канал пробуждения

- **Доставка событий подписки** — серверная HTTP-доставка через
  `orchestratorWebhook`-инфраструктуру (новый код рядом, без поломки
  существующих подписок).
- **Пробуждение Codex-чата** — отдельный долгоживущий мост `tf_codex_wake`,
  который держится на сервере (systemd, на той же машине, что и
  реестр-файл), читает из БД pending wake-запросы и шлёт их через
  `codex queue --thread <UUID> --message<TEXT>` (по SSH на Mac от лица
  владельца `max`, либо с запуском codex CLI локально — TBD на этапе
  реализации).

Это разделение критично: HTTP-доставка ≠ пробуждение чата. Тест подписки
должен возвращать и то и другое как отдельные поля, иначе QA не сможет
отличить «получено iPhone» от «Codex проснулся».

### API подписок для iOS

Базовый путь: `/api/integrations/webhooks`. Все операции — строго через
`authOrApiToken`; владелец с iPhone ходит под своим JWT.

Список событий — ровно те же, что уже пишутся в `orchestrator_events`,
плюс `plan_subtask_started` (нас ради него и затевали):

- `plan_subtask_started`
- `step_outcome`
- `review_recorded`
- `branch_card_accepted`
- `plan_rework_created` (нужно будет добавить в WATCHED_KINDS)
- `subtask_blocked`
- `plan_subtask_stalled_blocked`
- `model_failover`
- `test_budget_blocked`

### CRUD

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| `GET` | `/api/integrations/webhooks` | — | `{webhooks:[WebhookDTO...]}` |
| `POST` | `/api/integrations/webhooks` | `{name, url, secret, enabled, event_kinds, project_id?}` | `{webhook: WebhookDTO}` |
| `GET` | `/api/integrations/webhooks/:id` | — | `{webhook: WebhookDTO}` |
| `PATCH` | `/api/integrations/webhooks/:id` | те же поля, `secret` — только если меняется | `{webhook: WebhookDTO}` |
| `DELETE` | `/api/integrations/webhooks/:id` | — | `{ok: true}` |
| `POST` | `/api/integrations/webhooks/:id/test` | `{codex_thread_id?: string}` | `{delivered: bool, http_status: number, wake_queued: bool, wake_thread_id: string \| null, error: string \| null}` |

`WebhookDTO` — единое представление подписки:

```json
{
  "id": "uuid",
  "name": "iPhone Максима",
  "url": "https://attacker.example/hook",
  "enabled": true,
  "event_kinds": ["plan_subtask_started", "review_recorded"],
  "project_id": "c2fcbcdb-...-NewTodoist",
  "last_delivery_at": "2026-10-09T18:12:31Z",
  "last_error": null,
  "wake": {
    "codex_thread_id": "01a120f9-1266-7331-a4ca-81f6da2a698b",
    "last_wake_at": "2026-10-09T18:12:31Z",
    "last_wake_error": null
  },
  "created_at": "2026-10-09T18:10:00Z"
}
```

**Секрет никогда не возвращается через чтение** (`GET` / `PATCH`-ответ).
Показывается только в `POST`-ответе (после создания/смены) и в `test`-ответе
не показывается. Запись — отдельным `PATCH`-полем с проверкой длины
(>= 16 символов).

### Хранение

Новая таблица `webhook_subscriptions` (миграция `117_webhook_subscriptions`):

```sql
CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_hash TEXT NOT NULL,           -- sha256(secret) + per-user salt
  enabled INTEGER NOT NULL DEFAULT 1,
  event_kinds TEXT NOT NULL,            -- JSON массив строк
  project_id TEXT,                      -- NULL = любой проект
  codex_thread_id TEXT,                 -- UUID чата Codex, NULL если не задан
  last_delivery_at TEXT,
  last_delivery_status INTEGER,         -- HTTP код последней попытки
  last_error TEXT,
  last_wake_at TEXT,
  last_wake_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_webhook_subs_pending ON webhook_subscriptions(enabled, id);
```

Отдельная таблица `webhook_deliveries` для дедупликации по `event_id`:

```sql
CREATE TABLE webhook_deliveries (
  event_id TEXT NOT NULL,              -- стабильный ID из task_events.id
  subscription_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  status INTEGER,                       -- HTTP код
  error TEXT,
  PRIMARY KEY (event_id, subscription_id)
);
```

### Цикл доставки

Новый модуль `server/src/lib/webhookDelivery.ts` (расширение
`orchestratorWebhook`, не замена) запускается раз в 2 секунды, делает:

1. SELECT pending события из `orchestrator_events` (как раньше).
2. Для каждого активного webhook: проверить фильтр `event_kinds` +
   `project_id`. Если не подходит — пропустить.
3. POST события (с заголовком `X-Webhook-Signature: sha256=<hmac>`) на
   `url`, тело — те же `events: [...]` или по одному.
4. Поставить `event_id` в `webhook_deliveries` (UNIQUE) до отправки —
   идемпотентность.
5. На успех — `last_delivery_at`, `last_delivery_status`. На ошибку —
   `last_error`, экспоненциальный backoff (1, 2, 4, 8, 16 мин; 5 попыток).
6. **Независимо** от успеха HTTP: если у подписки задан `codex_thread_id`,
   поставить wake-запрос в таблицу `webhook_wake_queue` (если не было
   дубликата для этого `event_id`).

### Мост пробуждения `tf_codex_wake`

Сервисный юзер (systemd, режим oneshot по сигналу или long-running):

```python
# scripts/orchestrator/tf_codex_wake.py
# 1. SELECT * FROM webhook_wake_queue WHERE delivered_at IS NULL
# 2. ssh max@MacBook-Pro-Maksim.local 'codex queue --thread <UUID> --message <TEXT>'
# 3. UPDATE webhook_wake_queue SET delivered_at = datetime('now'), error = ...
# 4. UPDATE webhook_subscriptions SET last_wake_at = ..., last_wake_error = ...
```

Сценарий автозапуска: подписки с `codex_thread_id` создаются
одновременно с настройкой «wake этого чата» в iOS. По `POST /test`
вызывается синхронно (или сразу в фоне) — это даёт QA способ проверить
«HTTP 200» и «Codex проснулся» как два разных сигнала.

### Ограничения

- `codex queue` сегодня ходит через desktop-bound IPC ChatGPT.app. Если
  Codex Desktop закрыт, очередь будет расти, но не пробудит чат — для
  этого нужно поднимать standalone install и `codex app-server daemon start`.
  Эту работу **выносим в отдельный шаг**, не делаем в рамках hook_server.
- Владелец сменил thread UUID в Codex — нет автосинка. iOS показывает
  текущий, даёт явную кнопку «обновить UUID».
- План владельца: только проект `TaskFlow - NewTodoist`. Это ограничение
  фильтруется на уровне API: `project_id` подписки должен быть
  `c2fcbcdb-...-NewTodoist`, иначе 400.

## Проверки

- `codex queue --thread 01a120f9-1266-7331-a4ca-81f6da2a698b --message ...`
  с .110 через `tf_webhook_proto.py` — успешно, дважды: ID 01a12132-...
  (исследование) и 01a12134-... (повтор после прототипа). Thread жив в
  `~/.codex/.codex-global-state.json`, проект `TaskFlowNativeBuild`.
- `tf_webhook_recv.py` — приёмник на 127.0.0.1 принимает POST с
  `X-Webhook-Signature: sha256=...`, проверяет HMAC, отвечает 200,
  печатает события в stdout. Проверено: `DELIVERED_HTTP 200 {"ok":true}`.
- JSON-схема app-server от CLI 0.155.1 сохранена в
  `docs/research/codex-app-server-schema/` (37 файлов).
- Существующая инфраструктура `orchestratorWebhook` — таблица
  `orchestrator_events` + реестр-файл не трогаем; новая подсистема
  использует её как источник событий.

## Минимальный прототип (в репозитории)

- `scripts/orchestrator/tf_webhook_recv.py` — изолированный тестовый
  приёмник (HMAC, локальный HTTP). Для QA-сценария «доставлено iPhone».
- `scripts/orchestrator/tf_webhook_proto.py` — изолированный wake-тест:
  по SSH на Mac шлёт `codex queue --thread <UUID> --message<TEXT>`.
  Проверяет, что путь пробуждения живой, без правки боевого сервера.

Эти скрипты — не боевая инфраструктура. Они служат QA-доказательством,
что канал работает, пока builder не сделает полноценные API + доставку.

## Ограничения исследования

- Standalone Codex daemon **не установлен** на Mac; `codex remote-control`
  и `codex app-server daemon start` падают.
- App-server внутри ChatGPT.app недоступен снаружи по сети — единственный
  путь пробуждения сегодня через `codex queue` (desktop IPC).
- В журнал `taskflow-last12.patch` и `orchestrator_events` попадают не все
  события, которые нужны iOS: `plan_subtask_started` сейчас не в
  `WATCHED_KINDS`. builder добавит.
- Минимальный прототип (HTTP-доставка по таблице `webhook_subscriptions`)
  делается на шаге `hook_server` — здесь зафиксированы только контракт и
  доказательство поддержки wake.