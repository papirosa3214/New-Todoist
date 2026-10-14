# Техническое решение: обратная синхронизация TaskFlow → Linear

Карточка: c71832da-b2d1-467f-a05d-18d1e6067e30 (Linear MAK-91). Роль: Архитектор. 06.10.2026.
Основа: main (cfa05b19), миграция 085 (таблицы линейного импорта), `runtime/linearTransport.ts`, `scripts/composio_mcp.mjs`.

## 1. Контекст и ограничения

- Только сервер. Запуск после влития карточки cc7caa43 (автоимпорт). iOS не менять.
- Источник соответствия — `linear_import_tasks` (`owner_id, workspace_id, source_id, task_id, source_url, snapshot, applied_fields`). В живой БД 0 записей — синхронизировать нечего, пока автоимпорт не наполнит таблицу.
- `runtime/linearTransport.ts` намеренно разрешает только `query`; нужен отдельный узкий путь записи фиксированными мутациями, произвольный GraphQL от клиента недопустим.
- Composio (живая проверка 06.10.2026): один ACTIVE-аккаунт linear `ca_HNAxv-vCAufI`; чтение и запись разрешены — no-op `issueUpdate` вернул `success: true`. Гейт «если только чтение — blocked» пройден.
- Модель TaskFlow: `tasks.status ∈ {active, completed}`, `tasks.agent_state ∈ {null, in_progress, blocked, review}`; понятия «отменена» нет (см. открытые вопросы).

## 2. Схема компонентов и поток

Изменение карточки → желаемый статус Linear → очередь → транспорт записи → Linear.

1. `lib/linearSync.ts` — планировщик и воркер очереди, без GraphQL.
2. `runtime/linearWrite.ts` (новый файл, чтобы не конфликтовать с cc7caa43 в `linearTransport.ts`) — `updateIssueState`, `createComment`; внутри тот же `composioCommand`, ветка `--linear-write`.
3. `server/scripts/composio_mcp.mjs`, ветка `--linear-write` — единственное место построения мутации; принимает `{operation:"state"|"comment", issueId, stateId?, body?}`, фиксированный GraphQL, произвольая строка не принимается.
4. Миграция `104_linear_sync`: `linear_sync_queue`, `linear_sync_state`, `linear_sync_states_cache`.
5. Триггер — периодический проход (рекомендация) + вызов из точек смены статуса при событийном варианте.

`runLinearSyncPass(owner)`: по каждой строке mapping считает `desiredLinearState(status, agent_state)`, сравнивает с last_synced, ставит задание в очередь; воркер шлёт `updateIssueState`; успех → last_synced, ошибка → `attempts++`/backoff/`last_error`; `blocked` → In Progress + одноразовый комментарий причины.

## 3. Контракты данных и API

- `linear_sync_queue(id, owner_id, workspace_id, task_id, issue_id, operation CHECK('state','comment'), payload, desired_key, status CHECK('pending','sent','failed'), attempts, next_attempt_at, last_error, created_at, updated_at, UNIQUE(owner_id,workspace_id,task_id,desired_key))`.
- `linear_sync_state(owner_id, workspace_id, enabled DEFAULT 0, last_pass_at, last_sent_at, updated_at)` — выключатель, по умолчанию off.
- `linear_sync_states_cache(owner_id, workspace_id, team_id, name, state_id, type, cached_at)`.

Внутренние функции: `desiredLinearState`, `resolveStateId`, `enqueueTransition`, `runLinearSyncPass`, `linearWrite.updateIssueState/createComment`.
API (owner-only): `GET/PUT /api/integrations/linear/sync` — выключатель, очередь, возраст самого старого pending.

Маппинг: `completed→Done`; `review→In Review`; `in_progress→In Progress`; `blocked→In Progress + комментарий`; `active+agent_state=null→не трогаем`; «отменена»→Canceled (нет в модели).

## 4. Отказные сценарии

Composio недоступен/не подключён/неоднозначен → pending+backoff, карточка не зависит. Linear `errors`/`success=false` → failed+backoff. Нет статуса нужного имени/типа → постоянная ошибка без бесконечных повторов + уведомление. Задача отвязана → задание снимается. Гонки → desired пересчитывается, идемпотентный ключ гасит дубли, при совпадении статуса мутация не шлётся. Простой >30 мин → уведомление владельцу.

## 5. Варианты и компромиссы

A. Периодический reconciliation (1–2 мин) — проще, идемпотентно, укладывается в «несколько минут», не трогает все точки смены статуса. Рекомендуется как MVP.
B. Событийный outbox из точек смены статуса — быстрее, но много точек и риск пропустить; дополнение к A.
Резолв статуса по `(team,name,type)` с кэшем и fallback по `type`. Запись не через `linearImport.ts` (входящий импорт).

## 6. План внедрения и проверки

1. Влить cc7caa43, ветвиться от main. 2. Миграция 104. 3. `--linear-write` в `composio_mcp.mjs`. 4. `runtime/linearWrite.ts`. 5. `lib/linearSync.ts` + врезка в планировщик. 6. Роут настроек/здоровья. 7. Тесты (vitest, без сети): только привязанные; сбой Linear не ломает карточку; повторы; идемпотентность; выключатель; уведомление >30 мин. 8. Живой прогон `in_progress→In Progress`, `review→In Review`, `completed→Done`, мусор убрать.

Критерий готовности — критерии приёмки карточки.

## Открытые вопросы

- «Отменена → Canceled»: в модели TaskFlow нет отмены — нужен источник события/семантика.
- Трогать ли задачи без запуска (`active, agent_state=null`)? По умолчанию — нет.
- Где в UI выключатель и статус здоровья.

## Доказательства

Живая проверка записи: `/home/maksim/taskflow/roles/architect/workspace/linear-write-probe.mjs`. 06.10.2026: аккаунт `ca_HNAxv-vCAufI` ACTIVE, чтение OK, no-op `issueUpdate` → `success: true`. Секреты не печатались.
