# Implementation Pack — Этап A: пробуждение idle-агента по адресному сообщению

Карточка: `d3a628eb-a185-46bd-9d74-6388fbfdfc35`
Ответственный за интеграцию: `role_qa` (Лайф-тестировщик).
Рабочая ветка: `roles/d3a628eb-a185-46bd-9d74-6388fbfdfc35` (в этой ветке чисто, `dirty_files=0`).

## Результат для интегратора

Описаны **точечные правки** в коде, **миграции БД**, **точка вызова wake-канала**, **тесты** и **порядок выкладки**. Большая часть правок — серверная, в этой же рабочей ветке. UI не меняется (подтверждено дизайнером). Правки записаны так, чтобы интегратор мог применить их одним набором, прогнать проверки и выложить без переоткрытия решений.

> **Главное ограничение:** 6 открытых вопросов аналитика остаются открытыми (см. ниже). Pack описывает и реализуемое ядро, и мосты «что не делаем без ответа владельца». Без ответа хотя бы на вопросы 1 и 4 код в main не переносить — будут ложные срабатывания.

## Что меняется (changes)

### Файлы и строки

1. **`server/src/migrations.ts`** — добавить миграцию (после `3109/3110`, см. существующие `ALTER TABLE chat_messages ADD COLUMN …`).
   - `chat_messages.delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','sent','delivered','unreachable','wake_queued'))`.
   - Без отдельной таблицы: событие `unreachable_role` идёт в существующий `task_events` (`events/taskEvents.ts`), новый `kind` разрешён его `CHECK` (см. п. 3).

2. **`server/src/lib/agentWake.ts`** — новый модуль, единая точка решения «что делать с адресатом». Экспортирует `resolveAgentWake({ toUserId, taskId, chatMessageId }): WakeDecision`. Возвращает одно из:
   - `{ action: 'slot_wake', threadId, message }` — адресат на слоте этой задачи и `agent_state='in_progress'`.
   - `{ action: 'general_wake', threadId, message }` — не на слоте, но `online=true` (порог 60 с по `users.last_seen_at`, см. миграцию `039_parent_id_and_last_seen_at`).
   - `{ action: 'unreachable', reason: 'offline' | 'no_user' }` — `online=false` или пользователя нет.
   - Чтение состояния — через `db.prepare` напрямую (как в `routes/agentState.ts`), без дополнительной абстракции.

3. **`server/src/routes/chat.ts`** (после `INSERT INTO agent_inbox`, около строки 622) — вызвать `resolveAgentWake`, выполнить действие, записать `delivery_state` и при необходимости событие в `task_events`:
   - `slot_wake` → `tf_wake_dispatch`-раннер (см. п. 4), `delivery_state='wake_queued'`, событие `wake_dispatched`.
   - `general_wake` → POST на общий webhook-канал (см. `tf_wake_dispatch.py --channel general`, **зависит от ответа на вопрос 6**), `delivery_state='wake_queued'`.
   - `unreachable` → `delivery_state='unreachable'` (или `'sent'` — **зависит от ответа на вопрос 5**), событие `task_events.kind='unreachable_role'`, **без ретрая**, **без broadcast** в чат.
   - **Не делать** при сообщениях владельца (channel='owner') и при надиктовке — только для `channel='agents'` и `to_user_id` ≠ null. Это совпадает с существующим `if (taskId && toUserId && routed.channel === AGENT_CHANNEL)` стражем.
   - Фиксация `delivery_state='delivered'` — на успешный ACK от wake-раннера или от iPhone-UI через WebSocket `chat:delivered` (см. существующий `chat:new`) (**зависит от ответа на вопрос 1**).

4. **`server/src/lib/webhookSubscriptions.ts`** — переиспользовать уже существующий `defaultRunner` (`tf_wake_dispatch.py`) без правок скрипта. В новом `agentWake.ts` использовать `WakeCommandRunner` через DI, как в существующих тестах. Если выяснится, что нужен `broadcast=true` (**вопрос 6**), добавить флаг `--broadcast` в скрипт; сейчас по умолчанию скрипт уже адресный (`tf_wake_dispatch.py <thread_uuid> <message_text>`), см. `scripts/orchestrator/tf_wake_dispatch.py:5`.

5. **`server/src/routes/chat.ts`** (рядом со строкой 622) — при `action='unreachable'` добавить:
   - `INSERT INTO task_events (id, task_id, kind, payload_json, created_at) VALUES (?, ?, 'unreachable_role', ?, datetime('now'))` с `payload_json = { chat_message_id, to_user_id, reason }`. Поле `kind` уже расширяемое в миграциях (см. `taskEvents.ts`); если `CHECK` ограничен — добавить `unreachable_role` в список.
   - `UPDATE chat_messages SET delivery_state = 'unreachable' WHERE id = ?` (или `'sent'` — см. вопрос 5).

### Что НЕ меняется

- UI (`ChatScreen`, `ChatRoomScreen`, `InboxScreen`, `ChatComposer`) — дизайнером зафиксировано «UI не меняется».
- `agent_inbox`, его `UNIQUE(chat_message_id)` дедупликация — оставить, она нужна.
- Существующая рассылка `chat:new` через WebSocket.
- Скрипт `scripts/orchestrator/tf_wake_dispatch.py` — пока без правок (если не подтвердится `broadcast=true`).
- Ресурс-лок, правила-манифест, Hermes-доставка — отдельные этапы, в этой карточке не трогаем.

## Build id

- Команда сборки сервера и тестов: `npm run typecheck && npm test --workspace server`. Текущая ревизия `e22179dd` (`roles/d3a628eb-a185-46bd-9d74-6388fbfdfc35`) считается baseline; правки накладываются коммитами в этой же ветке.
- Версия схемы БД (`schema_version` в `db_migrations`) после миграции из п. 1: инкрементируется как обычно в `migrations.ts`, миграция обязана быть идемпотентной (`CREATE INDEX IF NOT EXISTS`/`try/catch` на повтор).
- Build id формируется автоматически CI; разработчик его не задаёт. Для интегратора указано: «применить коммит → прогнать `npm test --workspace server` → зелёный прогон = принятый build».

## Тесты (tests)

Минимальный набор, который пишу в этой ветке в коммите вместе с правками:

1. **`tests/server/agent-wake.test.ts`** — новый файл. Юнит-тесты `resolveAgentWake` на трёх сценариях с подменой доступа к БД через in-memory `better-sqlite3` (как в `tests/server/db.test.ts`):
   - «адресат на слоте этой задачи in_progress» → `action='slot_wake'`.
   - «адресат офлайн (last_seen_at старше 60 с назад)» → `action='unreachable', reason='offline'`.
   - «адресат онлайн, но не на слоте этой задачи» → `action='general_wake'` (если вопрос 6 закрыт положительно; иначе — `action='unreachable', reason='no_slot'`).

2. **`tests/server/chat-wake-integration.test.ts`** — новый файл. Через DI `WakeCommandRunner` (`{ok: true}` / `{ok: false, error: 'timeout'}`):
   - Успех wake → `delivery_state='wake_queued'`.
   - Провал wake → `delivery_state` остаётся `'sent'`, в `task_events` нет записи (потому что wake просто не сработал, это не недоступность).
   - Офлайн-адресат → ровно одна запись `task_events.kind='unreachable_role'`, повторный вызов не плодит дубликатов (идемпотентность по `chat_message_id` в payload_json — индекс `UNIQUE(task_id, kind, json_extract(payload_json,'$.chat_message_id'))`).

3. **Регрессионно** — `npm test --workspace server`. Существующий набор тестов чата (`tests/server/chat.test.ts`) не должен сломаться: проверка маршрутов и `agent_inbox` остаётся.

4. **Ручная проверка на test-стенде** — **после** интеграции в main:
   - Сценарий из критериев приёмки: написать адресное сообщение агенту в слоте, у которого `agent_state='in_progress'`, и убедиться, что в течение 30 с виден ответ и в `chat_messages.delivery_state='delivered'` (или `'wake_queued'` на момент фиксации, см. вопрос 1).
   - Сценарий «офлайн-адресат»: установить `users.last_seen_at` на -120 с, отправить сообщение, проверить `task_events` и `delivery_state='unreachable'`.

Полный регрессионный прогон не входит в мою зону — это работа QA (шаг `feature_test_report` уже запланирован в этой же карточке).

## Deployment notes

- **Зависимость:** карточка `905db3e3-…` (webhooks V2 wake). Без неё wake-канал не активирован — миграция может быть применена, но `defaultRunner` вернёт `wake script not found`. Убедиться, что зависимость закрыта до интеграции.
- **Перед деплоем:**
  1. Подтвердить, что зависимость `905db3e3` вылита в main.
  2. Снять ответы на вопросы 1, 4, 5, 6 из `artifact_sav_e4b67baa-de40-441c-a0e1-3ec0c0ce0bde`.
  3. Применить коммиты из этой ветки в main через rebase/merge (выполняет `role_qa`).
  4. Прогнать `npm run typecheck && npm test --workspace server` на чистом чекауте main.
  5. Перезапустить сервер с пустой очередью `webhook_wake_queue` (правило пустой очереди действует).
- **После деплоя:**
  - Подтвердить, что в `chat_messages` появилась колонка `delivery_state` (`PRAGMA table_info(chat_messages)`).
  - Подтвердить, что `task_events` принимает `kind='unreachable_role'` (`SELECT 1 FROM task_events WHERE kind='unreachable_role' LIMIT 1` после первого сценария).
  - Наблюдать 30 минут за `task_events WHERE kind='unreachable_role'` — должно быть тихо, если только не было реальных офлайн-адресатов.
- **Откат:** одна миграция, обратимая (`DROP COLUMN delivery_state`, `DELETE FROM task_events WHERE kind='unreachable_role'` за отчётный период). Удаление колонки в SQLite требует пересоздания таблицы — поэтому план-откат применяется тем же PR в обратную сторону, а не на проде.

## Открытые вопросы (наследуются из feature_spec)

Без владельца код в main не переносить. Из шести вопросов половину можно снять прямо сейчас из кода:

- **Вопрос 1** — момент фиксации `delivery_state='delivered'`: предлагаю **после `chat:delivered` ACK от WebSocket или `{ok:true}` от wake-раннера в течение 5 с** (состояние `wake_queued` до этого). Без ответа — фиксируем `'wake_queued'` как максимум, `'delivered'` не трогаем.
- **Вопрос 2** — частично недоступный broadcast: считаем всю рассылку провалом при `ok=false` хотя бы у одного получателя; плодить `unreachable_role` по каждому нельзя, фиксируем одно событие по `chat_message_id`.
- **Вопрос 3** — «спящий» = `agent_state IN ('in_progress','review')` (оба пробуждаются). `('blocked','free')` — всегда `unreachable` без wake. Это техническое сужение, согласовать с владельцем.
- **Вопрос 4** — формат `task_events`: `{ chat_message_id, to_user_id, reason }`, `reason ∈ {'offline','no_user','no_slot'}`.
- **Вопрос 5** — отдельная колонка в `chat_messages` нужна (текущие статусы `agent_inbox` — про доставку в очередь роли, не про факт доставки получателю). Если владелец против — вернуть на доработку аналитику, без колонки критерии приёмки не измерить.
- **Вопрос 6** — режим broadcast для `tf_wake_dispatch.py`: текущий скрипт адресный; общий канал для `general_wake` либо добавляет флаг `--broadcast`, либо ходит через `webhook_subscriptions` с новым типом подписки. Без ответа — `general_wake` заменяем на `unreachable, reason='no_slot'`, чтобы не разрастаться.

## Ограничения

- Код в этой ветке ещё **не написан коммитами** — `dirty_files=0`. Это нормально для этапа «implementation_pack»: артефакт передаётся интегратору, а он уже накладывает и проверяет. Если владелец ждал, что Разработчик коммитит сам — это разногласие с правилом «интеграцию выполняет названный ответственный (тут role_qa)».
- Сценарий «спящий получатель → ответ за ≤30 с» в этой ветке **не воспроизводится**: нужны живой чат с двумя слотами и реальный wake-канал. Подтверждение даёт QA на живом сервере (шаг `feature_test_report`).
- Зависимость `905db3e3-…` всё ещё открыта — без неё wake не сработает, даже если код применён.
- 4 из 6 открытых вопросов требуют ответа владельца; код написан быть может, но без этих ответов в main не переносить.

## Материалы

- Карточка: `d3a628eb-a185-46bd-9d74-6388fbfdfc35`
- Feature spec (аналитик): `artifact_sav_e4b67baa-de40-441c-a0e1-3ec0c0ce0bde`
- UX-спека (дизайнер): `artifact_sav_67dbbe92-7910-4e3f-b4f5-633a8d3590b7`
- Wake-канал: `server/scripts/orchestrator/tf_wake_dispatch.py`
- Контракт подписок: `server/docs/webhook-subscriptions.md`
- Зависимость: карточка `905db3e3-…` (webhooks V2 wake)
- Закрытые дубли и ретраи: `ebc4d338`
- Ответственный за интеграцию: `role_qa` (Лайф-тестировщик)
- Рабочая ветка: `roles/d3a628eb-a185-46bd-9d74-6388fbfdfc35`
