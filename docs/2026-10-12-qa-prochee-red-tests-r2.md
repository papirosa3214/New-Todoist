# QA — Прочее (зависимости, policy, recover, list, ручной старт) — recheck

Карточка: b41b0aca-4a45-4629-8f94-c1f40e75e58e
Шаг QA: c31d70ef-fcf1-4405-8a57-0c79b4fb3047 (qa_recheck_2)
Дата: 2026-10-12
Ревизия рабочей ветки: 78d7c034 (фикс self-claim gate, agent-state.ts)
Предыдущий QA-слот: bd308757 (work_1) — 3/5 зелёных

Изолированная временная БД через vitest setup.ts (свой pid и соль на каждый прогон).
Серверный production-код и живая БД не затронуты.

## Сводка

| #  | Тест                                                                | Файл                                          | До   | После |
|----|---------------------------------------------------------------------|-----------------------------------------------|------|-------|
| 1  | задачу с незакрытой зависимостью исполнитель взять не может         | server/test/enrichment.test.ts:72             | RED  | GREEN |
| 2  | неизвестная policy отклоняется, блокировка допуска пишет audit       | server/test/enrichment.test.ts:165            | RED  | GREEN |
| 3  | recoverInterruptedPlanSubtasks: 4 под-теста                         | server/test/planSubtaskRecovery.test.ts:67–100 | GREEN| GREEN |
| 4  | list exposes pagination cursor and never changes source             | server/test/linearSource.test.ts:27           | RED  | RED   |
| 5  | ручной старт карточки создаёт устойчивый признак явного запуска      | server/test/serverSystemControl.test.ts:88    | GREEN| GREEN |

4 из 5 зелёные. D3 не закрыт, отправлен на вторую доработку.

## Что закрыто коммитом 78d7c034

Self-claim gate в server/src/routes/agent-state.ts:367 теперь различает
«командный план» (profile != 'single_executor') и одиночный запуск.
Single-executor план пропускает gate, исполнитель с правильным
assignee_id доходит до unmetDeps-проверки. Сообщение claim теперь
«задача ждёт завершения зависимостей — взять её можно после их
приёмки» (D1), audit-событие `dependency_context_blocked` пишется в
task_events (D2 — events.length === 1, to_value содержит blockerId).

Подтверждено локальным прогоном vitest:
- `npx vitest run test/enrichment.test.ts -t "задачу с незакрытой зависимостью"` → 1 passed.
- `npx vitest run test/enrichment.test.ts -t "неизвестная policy"` → 1 passed.

## Что НЕ закрыто (D3)

linearSource.test.ts:27 «list exposes pagination cursor and never
changes source» — на ревизии 78d7c034 тест красный:

```
AssertionError: expected 'query TaskFlowLinearList($after: Stri…' to match /includeArchived: true/

  Received (server/src/lib/linearSource.ts:35):
    issues(first: 50, after: $after,
           filter: { state: { type: { eq: "started" } } },
           orderBy: createdAt)
```

Тест-стаб проверяет, что в `listLinearIssues` есть подстрока
`includeArchived: true` — а реальный запрос её не содержит.
Коммит `daf44ad1` «fix(linear): список ручного импорта показывает только
задачи в работе» заменил атрибут на filter по `state.type.eq: "started"`.
Доработка 78d7c034 этот код не трогала.

Шаги воспроизведения:
```
cd server
npx vitest run test/linearSource.test.ts -t "list exposes pagination cursor"
```
Результат: 1 failed | 8 skipped.

## Зелёные (доказательство, регрессии не появились)

- `npx vitest run test/planSubtaskRecovery.test.ts` → Test Files 1 passed (1) | Tests 4 passed (4).
- `npx vitest run test/serverSystemControl.test.ts -t "ручной старт карточки"` → Test Files 1 passed (1) | Tests 1 passed | 4 skipped (5).
- `/api/task-intake/drafts/{id}/start` при выключенной Системе создаёт
  `task_collaboration_plans` с profile='single_executor', status='approved',
  rationale содержит «manualStart» — признак явного запуска сохраняется.

## Аудит

В обоих enrichment-тестах в `task_events` теперь появляется
`kind='dependency_context_blocked'` (events.length === 1, поле `to_value`
содержит blockerId). Раньше — 0. Критерий приёмки «audit-событие для
неизвестной policy присутствует в журнале» выполнен.

## Решение

Вердикт: **needs_changes**. Через план запрошена доработка D3 в
отдельном шаге `builder_fix_3` после моего `qa_recheck_2`. Интеграция в
main за Архитектором после повторного зелёного прогона всех 5 тестов.

## Что НЕ покрыто этим слотом

- Регрессионный прогон 6 потоков (218 файлов) серверного дерева
  работающим по факту не проводил — это задача других QA/критиков,
  перенос в main за Архитектором.
- Живой браузерный проход — здесь не применим: все 5 целевых тестов —
  серверные vitest-тесты, браузерного эквивалента нет.
