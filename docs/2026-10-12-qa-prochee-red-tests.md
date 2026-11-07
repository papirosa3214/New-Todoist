# QA — Прочее (зависимости, policy, recover, list, ручной старт)

Карточка: b41b0aca-4a45-4629-8f94-c1f40e75e58e
Шаг QA: bd308757-477c-427a-89eb-e34ce7fb9234 (work_1)
Дата: 2026-10-12

Изолированная временная БД через vitest setup.ts. Серверный production-код и
живая БД не затронуты.

## Сводка

| #  | Тест                                                                                    | Файл                                              | Вердикт |
|----|-----------------------------------------------------------------------------------------|---------------------------------------------------|---------|
| 1  | задачу с незакрытой зависимостью исполнитель взять не может                             | server/test/enrichment.test.ts:72                 | RED     |
| 2  | неизвестная policy отклоняется, блокировка допуска пишет audit-событие                   | server/test/enrichment.test.ts:165                | RED     |
| 3  | recoverInterruptedPlanSubtasks: хвост прерванного in_progress (4 под-теста)              | server/test/planSubtaskRecovery.test.ts:67–100    | GREEN   |
| 4  | list exposes pagination cursor and never changes source                                 | server/test/linearSource.test.ts:27               | RED     |
| 5  | ручной старт карточки создаёт устойчивый признак явного запуска                          | server/test/serverSystemControl.test.ts:88        | GREEN   |

3 из 5 зелёные. 2 enrichment-теста и 1 linearSource — красные; audit-события
`dependency_context_blocked` в журнале task_events в этой ветке нет.

## Дефекты

### D1 · enrichment.test.ts:72

`POST /api/tasks/{id}/claim` при наличии открытой зависимости возвращает 403,
но с сообщением «Агент не назначает себя и не захватывает командную
карточку» вместо «задача ждёт завершения зависимостей». Тест проверяет
`expect(claim.json().error).toContain("зависимост")`.

Корень: server/src/routes/agent-state.ts:371 — self-claim gate
`if (plan || assigned?.assignee_id !== req.userId) return 403...` срабатывает
на любой только что созданной задаче (у неё draft-план), блокируя доступ
до unmetDeps-проверки (строки 448–458), которая и пишет audit-событие
`dependency_context_blocked` и возвращает правильное сообщение.

### D2 · enrichment.test.ts:165

Тест ищет запись `kind='dependency_context_blocked'` в `task_events` для
карточки с открытой зависимостью. После прогона — events.length === 0.
Корень тот же, что у D1: gate блокирует до unmetDeps-ветки.

### D3 · linearSource.test.ts:27

Тест-стаб ловит GraphQL-запрос `listLinearIssues` и проверяет, что в нём
есть подстрока `includeArchived: true`. Фактический запрос в
server/src/lib/linearSource.ts:35–39:

```
issues(first: 50, after: $after,
       filter: { state: { type: { eq: "started" } } },
       orderBy: createdAt)
```

не содержит `includeArchived: true`. Commit daf44ad1 «fix(linear): список
ручного импорта показывает только задачи в работе» заменил этот атрибут
на filter по `state.type.eq: "started"`. Snapshot-запрос по-прежнему
включает `includeArchived: true`.

## Зелёные (доказательство)

- planSubtaskRecovery.test.ts — `recoverInterruptedPlanSubtasks` отдаёт
  ожидаемые `{resumed, blocked, freed}`, попытка переводится в
  `interrupted`, второй обрыв переводит узел в `blocked` без нового
  запуска, на третьем заходе аренда освобождается (freed), а
  succeeded/dead `role_run_jobs` обнуляются в `queued` — running
  с `lease_owner='live-worker'` не трогается.
- serverSystemControl.test.ts:88 — `POST /api/task-intake/drafts/{id}/start`
  при выключенной Системе создаёт `task_collaboration_plans` с
  profile='single_executor', status='approved', rationale содержит
  «manualStart».

## Журнал

- /tmp/dsh-test-results/server.log — сводный отчёт
- /tmp/dsh-test-results/server.test1.log — server.test2.log
- /tmp/dsh-test-results/server.test3.log … server.test5.log — отдельные прогоны
- /tmp/dsh-test-results/outcome-current-baseline.log — снимок baseline 12.10 18:33

## План дальше

В план уже добавлены шаги: `builder_fix_2` (Разработчик правит D1/D2/D3)
→ `qa_recheck_2` (повторная QA). После правок — коммит в этой же ветке
roles/b41b0aca, повторный прогон 5 тестов, и только тогда слот qa можно
сдать зелёным. Интеграция в main за Архитектором после approved.
