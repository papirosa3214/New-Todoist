# Серверный контракт: resolver причин движения/ожидания (V2)

Дата: 08.10.2026. Автор: Разработчик (по спецификации Архитектора).
Канон: документ `a8bfa7ea-e284-4867-8960-cd2fb985d60b` в TaskFlow —
NewTodoist (V2 поверх V1, с правкой неточностей V1 против живого
кода). Здесь — описание реализации, не сам контракт.

## Зачем

Карточка должна одним запросом объяснить, почему узел не двигается
прямо сейчас, кто за это отвечает и какое действие сейчас
допустимо. Сигналы собираются из уже существующих модулей:

- `failureReasons.ts` — классификатор причины сбоя.
- `failurePolicy.ts` — что сервер делает по коду.
- `stepOutcome.ts` — событие-исход запуска (`step_outcome`).
- `roleRunQueue.ts` — durable очередь, lease, дедупликация.
- `planSubtaskAdmission.ts` — допуск, `canPlanSubtaskBecomeReady`,
  `waitingForPredecessors`, `liftDependencyBlocks`,
  `recoverInterruptedPlanSubtasks`, `settleStalledPlanNode`,
  `finishPlanIfComplete`, `closeOpenCriticPlanNode`.
- `stalledStepWatcher.ts` — потолок автоперезапусков.
- `planReviewLifecycle.ts` — INSERT в `branch_rework_links` после
  `changes_requested`.
- `enricher.ts` — `unmetDependencyIds`.
- `task_events` — журнал карточки.

Резолвер не запускает, не закрывает и не блокирует работу — только
объясняет. Действия делают существующие маршруты, ссылки на них
приходят в `Resolution.links`.

## Файлы реализации

- `server/src/runtime/coordinationResolver.ts` — типы `Resolution`,
  `CauseCode` (20 значений), `ActionCode` (14 значений), `AssigneeRef`,
  `Evidence`, `MetricSnapshot`, `LinkRef`, чистая функция
  `resolveFromFacts` и конструктор `buildResolution`. Без I/O.
- `server/src/runtime/coordinationResolver.read.ts` — слой чтения:
  `collectFacts`, `collectFactsForTask`, `metricWindow`,
  `evidenceRefLooksValid`. Тонкие функции над `db.ts` и `enricher.ts`.
- `server/src/routes/coordination.ts` — четыре эндпоинта
  (`registerCoordinationRoutes`).
- `server/test/coordination/resolver.test.ts` — unit на каждый
  `CauseCode` + `unknown_total` + дедупликация/идемпотентность.

Подключение — в `server/src/index.ts` (`registerCoordinationRoutes(app)`).
Описание API в `AGENT-API.md`, раздел «Координация: почему узел не
двигается».

## Словарь причин (V2)

20 кодов, источник сигнала и связанное действие:

| Cause | Источник | Action |
|---|---|---|
| `ready_to_start` | `canPlanSubtaskBecomeReady` | `start` |
| `waiting_predecessor` | `waitingForPredecessors` / `unmetDependencyIds` | `wait_predecessor` |
| `blocked_dependency` | `agent_state='blocked' AND block_type='dependency'` | `lift_dependency` |
| `waiting_owner` | `agent_state='blocked' AND block_type='needs_input'` | `ask_owner` |
| `waiting_human` | `agent_state='blocked' AND block_type='capability'` | `switch_role` |
| `waiting_transient` | `agent_state='blocked' AND block_type='transient'` | `no_action` |
| `active_run` | `attempts.ended_at IS NULL` + heartbeat < 5 мин | `no_action` |
| `durable_queued_wake` | `role_run_jobs.status IN ('queued','retry_wait')` | `no_action` |
| `recovery_pending` | `recoverInterruptedPlanSubtasks` ИЛИ heartbeat старый при `restartCount < limit` | `no_action` |
| `stalled_manual_review` | `restartCount >= maxRestarts` | `replace_attempt` |
| `provider_limit` | `role_run_jobs.last_error` ∈ `provider_quota_limit`/`provider_rate_limit`/`provider_server_error` | `switch_provider` |
| `permission_or_owner` | `last_error='provider_auth_or_access'` | `ask_owner` |
| `missing_config` | `last_error='missing_config'` | `fix_config` |
| `context_overflow` | `last_error='context_overflow'` | `retry_with_delay` |
| `step_stalled` | `stepOutcome.outcome='stalled'` | `replace_attempt` |
| `review` | `tasks.agent_state='review'` | `accept_review` |
| `branch_rework` | `branch_rework_links` после INSERT в `planReviewLifecycle:195` | `pick_up_after_review` |
| `awaiting_final_review` | `task_collaboration_plan_nodes.instructions LIKE '%[taskflow:final-review]%'` | `run_final_review` |
| `completed_pending_review` | `tasks.status='completed' ИЛИ 'archived'` | `accept_review` |
| `unknown` | Ни одно правило не сработало | `none` |

Полнота словаря контролируется функцией `coversEveryCause()` —
тест проверяет, что у каждого `CauseCode` есть `ActionCode`.

## Правила выбора (порядок важен)

Первый матч выигрывает. Полный список — в
`coordinationResolver.resolveFromFacts`, правила пронумерованы
(`R1.task_terminal`…`R10.fallback`); в `notes` ответа попадает
человек-readable фраза + `rule` для трассировки.

## Assignee

- `active_run` / `durable_queued_wake` / `recovery_pending` /
  `stalled_manual_review` → роль узла (`kind: 'role'`).
- Остальное → `users.id` владельца карточки
  (`tasks.assignee_id ?? tasks.creator_id`).

Координатор (`code_orchestrator`) в V2 не пишется — его сейчас нет,
его роль исполняет архитектор на интеграции.

## Evidence и ссылки

- `evidence` (≤ 7) — формат `таблица.основание`. Тесты и UI
  используют строгий регэксп `^[a-z_]+\.[a-zA-Z0-9_:.-]+$`.
- `links` — относительные пути к существующим маршрутам:
  - `stalled_manual_review` / `step_stalled` →
    `/api/subtasks/:id/restart`.
  - `blocked_dependency` → `/api/tasks/:id/lift-dependency-blocks`.
  - `durable_queued_wake` → `/api/subtasks/:id/cancel`.
  - `review` / `completed_pending_review` → `/api/reviews/:id/accept`.
  - `awaiting_final_review` → `/api/tasks/:id/final-review`.
  - `branch_rework` → `/api/tasks/:id/retry`.
  - `active_run` / `recovery_pending` / `waiting_transient` /
    `ready_to_start` / `waiting_predecessor` / `waiting_owner` /
    `waiting_human` / `provider_limit` / `permission_or_owner` /
    `missing_config` / `context_overflow` / `unknown` → без ссылок
    (UI решает сам, например, через `fix_config` в Настройках).

## Метрика

`GET /api/coordination/_metrics?window=hour|day` — счётчики
`counts: Record<CauseCode, number>` и `actions: Record<ActionCode,
number>`, плюс `top_unknown_subtasks: {subtask_id, last_seen_at}[]`
(до 10 самых свежих неизвестных). Событие `kind='resolution'`
пишется при каждом успешном ответе, payload ≤ 600 байт; метрика
считается по существующей `task_events` без новых таблиц.

## Граница с другими ветками

V2 этого шага НЕ делает:

- durable очередь доставки сообщений/результатов ролям (ветка
  «Устойчивая доставка сообщений», задача `6f180f38-…`).
- fences и идемпотентный допуск запуска (ветка «Единый допуск
  запуска», `34d1f345-…`).
- правило минимального графа (ветка «Минимальные планы»,
  `1bd111b0-…`).
- UI для iOS (ветка «iOS: причины ожидания», `a342eb8b-…`).

Эти ветки остаются в плане как самостоятельные шаги. Здесь
реализован только резолвер и диагностические эндпоинты.

## Совместимость

- Семантика `agent_state` (`in_progress`/`blocked`/`review`/
  `todo`/NULL) — без изменений.
- `Resolution` обратно совместим на уровне полей: новые
  `cause`-значения добавляются, старые не переименованы.
- `contract_version="2.0.0"` — клиент видит, на какой версии он
  читает. Инкремент версии — через миграцию и согласование
  документа V2 → V2.1.

## Проверки

- Unit-тесты `server/test/coordination/resolver.test.ts`:
  - `resolveFromFacts` по каждому из 20 `CauseCode` через
    минимальный `SubtaskFacts`.
  - `coversEveryCause` — все `cause` имеют `action`.
  - `notes` ≤ 500 знаков; `evidence` ≤ 7.
  - `evidenceRefLooksValid` — регэксп строгий, не пропускает
    «...», `..`, и т.п.
  - Причина «ни одно правило не сработало» → `cause='unknown'`.
- Прямой прогон в worktree: `npm --prefix server test --
  coordination/resolver` (vitest, `server/test/coordination/`).
- Чтение через `app.inject()` на собранном `buildApp()` — выход за
  рамки этого шага, остаётся серверному QA (`6e7274a9-…`).
