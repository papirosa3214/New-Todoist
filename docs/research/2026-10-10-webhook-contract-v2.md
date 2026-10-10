# Вебхуки TaskFlow — доведение до нового чата 01a123bf-a2c4-7192-914b-40ad28bbf3c5 (контракт V2)

Карточка: `905db3e3-74b9-4762-a222-0d84750936d3`.
Шаг: `1b314276-d2b6-4beb-9ad4-bf66d6ccdb6b` (`contract`).
Предыдущая версия контракта: `docs/research/2026-10-09-webhook-codex-wake-contract.md`
(принята по карточке `c3c0c199-23b5-4114-a8b1-3df8d0f6cb68`, merge в main = `51e6da91`).
Автор: Архитектор. Дата: 2026-10-10.

## Цель

Продолжение MAK-119 без новой параллельной системы. Владелец передал
оркестрацию новому чату Codex `01a123bf-a2c4-7192-914b-40ad28bbf3c5`;
старый `01a120f9-1266-7331-a4ca-81f6da2a698b` архивируется.

Принятая карточка c3c0c199 оставила пять точек, в которых живой код
расходится с требованиями приёмки. Архитектурный шаг c3c0c199 не закрыл
эти дефекты (и не должен был: это QA/владелец/контроль нашли их уже
после approved). Здесь — минимальный контракт адресных исправлений,
чтобы Разработчик делал правки адресно, без нового слоя.

## Подтверждённые дефекты в живом коде

| # | Что наблюдается | Где в коде |
|---|---|---|
| **D-1** | HMAC-секрет хранится в `Map<hash,secret>` в памяти процесса; на restart карта пуста, и `resolveSecret` падает в `"fallback-secret:" + hash` — детерминированный ключ, подпись предсказуема из БД | `server/src/lib/webhookSubscriptions.ts:634-648` |
| **D-2** | `PATCH /api/integrations/webhooks/:id` возвращает `secret: incoming.secret`, если в теле прислан валидный `secret` ≥ 16 символов. Даже когда подписку не ротировали — секрет всё равно утечёт в ответ | `server/src/routes/webhooks.ts:99-111` |
| **D-3** | `POST /api/integrations/webhooks/:id/test` возвращает плоские `wake_queued` и `wake_thread_id`, хотя остальные ответы подписки (включая `WebhookDTO.wake.codex_thread_id`) — nested под `wake`. iOS получает несогласованный тип | `server/src/lib/webhookSubscriptions.ts:864-936`, `server/src/routes/webhooks.ts:131-152` |
| **D-4** | `tf_wake_dispatch.py` подставляет сообщение в SSH-команду через `f"... --message {message!r}"`. Python `repr()` не POSIX-safe: одиночный `\` (repr → `\\` → bash литерал), `\xNN` (bash читает как 4 символа), переводы строк (repr → `\n`, bash литерал). Thread UUID тоже без `shlex.quote` | `scripts/orchestrator/tf_wake_dispatch.py:24-37` |
| **D-5** | В wake-ответе нет отдельного `wake_ack`: `defaultRunner` сводит всё к `ok: (exit === 0)`. Контракт требует `HTTP ≠ queued ≠ confirmed` — сейчас `queued` и `confirmed` слиты в один признак | `server/src/lib/webhookSubscriptions.ts:776-822`, `webhook_wake_queue` (нет колонок `codex_followup_id` / `wake_acked_at`) |

Эти пять пунктов — **минимум**, который должен закрыть этот шаг. Не
трогаем бизнес-логику доставки (event_id dedupe, фильтры event_kinds+project,
backoff 1/2/4/8/16 минут — уже сделано и принято).

## Минимальный контракт исправлений

### D-1 — durable HMAC secret

**Что делаем:** добавляем колонку `secret_encrypted BLOB` в
`webhook_subscriptions` (миграция `12x_webhook_durable_secret`), секрет
шифруем на старте процесса через `secretbox` (libsodium-wrappers /
nacl, уже в стеке) ключом из `TASKFLOW_WEBHOOK_SECRET_KEY` (32 байта
base64). На каждом `POST` и `PATCH` (ротация) зашифрованный секрет
пишется в БД. На старте сервера `loadSecretsForSigning()` поднимает
`Map<hash,secret>` ОДИН раз из БД — `Map` остаётся in-process, но он
не пуст после restart.

- **Fallback на детерминированный ключ запрещён.** Если ключа в env
  нет — старт сервера падает с понятной ошибкой.
- `resolveSecret` без `cached` теперь читает из БД, дешифрует, кладёт
  в `Map`, возвращает.
- `secret_preview` остаётся для UI (`****xxxx`).

**Файлы:**
- `server/src/lib/secretBox.ts` (новый) — обёртка над секретбоксом.
- `server/src/migrations.ts` — миграция `12x_webhook_durable_secret`.
- `server/src/lib/webhookSubscriptions.ts` — убрать fallback-ветку
  в `resolveSecret`, расширить `rememberSecretForHash` (или новая
  `bootstrapSecrets`), обновить `createSubscription`/`updateSubscription`.
- `server/docs/webhook-subscriptions.md` — отметить переход.
- `server/.env.example` (без значения ключа).

**Тест:** `restart → подпись тем же ключом после рестарта.
Изолированная БД: создать подписку, перезапустить процесс внутри
vitest-хелпера, стартовать заново, послать синтетический
`plan_subtask_started`, проверить, что HMAC-заголовок совпадает
с расчётным. Файл: `server/test/webhookSecretPersistence.test.ts`.

### D-2 — PATCH не светит секрет без ротации

**Что делаем:** в `routes/webhooks.ts:99-111` отделить факт «секрет
прислан и прошёл длину» от факта «мы его реально ротируем». Ответ
возвращает `secret` **только** если `updateSubscription` сменил
`secret_hash` (новая возвращаемая булева `secretRotated: boolean`).
Сейчас логика уже разделяет «прислан валидный secret» и «обновлён»,
но ответ пробрасывает `incoming.secret` независимо — исправляем
точечно.

**Файлы:**
- `server/src/lib/webhookSubscriptions.ts` — `updateSubscription`
  возвращает `{ dto, secretRotated }`.
- `server/src/routes/webhooks.ts:99-111` — `secret: secretRotated ? новый : undefined`.
- `server/test/webhookSubscriptionsApi.test.ts` — PATCH без `secret`
  → ответа нет; PATCH с `secret` → новый в ответе.

### D-3 — wake DTO nested

**Что делаем:** в `testSubscriptionDelivery` (`webhookSubscriptions.ts:864`)
ответ перекладываем в форму:

```ts
{
  delivered: boolean,
  http_status: number,
  wake: {
    codex_thread_id: string | null,
    has_thread: boolean,
    queued: boolean,        // codex-cli exit 0 + "Queued message" в stdout
    queued_message: string | null,  // UUID follow-up, регексп
    acked: boolean,         // see D-5
    error: string | null,
  },
  error: string | null,
}
```

`wake_queued` и `wake_thread_id` как плоские поля удаляем. iOS
получает согласованный nested-объект с подпиской и с test-ручкой.
Если в подписке нет `codex_thread_id` — `wake` есть, но
`has_thread: false`, `queued: false`.

**Файлы:**
- `server/src/lib/webhookSubscriptions.ts:864-936` — переписать
  `TestDeliveryResult` под nested shape.
- `server/src/routes/webhooks.ts:131-152` — пробросить новый
  результат.
- `server/test/webhookSubscriptionsApi.test.ts` — кейс test-ручки
  проверяет форму ответа.
- Документация: `2026-10-09-webhook-codex-wake-contract.md` — отметить,
  что wake DTO nested и для test, и для подписки.

### D-4 — корректный shell quoting и переносимый путь codex

**Что делаем:** `tf_wake_dispatch.py` переписываем так:
- thread UUID и message сначала escape через `shlex.quote` (POSIX-safe
  для `$`, `` ` ``, `\`, `'`, `"`);
- thread UUID дополнительно проверяется regex
  `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
  иначе exit 64;
- `--message` принимает только строки без управляющих символов
  (`\n`, `\r`, `\x00`-`\x1f`); если такие есть — message сокращается
  до первого безопасного разделителя и в stderr пишется
  «message contained control chars, truncated»;
- общая логика escape вынесена в `tf_codex_quote.py`, оба скрипта
  (`tf_wake_dispatch.py` и `tf_webhook_proto.py`) её импортируют.

Путь к скрипту на .110 уже починен в `51c4c4df` — повторно чинить
не нужно, но в тесте фиксируем, что override
`TASKFLOW_CODEX_WAKE_SCRIPT` (если задан) выигрывает у дефолтного
поиска.

**Файлы:**
- `scripts/orchestrator/tf_codex_quote.py` (новый) — общая утилита
  `shlex_quote_argv` + `validate_codex_thread` + `strip_control`.
- `scripts/orchestrator/tf_wake_dispatch.py` — импортирует утилиту,
  вызывает `shlex.quote`, валидирует UUID.
- `scripts/orchestrator/tf_webhook_proto.py` — то же (для согласованности).
- `server/test/webhookWakeQuoting.test.ts` (новый) — на таблице
  прогоняем типовые опасные сообщения (`$5 'foo'`, `` `pwd` ``,
  backslash, реальный `\n`), проверяем, что на стороне receiver-а
  текст совпадает с присланным.

### D-5 — раздельные `wake_queued` и `wake_acked`

**Что делаем:** в `webhook_wake_queue` добавляем три колонки
(миграция `12x_webhook_wake_ack`):
- `codex_followup_id TEXT` — UUID follow-up, парсится из stdout
  `codex queue` («Queued message 01a…»); NULL если не распознан.
- `wake_acked_at TEXT` — NULL до появления признака подтверждения.
- `wake_acked_kind TEXT` — способ подтверждения (`cli_followup_id`,
  `app_server_turn_started` — будущее).

`defaultRunner` разделяет:
- `ok: queued=true, codex_followup_id=<UUID>` — `wake_queued`,
  `wake_acked=false` (ещё не consumed Codex'ом);
- verify-ack: для каждого `queued` follow-up идём по SSH и проверяем,
  что в `~/.codex/.codex-global-state.json` для нашего thread
  появился этот UUID (через `grep -q "<followup>"`); если да —
  `wake_acked=true`, `wake_acked_at = now`. Если нет — следующая
  попытка через 30 секунд.

App-server недоступен (зафиксировано: единственный app-server внутри
ChatGPT.app, наружу не открыт). Подтверждение потребления реализуем
через `~/.codex/.codex-global-state.json` — это и есть «фактическое
пробуждение» (см. контракт `2026-10-09-webhook-codex-wake-contract.md`,
секция «Что реально будит чат»). Если файл недоступен по SSH
(Codex Desktop закрыт) — оставляем `wake_acked=false`,
`last_wake_error = "codex desktop state not reachable"`.

**Файлы:**
- `server/src/migrations.ts` — миграция `12x_webhook_wake_ack`
  (3 колонки к `webhook_wake_queue`).
- `server/src/lib/webhookSubscriptions.ts` — расширить
  `WakeCommandResult` (`codex_followup_id`, `wake_acked`); развести
  `enqueueWake` → `processWakePass`; добавить поля `last_wake_ack`
  в `WebhookDTO.wake`.
- `scripts/orchestrator/tf_wake_dispatch.py` — выводить
  `FOLLOWUP=<UUID>` после успешного `codex queue` (stdout), чтобы
  `defaultRunner` мог распарсить; режим `--verify-ack` для проверки
  потребления.
- `server/test/webhookWakeAck.test.ts` — кейс: очереди + queued +
  verify-ack; проверка полей `codex_followup_id` и `wake_acked`.

### Переключение на новый чат `01a123bf-a2c4-7192-914b-40ad28bbf3c5`

Ничего в коде не меняем — это пользовательская операция. Владелец
делает `PATCH /api/integrations/webhooks/:id` с
`{"codex_thread_id": "01a123bf-a2c4-7192-914b-40ad28bbf3c5"}`,
preflight через `POST /:id/test`. Старый UUID
`01a120f9-1266-7331-a4ca-81f6da2a698b` оставляем в коде контракта
как зафиксированный факт, но больше не используем; архивация
отдельным шагом у владельца.

## Пробный сторож wake

По правилу «прибор обязан иметь сторожа» (см. `docs/watchers.md`,
«Реестр сторожей») добавляем
`server/src/lib/webhookWakeWatcher.ts`:

- При старте сервера и далее раз в 30 минут:
  1. Создать временную подписку с `codex_thread_id = 01a123bf-…`,
     URL = `http://127.0.0.1:0/synthetic-marker`, владелец = текущий
     service-user.
  2. Записать тестовое событие
     `kind=plan_subtask_started, detail="webhook-wake-watcher probe"`.
  3. Прогнать `processWebhookDeliveryPass` и `processWakePass`.
  4. Проверить, что в `webhook_wake_queue` появилась строка
     `event_id` → `sub.id`, `codex_followup_id IS NOT NULL`.
  5. Удалить временную подписку (каскад снимет доставки и wake).
- Если шаг 4 не сошёлся за 60 секунд — задача в проект
  «Серверные уведомления» по образцу `noteAccessWatcher`: понятный
  заголовок, ссылка на задачу, ровно одна в сутки.
- Запись в `docs/watchers.md` сразу после успешного прогона.

## Границы реализации

- **Не делать новую параллельную систему.** Никакого «wake v2»,
  отдельных очередей, отдельного API. Исправления — внутри
  существующих `server/src/lib/webhookSubscriptions.ts`,
  `routes/webhooks.ts`, `server/src/migrations.ts`,
  `scripts/orchestrator/tf_wake_dispatch.py`.
- **Native / iPhone.** Не правим. Ничего не копируем на .110.
  iPhone уже понимает nested `wake.codex_thread_id` в DTO подписки
  — D-3 сводит test-ответ к этой же форме.
- **dirty main.** Не мерджим, не выкатываем. Изменения — в worktree
  роли (текущий: `roles/905db3e3-74b9-4762-a222-0d84750936d3`),
  коммит передаётся архитектору.
- **Активные роли на сервере.** Перед `ALTER TABLE` —
  убедиться, что нет активных доставок. Миграция 12x не мешает
  существующим подпискам: `secret_encrypted` nullable до первого
  использования.
- **App-server.** Вне нашего пути, не выдумываем подтверждение
  через JSON-RPC, которого нет.

## Критерии приёмки (после QA/Критика, перед интеграцией)

1. **restart → подпись тем же ключом.** Подписка, созданная до restart,
   после restart подписывает доставку тем же SHA-256(HMAC). Никакого
   «fallback-secret:» в логе быть не должно.
2. **Секрета нет ни в одном GET/PATCH/test-ответе**, кроме момента
   ротации. Возврат `secret` в PATCH возможен только когда в теле
   реально пришёл новый `secret` и длина ≥ 16.
3. **DTO test-ответ nested.** `wake.codex_thread_id`,
   `wake.queued`, `wake.queued_message`, `wake_acked` или ясный
   `wake_acked=false`. iOS-форма согласована с подпиской.
4. **Shell quoting.** `$5 'foo'`, `` `pwd` ``, перевод строки,
   backslash проходят на receiver ровно как на стороне сервера.
   Thread UUID с неподходящим форматом → exit 64, без попытки
   подключения по SSH.
5. **HTTP ≠ queued ≠ acked.** В `webhook_wake_queue` различимы
   `codex_followup_id` и `wake_acked_at`. Тест-ответ подписки
   возвращает `wake.queued` и `wake.acked` как раздельные булевы.
6. **Dedupe.** Повтор `event_id` в подписке — нет повторной доставки
   (это уже есть, не сломали).
7. **Сторож.** `webhookWakeWatcher` подключён в `server/src/index.ts`,
   на старте и каждые 30 минут делает пробу; сбой → задача в
   «Серверные уведомления», не чаще одной в сутки.

## Передача в main (Архитектор как ответственный за интеграцию)

После approved от Критика:

1. Забираю коммит(ы) Разработчика из worktree ветки
   `roles/905db3e3-74b9-4762-a222-0d84750936d3`.
2. Проверяю, что в очереди `node-run-jobs` пусто и нет активных
   ролей с hold на сервере. По правилу пустой очереди: если есть
   активные запуски — сообщаю в ленте задачи, что перенос отложен
   до завершения, и возвращаюсь к нему позже (не сбрасываю
   дерево и не удаляю стэш).
3. Merge коммитов в `main` через `--no-ff` с сообщением
   «merge: 905db3e3 webhook durable secrets + wake ack (SHA)».
4. Прогон `tsc` + `vitest` на main на сухой ветке. Если упало —
   останавливаюсь и пишу дефект, не выкатываю.
5. Выкладку на .110 координирую с внешним ведущим (Оркестратор Codex
   `01a123bf-a2c4-7192-914b-40ad28bbf3c5`): не перезапускаю при
   активных ролях. Подтверждение выкладки — отдельный комментарий
   в ленте карточки с пометкой «main: <sha>, прод: <rev smoke>».
6. Не считаю ветку интегрированной, пока в `routes/webhooks.ts` и
   `server/src/lib/webhookSubscriptions.ts` в работающей сборке на
   .110 не подтверждены ревизии, указанные в критериях выше.

## Что не делаем в этом шаге

- Не выкатываем новый API.
- Не мигрируем существующие строки `webhook_subscriptions` кроме
  колонки `secret_encrypted` (nullable до первого использования).
- Не правим `server/src/lib/orchestratorWebhook.ts`.
- Не вводим дополнительных ролей и субагентов.
