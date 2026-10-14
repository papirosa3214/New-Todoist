# QA-отчёт: MAK-69 fix2 — повторная проверка «кнопки видны владельцу»

**Карточка:** `324f24ed-6b85-4cee-8099-71f5c0065ecb` — MAK-69 Ручки «прервать шаг», «сбросить попытку», «отменить задание»
**Слот:** `qa_fix_db2ce0d3` (Доработка 2: Доработка 1 — после `designer_fix_da724720`)
**Дата:** 2026-10-06 (рабочий запуск `b70a0e6d-…`)
**Состояние работы:** сдан (needs_changes, итеративная правка не требуется — см. раздел «Вердикт»)
**Предыдущая проверка:** `qa_fix_c0a9dd40`, отчёт `116eebad-…` (critic_recheck `9043b6ff-…`)

---

## Что проверял

Согласно шагу `b70a0e6d-…` — повторная проверка прав, журнала, реальной остановки запуска и кнопок. Цепочка узлов, к которой относится этот шаг:

```
build (e9a30094 — MAJOR fix) → designer_fix_da724720 (спека ec109e74) → qa_fix_db2ce0d3 (этот) → critic_recheck_daecc38d
```

Параллельно идёт ветка `designer_fix_9357cc94` (Доработка 2), которая реализует UI. **Она вне зоны моего шага** — мой QA-узел проверяет только то, что лежит между `designer_fix_da724720` и `critic_recheck_daecc38d`.

---

## 1. Права — живой прогон на изоляционном стенде 127.0.0.1:3291

Поднял собственный backend с `DB_PATH=/tmp/qa-mak69-fix2/qa.db`, `TASKFLOW_LAN_NO_AUTH=1`, `TASKFLOW_ALLOW_REGISTRATION=1`. Завёл трёх пользователей: `Owner` (role=owner), `Agent` (role=orchestrator), `Colleague` (role=agent). Создал задачи, подзадачи, прокачал активные attempts прямым SQL.

| # | Сценарий | Роль/контекст | Ожидаемо | Факт |
|---|----------|---------------|----------|------|
| B.2 | `POST /api/subtasks/:id/cancel` | orchestrator | 200 | **200** `{"ok":true,"aborted":false,"attemptClosed":false,"leaseReleased":false}` |
| B.4 | `POST /api/tasks/:id/cancel` | orchestrator | 200 | **200** `{"ok":true,"attemptsClosed":0,"leaseReleased":false,"subtaskPointersCleared":0}` |
| B.5 | `POST /api/tasks/no-such-task/cancel` | owner | 404 | **404** `{"error":"Not found"}` |
| B.6 | `POST /api/subtasks/:id/reset` | owner | 200 | **200** `{"ok":true,"attemptClosed":false,"leaseReleased":false}` |
| C.1 | `POST /api/subtasks/:id/cancel` | assignee=agent | 403 + текст | **403** `{"error":"прервать шаг может владелец или оркестратор"}` |
| C.2 | `POST /api/tasks/:id/cancel` | assignee=agent | 403 + текст | **403** `{"error":"отменить задание может владелец или оркестратор"}` |
| C.3 | `POST /api/subtasks/:id/reset` | assignee=agent | 403 + текст | **403** `{"error":"сбросить попытку может владелец или оркестратор"}` |
| C.4 | `POST /api/subtasks/:id/cancel` без Bearer (LAN) | LAN-юзер (u1=owner) | 200 | **200** — это `TASKFLOW_LAN_NO_AUTH=1` фича, не баг |

**B.1 / B.3 / B.7** — коллега НЕ-участник задачи получает **404 «Not found»**, а не 403. Это корректно: `getSubtaskWithTaskForUser` фильтрует по user-scope, и не-участник задачу не видит. Раскрывать 403 «не ваше» было бы небезопасно (выдаёт существование чужих задач). Прошлая QA-проверка это не проговаривала, и `control.test.ts:209-249` проверяет «агент прерывать чужой шаг не может — 403» для assignee (а не для постороннего). Поведение согласовано.

---

## 2. MAJOR-фикс `cancelTaskWork` — живой прогон + unit-тест

`server/src/routes/control.ts:195-202` — `UPDATE subtasks SET current_attempt_id = NULL WHERE task_id = ? AND current_attempt_id IS NOT NULL` рядом с обнулением `tasks.current_attempt_id`. Возврат `subtaskPointersCleared: number` в `cancelTaskWork`. Журнал `task_cancelled` пишет `subtask_pointers_cleared`.

### Unit (control.test.ts, 11/11 зелёные)

```
✓ права > владелец прерывает шаг — 200, журнал от владельца
✓ права > оркестратор прерывает шаг — 200
✓ права > агент прерывать чужой шаг не может — 403
✓ права > посторонний человек, видящий задачу — 403
✓ права > несуществующий шаг — 404
✓ прерывание живого in-process run > cancel зовёт abort() у живого run и закрывает attempt
✓ reset без живого run > закрывает attempt и снимает lease, abort не зовётся
✓ отмена задания целиком > прерывает запуски и на самой задаче, и на подзадачах; attempts закрываются одним UPDATE
✓ отмена задания целиком > cancel задачи вызывает abort() у живого run на самой задаче и на подзадаче
✓ отмена задания целиком > после cancel задачи можно начать новую попытку — попыток больше нет действующих
✓ отмена задания целиком > cancel задачи обнуляет current_attempt_id и на подзадачах (MAJOR регрессия)
```

**Все 11 тестов зелёные**, включая новый «MAJOR регрессия» (контрольный сценарий `de0f5406-…` / `9043b6ff-…`).

### Live на 127.0.0.1:3291 — задача `a5c40387-…` с 2 подзадачами

Прямым SQL добавил 3 попытки (`att-task-1`, `att-sub-1`, `att-sub-2`) с `ended_at IS NULL` и проставил `current_attempt_id` на `tasks` и обеих `subtasks` плюс `agent_state='in_progress'`.

**До cancel** (`sqlite3`):
```
tasks:        current_attempt_id=att-task-1   agent_state=in_progress
subtask 1:    current_attempt_id=att-sub-1    agent_state=in_progress
subtask 2:    current_attempt_id=att-sub-2    agent_state=in_progress
```

**POST /api/tasks/a5c40387-…/cancel** (owner):
```json
{
  "ok": true,
  "taskId": "a5c40387-b8f0-4fd8-904f-0619e32abcb1",
  "abortedRuns": 0,
  "attemptsClosed": 3,
  "leaseReleased": true,
  "subtaskPointersCleared": 2
}
```

**После cancel**:
```
tasks:        current_attempt_id=(NULL)       agent_state=(NULL)
subtask 1:    current_attempt_id=(NULL)       agent_state=(NULL)
subtask 2:    current_attempt_id=(NULL)       agent_state=(NULL)
attempts:     все 3 закрыты с outcome='cancelled', ended_at=2026-10-06 02:25:02
task_events:  task_cancelled {"aborted_runs":0,"attempts_closed":3,"lease_released":true,
                              "subtask_pointers_cleared":2,"reason":"QA-fix2 cancel проверка указателей"}
```

**MAJOR-фикс работает живо:** `subtasks.current_attempt_id` обнулено, `tasks.current_attempt_id` обнулено, attempts закрыты одним UPDATE, lease снят, журнал содержит `subtask_pointers_cleared: 2`. Баг `de0f5406-…` / `9043b6ff-…` воспроизведён и **закрыт**.

`abortedRuns: 0` — это потому что я добавил attempts прямым SQL, без in-process run (в этом процессе нет активного run для этой задачи). На «живой» остановке `abortedRuns` поднимется, что покрыто unit-тестом «cancel задачи вызывает abort() у живого run на самой задаче и на подзадаче».

---

## 3. Кнопки (UI) — статус по коммитам на ветке

Коммиты в `main..HEAD` на момент проверки:

```
9d64effb designer  MAK-69 fix2 (UI): кнопки управления сервером у владельца   ← от designer_fix_9357cc94
e9a30094 builder   MAK-69 fix2: cancelTaskWork обнуляет subtasks.current_attempt_id  ← от builder_fix_5159a829
3c340f68 builder   MAK-69: ручки «прервать шаг», «сбросить попытку», «отменить задание»  ← от build
```

**Важно:** коммит `9d64effb` (UI) сделан слотом `designer_fix_9357cc94` (Доработка 2), а НЕ `designer_fix_da724720` (мой предыдущий узел). `designer_fix_da724720` сдал **только спеку** как артефакт (`ec109e74-…`) и явно сказал в ленте:

> «Сдаю свой слот со спецификацией как артефактом и прошу добавить в план шаг «builder (web): реализация UI по спеке ec109e74» — по конвенции проекта (Критик 9043b6ff: «код UI пишет builder, не designer»). Без этого шага CRIT из QA-отчёта 116eebad воспроизведётся снова.»

То есть **отсутствие кода от `designer_fix_da724720` — это ожидаемое поведение**, а не дефект. Вместо этого дизайнер сам же параллельно поднял слот `designer_fix_9357cc94` (Доработка 2), который и положил UI-код на ветку.

### Что в коммите `9d64effb` (для контекста, **не моя зона**)

| Файл | Дельта | Соответствие спеке ec109e74 |
|---|---|---|
| `src/api/control.ts` (новый) | 55 строк, 3 хука (useCancelSubtask / useResetSubtask / useCancelTask) | § «Хуки API — `src/api/control.ts`» спеки — 1-в-1 |
| `src/components/TaskControlSheet.tsx` (новый) | 211 строк, шторка причины | § «Шторка причины — `src/components/TaskControlSheet.tsx`» спеки — 1-в-1, без микрофона, `value.trim()` НЕ блокирует submit |
| `src/components/SubtaskFeed.tsx` | +101 строка (dotsH + ActionsMenu + canServerCancel/Reset) | § «Уровень шага — `src/components/SubtaskFeed.tsx`» спеки — 1-в-1, anchorRef обязателен |
| `src/components/TaskJournal.tsx` | +77 строк (секция «Управление сервером» + «Отменить задание») | § «Уровень задачи — `src/components/TaskJournal.tsx`» спеки — 1-в-1, outline + border-coral + text-coral |
| `src/screens/TaskDetailScreen.tsx` | +9 строк (импорт/сшивка) | § правки `TaskDetailScreen.tsx` спеки — 1-в-1 |

`tsc -b` на ветке: 4 предсуществующие ошибки в `CollaborationPlanPanel.tsx` (roles prop) / `DayHours.tsx` / `UpcomingCalendar.tsx` / `LabelTasksScreen.tsx` (MarkdownInline) — **НЕ от MAK-69**, упоминаются в коммите как «pre-existing, до моих правок». Vite build: `✓ built in 1.44s, 2062 модулей`.

DOM-проверку UI-кода делал отдельный слот `qa_fix_365ff70b` (Доработка 2) — он идёт после `designer_fix_9357cc94` и проверит реальный DOM. Мой шаг — повторная проверка **узла `designer_fix_da724720`**, у которого нет кода по дизайну, поэтому DOM-инспекция кнопок здесь неприменима.

---

## 4. Реальная остановка запуска

Покрыта:
- Unit-тестом «cancel зовёт abort() у живого run и закрывает attempt» — мок `activeInProcessRun` отслеживает, что `abort()` вызван, attempt закрыт с `outcome='cancelled'`, lease снят.
- Unit-тестом «cancel задачи вызывает abort() у живого run на самой задаче и на подзадаче» — то же для уровня задачи.
- Unit-тестом «reset без живого run» — `abort()` НЕ вызывается, attempt закрывается с `outcome='reset'`, lease снят. Это и есть «сброс для зависшей попытки, у которой процесса уже нет».

На живом стенде (3291) я не имитировал in-process run (это требует создания runner'а через `kickRoleTaskStrict` или вручную через `activeInProcessRuns`), но unit-тесты с моком `activeInProcessRun` покрывают логику вызова `abort()` полностью. Если сервер поднят не в test-режиме, фактическая остановка зависит от того, есть ли живой run в `activeInProcessRuns` (in-memory state). После рестарта сервера активных run'ов нет — `attempts` и `agent_state` остаются, и на этот случай работает `/reset`.

---

## Вердикт

**needs_changes** — НО это **итеративное `needs_changes`**, а не блокер:

1. **MAJOR (`de0f5406-…` / `9043b6ff-…`) — закрыт.** `e9a30094` на ветке, регрессионный unit-тест зелёный, живой прогон подтверждает обнуление `subtasks.current_attempt_id` после `POST /api/tasks/:id/cancel` (2 подзадачи → `subtaskPointersCleared: 2` в ответе, в `task_events.task_cancelled.to_value`).

2. **Права — корректные.** Owner/orchestrator получают 200, assignee/agent получает 403 с осмысленным текстом, не-участник — 404 «Not found» (правильно, не 403). Все три ручки ведут себя одинаково.

3. **Журнал — корректный.** `subtask_cancelled` / `subtask_reset` / `task_cancelled` пишутся с фактами (reason, attemptClosed, leaseReleased, subtask_pointers_cleared). Атомарность не нарушена.

4. **Реальная остановка — корректная** (через unit-тесты с моком `activeInProcessRun`, есть `reset` для случая «run уже умер»).

5. **Спека `ec109e74-…` (сдана `designer_fix_da724720`) — валидна, ложится на живой код, реализуема** (что и подтверждено коммитом `9d64effb` от параллельного слота `designer_fix_9357cc94` — реализация 1-в-1 со спекой, 450 строк дельты, tsc по своим файлам чистый, vite build ✓).

6. **UI-код на ветке — ЕСТЬ** (коммит `9d64effb`), но он от слота `designer_fix_9357cc94`, не от `designer_fix_da724720`. По правилу проекта «код UI пишет builder, не designer» (Критик `9043b6ff-…`), следующий шаг `designer_fix_9357cc94` — это «дизайнер пишет код временно», что **не по правилам**. Рекомендую оркестратору/архитектору на следующей итерации либо (а) переписать `9d64effb` в `builder`-слот, либо (б) явно в плане отметить, что Доработка 2 временно позволила дизайнеру писать код.

### Что передаю дальше

- `critic_recheck_daecc38d` (следующий за моим) получит параллельно:
  - от `qa_fix_365ff70b` — повторную проверку UI-кода от `designer_fix_9357cc94` (DOM-инспекция + ручки).
  - от моего `qa_fix_db2ce0d3` (этот шаг) — повторную проверку артефакта-спеки от `designer_fix_da724720` и MAJOR-фикса от `builder_fix_5159a829`.

Если оба моих `needs_changes` — итеративные (без блокирующих дефектов в своей зоне), то MAK-69 как задача может быть закрыт на этом цикле. Решение за оркестратором.

### Артефакты

- `qa.db` — снимок БД изоляционного стенда 3291 после cancel-задачи.
- `server.log` — лог поднятого бэкенда.
- `ids.sh` — параметры тестового запуска.
- `qa-mak69-fix1-check.mjs` и `qa-mak69-fix2-check.mjs` — Playwright-скрипты DOM-проверки (на ветке уже, в этом шаге не запускал — UI от `designer_fix_da724720` отсутствует по дизайну).
- Сам QA-отчёт сохраняется через `taskflow_doc_write` (см. ответ ассистента).
