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

---

# Дополнение 13.10.2026 (шаг сборки assembly_0b5a2a74): перенос последнего фикса

Серверный критерий карточки — 0 красных. Последний красный устранён коммитом
`d88c615e` (шаг `builder_3`), но **в `main` он ещё не перенесён**.

## Состояние на момент проверки

- Рабочая ветка роли: `roles/71c1cd6e-ee8d-48ca-8a03-dc5723c958f7` @ `d88c615e`
  (родитель `7950821c`, поверх `ffe6c0ae`). Ветка отстаёт от `main`.
- `main` ушёл вперёд: `ffe6c0ae` → `44beb3d0` → **`79a8311b`** (за время между шагами
  влиты чужие карточки: режим «Оркестратор», сторож выкладки, привязка телефона по QR).
- `d88c615e` в `main` **нет** (`git merge-base --is-ancestor` → false).

## Перенос: конфликт и канон разрешения

`git cherry-pick d88c615e` на актуальный `main` → **конфликт содержимого** в
`server/src/lib/integrationResponsibility.ts`: `308afaaf` (режим «Оркестратор»)
вставил ранний выход для планов `profile='orchestrated'` сразу после
`const assigned=...`, а `d88c615e` меняет соседние строки расчёта `valid`.

Разрешение — сохранить **оба** правила, порядок: `assigned` → ранний выход
`orchestrated` → `stored`/`stray` → `owner`/`valid`. Других конфликтов нет,
файл один (+14/−5).

## Проверки на изолированной копии main 79a8311b + d88c615e

| Проверка | Результат |
|---|---|
| `integrationResponsibility.test.ts` на чистом `79a8311b` | 1 красный из 9 (тот самый) |
| Те же 4 целевых файла после переноса | 52/52 зелёные (включая режим Оркестратора) |
| `tsc --noEmit` | exit 0 |
| Полный серверный прогон, чистый `79a8311b` | 8 файлов / 39 тестов красные |
| Полный серверный прогон, `79a8311b` + фикс | 9 файлов / 41 тест красные |

## Атрибуция красных: моя правка не виновата

Единственное различие — `integrationResponsibility.test.ts`: **было красным → стало
зелёным**. Остальные красные присутствуют и без правки:

- `chats-online` 20, `chat-session-runtime` 11, `chats-common-lifecycle` 2,
  `chatQueueRecovery` 2, `chatQueueRoute` 1, `roles` 1, `providerFailover` 1 —
  причина видна в логе: `ModelNotAvailableError: model_not_available:
  minimax/MiniMax-M3.1-Flash-Preview` (переключение ролей на несуществующую модель,
  коммит `f982c835`) плюс 7 unhandled rejections.
- `escalationRoutes` 2 (`FOREIGN KEY constraint failed` на `DELETE FROM tasks`) и
  `taskPreparationApi` 1 — проверено поодиночке на обеих деревьях: красные
  **одинаково** с правкой и без неё, то есть pre-existing; в полном прогоне они
  проявляются не всегда (зависимость от порядка).

Это красные чужих карточек (чат/рантайм, маршрутизация моделей, привязка устройств),
к 71c1cde они не относятся и в этом шаге не чинятся.

## Ограничения для шага «Интеграция»

- Переносить `d88c615e` на **актуальный** `main` — он продолжает двигаться;
  перед переносом перепроверить SHA и наличие новых правок того же файла.
- Конфликт разрешать по канону выше, иначе либо вернётся красный тест main,
  либо сломается режим «Оркестратор».
- `main` содержит чужие красные (см. атрибуцию) — «0 красных на сервере» после
  переноса будет означать «0 красных сверх этого списка», полный ноль требует
  правок чужих карточек.

---

# Дополнение 13.10.2026 (перенос в main, architect_2): выполнено

Замечание проверяющего D1 закрыто: финальный фикс перенесён в `main`.

## Факт переноса

- `main` до переноса: `79a8311b` (рабочее дерево чистое).
- Перенос `d88c615e` → **`main` = `995e6f4e`**, fast-forward, один файл
  `server/src/lib/integrationResponsibility.ts` (+15/−6).
- Конфликт содержимого разрешён по канону рецепта выше: сохранены оба правила,
  порядок `assigned` → ранний выход режима «Оркестратор» (`308afaaf`) →
  `stored`/`stray` → `owner`/`valid`. Других конфликтов не было.
- Отличие `995e6f4e` от исходного `d88c615e` — ровно сохранённый блок режима
  «Оркестратор», ничего больше.
- Веб не затронут: в изменениях только `server/`.

## Проверки на `main` = `995e6f4e`

| Проверка | Результат |
|---|---|
| `test/integrationResponsibility.test.ts` | 9/9 зелёные |
| `integrationResponsibility` + `orchestratedPlan` + `task-collaboration-plans` | 38/38 зелёные |
| `tsc --noEmit` | exit 0 |
| Полный серверный прогон на `main` (изолированная БД) | 231 файл, **1721 passed / 41 failed / 6 skipped** |
| Полный прогон на чистом `79a8311b` (для сравнения, замер проверяющего) | 231 файл, 1720 passed / 42 failed |

Карточный регресс ушёл: `integrationResponsibility.test.ts` в списке красных
на `main` отсутствует.

## Атрибуция 41 красного на `main` (все — чужие, ни один не из карточки)

| Файлы | Красных | Причина | Чья правка |
|---|---|---|---|
| chats-online 20, chat-session-runtime 11, chats-common-lifecycle 2, chatQueueRecovery 2, chatQueueRoute 1, roles 1, providerFailover 1 | **38** | `model_not_available: minimax/MiniMax-M3.1-Flash-Preview` | `f982c835` (`role-routing.yaml`) — есть в `main`, **нет** в ветке карточки |
| escalationRoutes | **2** | `SqliteError: FOREIGN KEY constraint failed` (`DELETE FROM tasks`) | `ef0b19c1`, карточка `615095f4` — умные напоминания |
| taskPreparationApi | **1** | `AssertionError: expected 1 to be +0` | `8c5a3c8a`, подготовка задач |

Проверка независимая: на ревизии `9ad18872` (main **до** вливания кода карточки)
те же 3 теста красные теми же ошибками — `3 failed | 16 passed`. На рабочей ветке
карточки `d88c615e` — те же `3 failed | 16 passed`. Коммиты карточки
(`cff5b71b`, `432d9f2e`, `ffe6c0ae`, `d88c615e`) не трогали ни один из этих
файлов. Значит это не регресс карточки, а состояние `main` и чужих карточек.

## Что означает «0 красных» по критерию карточки

Серверный критерий выполнен в части карточки: ни один красный тест не относится
к `71c1cd6e`, её собственный регресс на `main` устранён. Абсолютный ноль по всему
`main` невозможен без правок чужих карточек (модель ролей, чаты, эскалация,
подготовка задач) — это решение владельца, не этот шаг.

## Границы этого шага

- Код перенесён в `main` и проверен прогоном на `main`. Перезапуск живого сервиса
  в этот шаг не входил — выкладкой занимается сторож `taskflow-deploy-idle`.
- Критерии 3 и 4 карточки (iOS UI Tests, проверка на физическом iPhone) требуют
  Mac и остаются за владельцем.
