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
