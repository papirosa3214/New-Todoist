# Серверный конвейер чатового чек-листа — реализация (25.10.2026)

Шаг `server` карточки b504958a-4550-4ef3-ac0c-5bc285abcab0.
Контракт: note://115ba2ac-6a1d-45ac-a92f-2081c6ecf0c2 (шаг `contract`).
Ветка: `roles/b504958a-4550-4ef3-ac0c-5bc285abcab0`.

## Что изменилось в поведении

До этой правки чек-лист роли в чате был подсказкой модели: пункты закрывались
переписыванием списка со `state: "done"`, текущим становился тот пункт, который
роль назвала `in_progress`, остановить план было нечем, а поздний ответ старого
хода мог продвинуть работу.

Теперь:

1. **Состояние считает сервер.** `chatPlanViewOf` — единственное место, где
   вычисляются `status`, `current_item_id` и состояние каждого пункта
   (`pending | in_progress | done | blocked | stopped`). Клиент и промпт роли
   читают одно и то же представление и ничего не вычисляют сами.
2. **Явная сдача.** `POST /api/chats/:id/work-plan/submit` и инструмент чатового
   хода `taskflow_work_item_submit`. Принимается только текущий пункт; прямой
   переход через несданный отвергается `item_not_current`; повтор той же сдачи
   идемпотентен по ключу, который выводит сервер из (ход доставки, пункт, итог).
3. **Пункт закрывает только сдача.** Запись плана со `state: "done"` без
   принятой сдачи отклоняется `item_not_submitted`; текущий пункт нельзя
   удалить (`current_item_locked`), начатый нельзя переименовать (`item_locked`).
4. **Стоп плана.** `POST /api/chats/:id/work-plan/stop`: `status='stopped'`,
   причина, текущий пункт → `stopped`, живые ходы роли в этом чате отменяются.
   Остановленный план сдачи не принимает (`plan_stopped`); продолжить можно
   только новым планом — он ложится без сверки версии и с чистыми записями.
5. **Бюджеты явные.** Исчерпан срок ожидания очереди → текущий пункт
   `blocked` с причиной; исчерпан общий бюджет повторов доставки → план
   `stopped`, `stop_reason='budget_exhausted'`. Тихого повтора нет.
6. **Поздний ответ не двигает пункт.** Сдача из хода, чья доставка закрыта или
   чьё поколение пары меньше текущего, записывается как `stale` и возвращает
   `run_stale`; состояние пункта не меняется.
7. **Сообщение и доставка различаются.** В формате сообщения клиента появилось
   `queue_delivery_state` (`saved | queued | accepted | stale`) — по строке
   `chat_message_queue`. Имя не `delivery_state`: так уже называется колонка
   `chat_messages` про доставку адресного сообщения человеку (миграция 130).

## Схема

Миграция `176_chat_work_plan_outcomes` — только `ALTER TABLE ADD COLUMN` в
`chat_work_plans`: `status`, `stop_reason`, `stopped_at`, `source_message_id`,
`outcomes_json`. `items_json` остаётся тем, что пишет роль (порядок и названия);
состояния в нём — подсказка, истина в `outcomes_json`.

## Файлы

- `server/src/lib/subtaskWorkPlan.ts` — представление, сдача, стоп, правила
  записи плана, промпт хода (чистые функции отделены от БД).
- `server/src/routes/chats.ts` — представление в GET, правила PUT, маршруты
  `submit` и `stop`, `source_message_id` из живой доставки.
- `server/src/runtime/inProcessRun.ts` — инструмент `taskflow_work_item_submit`.
- `server/src/runtime/PiRuntimeAdapter.ts` — промпт по представлению (без правок
  кода: `chatWorkPlanPrompt` сменил содержимое, вызов тот же).
- `server/src/runtime/chatSession.ts`, `server/src/runtime/chatDeliveryRetryBudget.ts`
  — явное исчерпание пределов.
- `server/src/lib/chatMessages.ts` — `queue_delivery_state`.
- `server/src/migrations.ts` — 176.

## Проверки

- `npx vitest run test/chatWorkPlanConveyor.test.ts test/chatWorkItemSubmit.test.ts test/chatWorkPlanStop.test.ts test/chatWorkPlanPrompt.test.ts test/chatRooms.test.ts test/chatQueue.test.ts test/chatQueueRecovery.test.ts test/chatQueueResilience.test.ts test/chatSteering.test.ts test/subtaskWorkPlan.test.ts test/workPlanSubmission.test.ts test/chats.test.ts test/chatLiveTurn.test.ts` — 159/159.
- `npx tsc --noEmit -p tsconfig.json` — чисто.
- RED: те же три новых файла и тест промпта на коде до правки — 23/23 падают.
- Ветка `test/chat-session-runtime.test.ts` и `test/chats-online.test.ts` красные
  и до правки (16 падений на старом коде): это окружение SDK, к конвейеру
  отношения не имеет.

## Ограничения

- Ветка карточки 252c400e (`applyOwnerBoundary`, `chatCheckpoint`,
  `fencePairDeliveries`) в main ещё не влита — конвейер опирается на уже
  имеющиеся в ветке `chat_session_generation`, `bumpChatGeneration`,
  `cancelChatRunsFor`, `chatSteering` и `chatQueueRecovery`. Второй набор тех же
  механизмов не заводился; после вливания 252c400e проверка поколения остаётся
  верной, потому что счётчик поколения один.
- Содержательную правильность сданного пункта конвейер не проверяет.
- Веб и iOS не трогались; числовые пределы не вводились сверх существующих.
