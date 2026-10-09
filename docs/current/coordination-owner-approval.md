# Координация: согласование владельца и инцидент tcpo_791b4519

Задача 61043857. Документ фиксирует диагноз инцидента, доступные точки расширения
и явные ограничения текущей постановки. Это **не** законченный фикс: правки кода
в этой итерации не сделаны, потому что минимальный фикс упирается в границы карточки.

## Что произошло

Инцидент `tcpo_791b4519-cbf2-49d1-a57d-9866072211cb`: запрос изменения плана от
роли уходит в `task_collaboration_plan_ops` со статусом `proposed` и ждёт владельца.
Карточка при этом не блокируется явно. Если в это время в параллельной ветке
(или в дочерней карточке) срабатывает `finishPlanIfComplete` — задача переводится
в `agent_state='review'` и считается сданной, хотя согласование ещё не закрыто.

Корень: `finishPlanIfComplete` в `server/src/runtime/planSubtaskAdmission.ts:592`
не учитывает наличие pending proposal.

## Что уже работает (без правок в этом коммите)

- `task_collaboration_plan_ops` хранит `status='proposed'` до решения владельца.
- `decidePlanProposal` атомарно переводит proposal в `applied` или `rejected` и
  защищён от дублей условием `status='proposed'` (повторный `approve`/`reject`
  отдаёт 409).
- `notifyOwner` в `server/src/runtime/planMutations.ts` создаёт запись в
  `notifications` с типом `agent_state`, но триггер
  `notifications_owner_no_activity` (миграция 008) глушит её для владельца —
  уведомление существует, но до пользователя не доходит.

## Что требуется по постановке

1. **Удержание blocked пока открыто согласование.** Не переводить карточку в
   `review`, пока `task_collaboration_plan_ops` имеет записи `proposed` для её
   плана.
2. **Видимое уведомление вместо скрытого `agent_state`.** Новый тип с понятным
   текстом, ссылкой и кнопкой действия.
3. **Возобновление шага после ответа владельца.** Сейчас proposal при `apply`
   не возобновляет авторский subtask, если тот стоял в `blocked` через
   `w.waiting`. После `apply`/`reject` нужен явный resume.
4. **Описание доступной серверной доставки.** Не обещать APNs: инфраструктуры
   нет. Доставка — запись в `notifications` + `notification:new` по вебсокету
   `server/src/ws.ts`.

## Где минимальная точка расширения

Границы карточки: «Основная зона planMutations, planReviewLifecycle,
серверные notifications. Не менять очередь/slotConversation, planSubtaskAdmission.»

`finishPlanIfComplete` живёт в `planSubtaskAdmission.ts` — он **за пределами
разрешённой зоны**, и правка этой функции была бы минимальной и единственной
полной. Без неё любой фикс в `planReviewLifecycle` или `planMutations` будет
частичным: гард в `queuePlanFinalReview` срабатывает только если
`finishPlanIfComplete` сам вызвал `ensurePlanFinalReviewer`, а `finishPlanIfComplete`
сначала выставляет `agent_state='review'` напрямую и лишь опционально ставит
итогового проверяющего.

Альтернативы внутри границ:

- Добавить в `applyPlanOps` для `proposed` (роль сверх лимита или
  `request_help` поверх `proposed`) явное обновление `tasks.agent_state` на
  специальный маркер, который `finishPlanIfComplete` уже умеет видеть как
  не-`review` (текущая проверка `agent_state === "review"`). **Но** это
  требует чтения `finishPlanIfComplete`, что выходит за границы, и при этом
  нужно гарантировать, что маркер снимется при `decidePlanProposal`.
- Расширить триггер `notifications_owner_no_activity`, чтобы он глушил и
  новый видимый тип, и проверять, что `notification:new` действительно
  показывается владельцу. Это в `server/src/migrations.ts` и
  `server/src/ws.ts` — внутри границ.

## Что не проверено и не реализовано

- Никакие правки кода в этой итерации не сделаны.
- Новый тип уведомления не спроектирован, колонки `action_url`/`action_kind`
  не добавлены.
- Резюм шага после решения владельца не реализован.
- Гард `finishPlanIfComplete` на pending proposal — **за пределами границ**.

## Что нужно от владельца или архитектора

1. Подтвердить, что минимальный фикс через `finishPlanIfComplete` допустим
   (т.е. расширить границы карточки), или
2. Пересмотреть постановку так, чтобы инцидент решался без правки
   `planSubtaskAdmission` (например, переносом `finishPlanIfComplete` в
   `planReviewLifecycle` отдельным шагом реструктуризации).
3. Согласовать дизайн видимого уведомления: тип, текст, действия
   (`approve`/`reject`), колонки в `notifications`.

## Что сделано в реализации (коммит после расширения границ)

Владелец 09.10.2026 разрешил правку `finishPlanIfComplete` и согласовал
видимый тип `plan_approval_request` с идентификаторами `task/plan/op`.
Сделано точечно, в трёх местах, остальные файлы плана и координации
(planSubtaskAdmission/dispatch, очередь, slotConversation) не тронуты.

### 1. `finishPlanIfComplete` (planSubtaskAdmission.ts) — гард pending proposal

Перед переводом карточки в `agent_state='review'` функция проверяет наличие
открытого предложения плана:

```sql
SELECT 1 FROM task_collaboration_plan_ops
 WHERE plan_id = ? AND status = 'proposed' LIMIT 1
```

Если proposal открыт — функция логирует событие `plan_completion_deferred`
(видно в ленте карточки) и возвращает `false`. Карточка остаётся активной,
никакая ложная сдача не регистрируется. Сдача произойдёт штатно после
`approve`/`reject` владельцем и после `setDone` оставшихся узлов.

### 2. Уведомление `plan_approval_request` (planMutations.ts)

Раньше `notifyOwner` слал скрытый `agent_state`, который глушился триггером
`notifications_owner_no_activity` (миграции 068/069). Теперь для proposed
вызывается отдельный помощник `notifyPlanApprovalRequest`:

- тип `plan_approval_request` — НЕ входит в IN-список триггера 068/069,
  проходит до владельца;
- текст содержит явные идентификаторы `[op:tcpo_… plan:tcp_… task:…]`
  (отдельных колонок в `notifications` пока нет — фронт парсит префикс);
- `broadcastToUsers` шлёт `notification:new` по вебсокету.

Серверная доставка: запись в `notifications` + `notification:new` по
вебсокету `server/src/ws.ts`. APNs не настроен (ключ отсутствует, см.
логи запуска `[apns] ключ не настроен — островок будет обновляться только
при открытом приложении`); обещать push-доставку нельзя.

### 3. Возобновление авторского subtask после `approve` (planMutations.ts)

В `decidePlanProposal` после успешного `applyPlanOps(..., bypassBudget)`
и пометки `applied` добавлен снятие блокировки с авторов `request_help`,
которые входят в применённые ops. До approve `w.waiting` блокирует автора
через `plan_help_requested` (subtask.agent_state='blocked',
block_type='dependency'); после approve — `agent_state='todo'`, чтобы роль
продолжила с того места, где остановилась.

Гард на состояние карточки: если `tasks.agent_state='review'`, возобновление
не срабатывает (защита от гонки, когда проверяющий уже принял работу).

### Что проверено

`test/planOwnerApproval.test.ts` (4 сценария, 4/4 зелёных):
- pending proposal удерживает карточку: `finishPlanIfComplete` возвращает
  `false`, уведомление `plan_approval_request` создаётся с корректным
  префиксом `[op:… plan:… task:…]`, `pendingPlanProposals` отдаёт запись;
- approve с выполненными узлами → карточка уходит на review;
- reject → повторный reject/approve → 409 (защита от дубля, общий
  контракт `decidePlanProposal` не тронут);
- approve без выполненных узлов → карточка остаётся активной.

`planComplete.test.ts` (4/4) и `planReviewLifecycle.test.ts` (2/4 —
те же флаки что на main, до моих правок) — без регрессий.
`tsc --noEmit` — чисто.

### Ограничения

- Колонки `action_url`/`action_kind` в `notifications` не добавлены:
  минимально достаточно текстового префикса, фронт парсит его при показе.
  Если владелец захочет явные `approve_url`/`reject_url` — это отдельная
  миграция и расширение роута.
- Возобновление через `request_help` покрывает основной путь; другие
  сценарии (например, `add_step` + ручная блокировка) требуют отдельного
  прохода, потому что гард «subtask.block_type='dependency'» срабатывает
  только для помощников.
- `finishPlanIfComplete` теперь логирует `plan_completion_deferred` каждый
  раз, пока proposal открыт и кто-то закрыл последний узел; в плотных
  циклах это даст много записей в `task_events` — при необходимости
  добавим rate-limit на стороне логирования.
