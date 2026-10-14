# MAK-63 — сквозная проверка живых сценариев после чистки

Карточка: 11b02ee3-99bf-495d-b4c9-f3d96a62e00a
Дата: 2026-10-11
Автор: Архитектор (slot executor)
Ветка: roles/11b02ee3-99bf-495d-b4c9-f3d96a62e00a
Снимок main: 8c5dc8e245cdbb780e6396acaafe067d8537d7c3

## Итог

Тесты сервера НЕ зелёные. Из 215 файлов тестов 44 содержат падающие тесты. По двум прогонам: 89 и 109 упавших (расхождение из-за flaky-timeouts). 1468 проходят, 13 пропущены. Базовые API-сценарии живы. Полный UI/iOS/Telegram/голос/повторы/вложения прогон остаётся за владельцем.

## Результаты прогона vitest

- Тесты: 109 failed | 1468 passed | 13 skipped (1590)
- Файлы: 44 failed | 171 passed | 2 skipped (215)
- Время: ~128 секунд

## Группы дефектов (для отдельных задач)

1. **Планы совместной работы и узлы** — 19 файлов, ~50 тестов: branchPlan, livePlan, mak67SingleExecutor, mak68SingleExecutorEntries, readyDispatchBridge, task-collaboration-plans, planComplete, planReviewLifecycle, planNodeGuard, planSubtaskRecovery, subtaskRoleFanout, taskExecutionState, taskPreparationApi, topicInbox, closeOpenCriticPlanNode, coordinatorAdmission, diagnosticDispatch, dispatchRoleChoice, autoPreparation.
2. **Роли и инструменты** — 8 файлов, ~30 тестов: planRoleTools (9), researchTools (3), roles (1), roleContextResolver (1), roleResultReport (10), access (1), inProcessRun (5), chat-session-runtime (1). Часть — `SqliteError: no such table: users`, ошибка setup-фикстуры.
3. **Runtime и провайдеры** — 2 файла, 2 теста: runtime/providers (1), providerFailover (1). Цепочка фолбэка не настроена, основная модель не сохраняется.
4. **Постановка задач владельцем и шаги** — 5 файлов, ~16 тестов: ownerDictation (6), ownerUnblockRedispatch (2), serverSystemControl (3), stepOutcome (3), stalledStepWatcher (2). Массовые timeouts.
5. **Итог/удаление/архив** — 4 файла, 6 тестов: taskOutcome (2), taskPurge (1), projectArchive (1), enrichment (2). Заметка итога падает в чужую папку, purge не удаляет карточку, dependency не работает.
6. **Прочие** — consultationChain (1), linearSource (1). Цепочка консультаций не работает в алиасе 'opus', пагинация Linear не сохраняет курсор.

## Живой сервер

- API 192.168.1.110:3001 (systemd taskflow-server.service): GET задачи, подзадачи, комментарии, проекты, auth/me — все 200.
- БД /home/maksim/Проекты/New-Todoist/server/taskflow.db, миграция 132_review_history.
- Карточка 11b02ee3 в active, план tcp_78eb97a8-5af6-4554-8739-41572903e640 утверждён, узел 91c120b2 in_progress.

## Что не покрыто

- UI-сценарии в браузере (5180): создание задачи, план, роли, доработка QA/критиком, сдача.
- Уведомления iOS и Telegram.
- Чат координации, голосовая постановка.
- Повторяющиеся задачи и вложения.

## Действия владельца

- Подтвердить, что отчёта достаточно для этой карточки.
- Решить, какие группы дефектов оформлять отдельными карточками и кому их назначать.
- Провести полный пользовательский прогон живьём.