# Контракт: сторож зависших шагов сообщает оркестратору

Архитектор, слот `locate`. Код не менялся. Проверено по рабочей ветке
`roles/2beb2bf2-0939-4195-a43e-726e16a0a13c` (main `32b2ee83`) и по живой БД
сервера `.110` 16.10.2026. Та же заметка в базе знаний: `fc0ea9a6`.

## 1. Где сторож ловит зависший слот и делает авторестарт

Файл `server/src/runtime/stalledStepWatcher.ts` (316 строк), тик раз в минуту
(`startStalledStepWatch`, первый обход через 70 с, `STALLED_STEP_WATCH_INTERVAL_MS`).

| Что | Где | Суть |
|---|---|---|
| Выборка узлов | `loadStalledSteps()` `:63` | плановые шаги `agent_state='in_progress' AND done=0`, карточка не архивна |
| Признак «завис» | `lastSessionEventMs()` `:117` | mtime свежего `.jsonl` в `~/.local/state/taskflow-runs/sessions/<task>-<role>-<subtaskId>/`; каталога нет — падает на `agent_heartbeat_at` |
| Порог | `:31` | `stall_after_min` (настройка `serverSettings`, по умолчанию 10) |
| Счётчик перезапусков | `restartCount()` `:76` | попытки с `outcome='auto_restarted'` за 2 часа; потолок `max_restarts_per_window` (2) |
| Авторестарт | `restartAttempt()` `:216` → `markRestartedAndEnqueue()` `:171` | закрывает попытку `auto_restarted`, чистит слот, `enqueueRoleRunJob(dedupe_key=stalled-restart:<id>:<uuid>)`, заметка в ленту, затем `startPlanSubtaskRun()` |
| Автоблок | `blockAsStalled()` `:194` | попытка `stalled_blocked`, `agent_state='blocked'`, техснимок, заметка в ленту, `logStepAbandoned`, `postOwnerNotification()` `:112` владельцу |
| Вход в обход | `runStalledStepWatch()` `:262` | `await Promise.all(restarts_in_flight)` `:288` |

**Сегодня оркестратору не уходит ничего.** Адресаты сторожа — лента карточки
(`postRoleNote` от имени роли) и, только при автоблоке, уведомление владельцу
(`notifications`, тип `stalled_blocked`). Живая БД: 61 авторестарт
(`stalled_step_auto_restart`), 3 автоблока, 0 сообщений оркестратору.

## 2. Куда писать: готовый канал ролей — `orchestratorWake.ts`

`server/src/runtime/orchestratorWake.ts` — единственный существующий путь,
который **кладёт сообщение в рабочий чат И будит оркестратора как ход**:

- личный чат `orchestrator-wake:role_code_orchestrator`, название «Заминки команды»,
  участники — автор карточки и `role_code_orchestrator` (`:36-38`);
- строка в `chat_messages` (`:52`), затем `enqueueMessageDelivery` (`:54`) →
  `deliverWake` → `recoverAgentDelivery` (`routes/chats.ts:1215`) поднимает запуск роли;
- готовый текст-шаблон с инструкцией оркестратору (`:43-52`);
- канал живой: 2 пробуждения 14.10.2026, покрыт `server/test/orchestratedPlan.test.ts:83-98`.

**Блокер, из-за которого «просто вызвать `wakeAndDeliver`» не пройдёт приёмку.**
Фильтр в `:32`: `WHERE ... p.profile = 'orchestrated' AND p.status='approved'`.
В живой БД 246 планов, `orchestrated` — **2**. Профиль плана этой карточки —
`bug_regression` (проверено запросом к живой БД). То есть на этой карточке
`wakeOrchestrator` вернёт `null` и сообщения не будет.

**Решение:** расширять фильтр у `wakeOrchestrator` нельзя — тогда оркестратора
начнёт будить каждый блок и каждый повтор во всех 244 остальных планах.
Отдельная функция в том же модуле: тот же чат, та же доставка, тот же шаблон,
но без профильного фильтра и только для событий сторожа.

```ts
// server/src/runtime/orchestratorWake.ts
export type StalledWakeKind = "stalled_restarted" | "stalled_restart_failed" | "stalled_blocked";
export function wakeOrchestratorStalled(subtaskId: string, kind: StalledWakeKind, attemptKey: string, detail: string): Wake | null;
export function wakeAndDeliverStalled(subtaskId: string, kind: StalledWakeKind, attemptKey: string, detail: string): void;
```

Требования к функции:

- выборка узла как в `:32`, но без `profile='orchestrated'`; исключения
  `ORCHESTRATE_SLOT` / `ORCHESTRATE_ASSEMBLE_SLOT` сохранить (как в `:34`);
- оркестратор — `roleUserId("code_orchestrator")` = `role_code_orchestrator`
  (не «Оркестратор Claude» из `users.role='orchestrator'`, это другая учётка —
  её использует `blockSignals.ts:32`, она рабочих инструментов не имеет);
- `messageId = \`orch-${kind}:${attemptKey}\`` — детерминированный (см. §4);
- исключение не должно ронять сторож: обёртка как `wakeAndDeliver` `:69`.

### 2.1. Участники чата, если автор карточки — не человек

- Чат и участника-оркестратора (`role_code_orchestrator`) создавать **безусловно** — иначе сообщение теряется.
- Автора карточки добавлять вторым участником только если `creator_id` не NULL и не равен `role_code_orchestrator`. Автор-роль безвредна: дубль гасит первичный ключ `chat_members`.
- **Не вставлять** `creator_id` в `chat_members`, если он пуст: `member_id` NOT NULL, вставка идёт внутри транзакции — исключение убьёт всю отправку, а `wakeAndDeliver` её проглотит.
- `created_by` чата брать `orch.id`, а не автора: чат создаётся один раз (`INSERT OR IGNORE` по id `orchestrator-wake:<orchId>`), и `created_by` зафиксируется автором первой карточки навсегда.
- Доставка адресована по `roleId` (`enqueueMessageDelivery` → `recoverAgentDelivery`), а не по участникам чата. Чат с одним оркестратором работает и владельца не касается — это и требуется критерием «не владельцу».

## 3. Три точки вызова

| Событие | Где в `stalledStepWatcher.ts` | Вид | Что писать в detail |
|---|---|---|---|
| Авторестарт удался | `restartAttempt()` `:216`, после резолва `startPlanSubtaskRun` | `stalled_restarted` | `поток событий молчал N мин (порог {STALL_AFTER_MIN}); сторож закрыл попытку и запустил новую (перезапуск k из MAX)` |
| Авторестарт не удался | там же, ветка `!started.ok` | `stalled_restart_failed` | предыдущая строка + `запуск не удался: ${started.error}` |
| Автоблок | `blockAsStalled()` `:194`, в конце | `stalled_blocked` | `перезапуски исчерпаны (MAX/MAX), шаг переведён в blocked` + текст снимка (обрезать до 600) |

Заголовок — как в `HEADLINE` (`:11`): «завис, поток молчит», «перезапущен
сервером», «запуск не удался», «встал в блок». В тексте обязательны: название
карточки, `task_id`, название шага, `slot_key`, `subtask_id`, роль
(`roleTitle(role_key)`), факт зависания, факт действия, `attemptKey`.
Хвост-инструкцию оркестратору из `:47-51` не переписывать.

## 4. Защита от повторов — два замка, без миграции и без новой таблицы

**Замок 1 — личность события = закрытая попытка.**
`endAttemptAsAutoRestarted` (`:169`) и UPDATE попытки в `blockAsStalled` (`:189`)
уже идемпотентны: `WHERE ended_at IS NULL`. Вернуть из них `.changes` и слать
уведомление только при `changes === 1`. Следующий тик узел уже не увидит
(состояние сменилось), повторный вызов не закроет уже закрытую попытку.

**Замок 2 — личность сообщения = детерминированный id.**
`chat_messages.id` — TEXT PRIMARY KEY (миграция с созданием таблицы),
поэтому `INSERT OR IGNORE` даёт ровно одно сообщение даже при гонке двух
процессов; `enqueueMessageDelivery` при повторе возвращает `created:false`
(`chatQueue.ts:128-145`) и вторая доставка не создаётся.

Ключ: `<attempt_id>` для всех трёх видов (у попытки один id на всё событие).
Если `current_attempt_id` пуст (у планового `in_progress` узла не бывает, но
подстраховаться надо) — ключ `cycle:<admission_cycle>`.

Смысл: один зависший шаг → одно сообщение; новый перезапуск после новой
попытки — новое сообщение (это новое событие, а не дубль). Агрегацию
«не чаще раза в час» не делать: в БД 0–22 авторестарта в сутки, шум мал.

## 5. Чего не трогать

- Логику авторестарта: пороги, `enqueueRoleRunJob`, `startPlanSubtaskRun`, `dedupe_key`.
- `postOwnerNotification` (`:112`) — уведомление владельцу остаётся. Критерий
  «не владельцу» относится к новому сообщению оркестратору, не к этому сигналу.
- `postRoleNote` в ленту карточки — это заметка о работе шага, дублировать её
  в чат оркестратору не надо.
- Тему задачи (`stepTopicProgress` + миграция 151 из карточки 7efcc173,
  заметка `73bf5e8d`) — контракт там прямо исключает авторестарт сторожа, а
  тема не будит никого. Свой модуль не заводим, используем `orchestratorWake`.
- `routes/subtasks.ts:1059` и `planMutations.ts:409` — блок роли и rework
  уже будили бы оркестратора, но фильтр профиля их тоже глушит. Вне объёма
  этой карточки (граница «только события сторожа»).

## 6. Найденный риск: авторестарт не снимает повисший держатель слота

`runRoleInProcess` сначала ждёт `acquireSlotSession` (`inProcessRun.ts:1205`).
Если прежний запуск умер и не отпустил слот (`hung_holder`), новый запуск
висит вечно, а тик сторожа ждёт `startPlanSubtaskRun` (`:216`) и из-за
замки `busy` (`:305`) **перестаёт проверять все узлы вообще** — до рестарта
сервера. Ручной путь это лечит: `routes/control.ts:323` зовёт
`forceReleaseSlotSession`, когда живого запуска нет. Автопуть — нет.

Это отдельный дефект и отдельная карточка («сторож освобождает повисший слот
перед авторестартом»); в объём текущей не входит. Но из-за него сообщение
обязано быть правдивым: писать «попытка перезапущена сервером» только когда
`started.ok === true`, иначе `stalled_restart_failed` с текстом ошибки.

## 7. Тесты

`server/test/stalledStepWatcher.test.ts` (фикстура плана уже есть).

1. Авторестарт → 1 строка в `chat_messages` чата «Заминки команды», 1 строка
   `chat_message_queue` со статусом `pending`, `role_id = role_code_orchestrator`.
2. **Профиль плана `manual`/`bug_regression` (не `orchestrated`)** — сообщение
   всё равно уходит. Это и есть суть правки; без этой проверки тест зелёный и
   бесполезный.
3. Два тика подряд (журнал снова молчит, попытка не создалась) → по-прежнему
   ровно одно сообщение на ту же попытку.
4. Автоблок → `stalled_blocked`, в тексте есть причина и текст снимка.
5. Упавший старт (`startPlanSubtaskRun` не ok) → `stalled_restart_failed`, в
   тексте ошибка.
6. Ни одной строки в общем чате `chat-common`; уведомление владельцу
   `stalled_blocked` — по-прежнему ровно одно (существующая проверка не ломается).
7. `app.close()` + `buildApp()` + повторный тик → новых сообщений нет.

Прогон: `cd server && DB_PATH=/tmp/stalled.db npx vitest run test/stalledStepWatcher.test.ts test/orchestratedPlan.test.ts`.

## 8. Границы

Только сервер (`server/src/runtime`). Клиент не трогаем: сообщение в личный
чат роли с доставкой в очередь сервер уже показывает. Ответственный за
интеграцию — по полю карточки, перенос после положительной проверки.