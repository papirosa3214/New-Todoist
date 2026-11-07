---
name: live-routines-check
description: Живая проверка рутин (крон-задач) TaskFlow на копии: тик рутин гоняется драйвером, опоздание и «занятый слот» воспроизводятся правкой next_run_at в копии БД, веб-экран «Мои рутины» проверяется браузером и typescript-проверкой tsconfig.app.json. Применяй при приёмке рутин, планировщика и любых изменений в server/src/runtime/schedules и src/screens/RoutinesScreen.tsx. Не применять для чисто серверных критериев без живого прогона.
---

# Живая проверка рутин TaskFlow

Каноническая папка навыка роли: `/home/maksim/taskflow/roles/qa/skills/live-routines-check/SKILL.md`
(23.10.2026 записать туда не удалось — нет прав на запись; копия лежит здесь).

## 1. Стенд

```bash
Q=/home/maksim/Проекты/New-Todoist/scripts/qa
cd <рабочий каталог шага>
QA_SOURCE_DB=/home/maksim/Проекты/New-Todoist/server/taskflow.db $Q/up.sh "$PWD"
```

- `QA_SOURCE_DB` обязателен: HOME роли = `/home/tfrole`, дефолтный путь к живой базе не открывается.
- Копия отдаёт API и веб на свободных портах (печатает WEB=/API=/STATE=).
- Гасить: `$Q/down.sh <тот же каталог>` — всегда, даже если сценарий упал.

## 2. Тик рутин живьём

Планировщик на копии выключен (`TASKFLOW_QA_SANDBOX=1`), тик гоняется драйвером:

```bash
cd <рабочий каталог шага>/server
DB_PATH=<файл копии БД> ./node_modules/.bin/tsx драйвер.mjs 2026-10-23T02:21:30.000Z [scheduleId]
```

Драйвер: `buildApp()` без `listen` + `runSchedulesTick(app, { now })` — `now` задаёт опоздание.
Печатает `TICK_COUNTS {created, skipped, failed}`.

Ручки рутин на копии зовут с User-Agent браузера (иначе 401 «нужен ключ»):
`curl -H "User-Agent: Mozilla/5.0 …" http://127.0.0.1:4100/api/schedules`.

## 3. Воспроизведение инвариантов

- **Опоздание (порог догона):** в копии БД `UPDATE task_schedules SET next_run_at=<прошлое время>` и тик с `now` = прошлое + N минут. Догон выключен (`catch_up=0`) — при опоздании меньше интервала планировщика с запасом запуск должен состояться.
- **Занятый слот (D1/D5):** `next_run_at` в прошлое + `INSERT INTO schedule_runs (schedule_id, run_at, status='created', task_id=NULL, created_at=datetime('now','-20 minutes'))`. Ожидание: слот помечен прерванным, `next_run_at` ушёл в будущее, карточка не создана.
- **Наложение (D4):** `POST /api/schedules/:id/run-now`, пока прошлый экземпляр не закрыт → пропуск, новой карточки нет.

## 4. Веб-экран «Мои рутины»

- Браузер: `node $Q/browser.mjs сценарий.json --base http://127.0.0.1:4101 --out КАТАЛОГ`,
  обязательно `PLAYWRIGHT_BROWSERS_PATH=/home/maksim/.cache/ms-playwright` (иначе нет браузера).
- Типы веба: `npx tsc --noEmit -p tsconfig.app.json`. **`tsc -p tsconfig.json` не проверяет ничего** (files: [], только references) — так пропускают блокеры вроде несуществующей переменной в экране.
- Ошибка в консоли (`console.error`, `ReferenceError`) и заглушка «Что-то пошло не так» — дефект, даже если «tsc сервера чисто» и веб-тесты зелёные.

## 5. Грабли

- Роль, поднятая рутиной, на копии ходит в настоящую модель и создаёт свою рабочую копию; уборка может снести каталог.
- Если рабочий каталог шага пропал: `git worktree prune` в репозитории, `git branch -f <role-ветка> <main>`, `git worktree add <путь> <role-ветка>`, заново создать симлинки `node_modules` и `server/node_modules` на `~/Проекты/New-Todoist/...`. Пустой коммит в ветке role защищает каталог от уборки слитых веток.
