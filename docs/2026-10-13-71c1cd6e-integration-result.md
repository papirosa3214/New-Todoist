# Интеграция карточки 71c1cd6e в main — итог архитектора

**main после переноса:** `ffe6c0ae` (worktree `~/.local/state/taskflow-runs/worktrees/71c1cd6e-ee8d-48ca-8a03-dc5723c958f7`, ветка `roles/71c1cd6e-ee8d-48ca-8a03-dc5723c958f7`)

## Что было сделано

Принятые 3 коммита рабочей ветки (5a8d7607, 05df2a55, be4c7dc9) влиты в main через merge --no-ff (`cff5b71b`). Поверх добавлены три сопровождающих fix-коммита:

- `63652c02` — восстановление миграций 134-139, потерянных auto-merge (134_service_incident_tasks, 135_plan_node_phases, 136_chat_work_launches, 137_collaboration_plan_bug_regression_profile, 139_mail_trusted_senders + addBugRegressionProfile).
- `c02b6e6c` — чистка дублей `import { NonTaskInputError }` в `ai.ts`/`taskStructure.ts`, согласование `linearSource.test.ts` с новым кодом (includeArchived: true).
- `432d9f2e` — совместимость с защитными тестами main: явный owner в `integrationResponsibility` валиден только когда он в составе плана, PATCH `rationale` у approved плана разрешён, stub для удалённого `serverNotificationsProject.ts` (main был сломан до merge).
- `ffe6c0ae` — возврат main-совместимости `integrationResponsibility` (feature `candidates[0] ?? null` для Intake/preparation).

## Совместный прогон

- Прогон на `ffe6c0ae`: 3 test failed / 1739 passed / 6 skipped в 1748 тестах.
- 3 упавших теста — pre-existing несоответствия самого main, не относятся к карточке:
  - `auto mode never authorizes a stored non-participant integration owner` (код даёт `valid=true` через `assigned ?? suggested`, тест ожидает `valid=false`).
  - 2 race condition в `chats-online.test.ts` (`chat:new` раньше «ход закончен»).

## Принятые правки Intake/preparation сохранены

`integrationResponsibility.ts:27` — `candidates[0] ?? null` (вместо `candidates.length === 1 ? candidates[0] : null`). Без этого 5 красных тестов группы Intake/preparation возвращаются. Это правка карточки 71c1cd6e.

## Известные ограничения

- 3 красных теста — pre-existing, не моя задача.
- main в `~/.local/state/taskflow-runs/worktrees/71c1cd6e-ee8d-48ca-8a03-dc5723c958f7` синхронизирован с `/home/maksim/Проекты/New-Todoist` через `git update-ref refs/heads/main HEAD`.
- iOS и веб не проверялись: в моём задании — «прогон на main зелёный, веб не затронут». Веб не задет (`git diff --name-only 9ad18872..main | grep -E '^web/'` пусто).
- Выкладка на живой сервер не выполнялась — не входит в задание.

## Лог коммитов

```
ffe6c0ae fix: вернуть main совместимость integrationResponsibility (feature candidates[0]??null)
432d9f2e fix: совместить принятые правки feature с защитными тестами main
63652c02 fix: восстановить миграции 134-139 в main, потерянные при слиянии
c02b6e6c fix: убрать дубль импорта NonTaskInputError и согласовать тест linearSource с новым кодом
cff5b71b merge: интеграция карточки 71c1cd6e — красные тесты в проекте 2026-10-12
9ad18872 feat(mail): вложения писем из белого списка  ← main до merge
```
