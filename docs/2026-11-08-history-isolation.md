# Изоляция личного контекста: карточки не попадают в историю модели

Дата: 08.11.2026. Спецификация `docs/2026-11-08-role-slot-chat-branches-spec.md`
§5 «Изоляция личного контекста», критерий приёмки 5.

## Что было

Обе выборки истории для модели (`deliverAgentReply` — первый ход сессии и
продолжение) отбирали строки по одному условию: `is_session_marker = 0`.

Карточки обращения (`runtime/chatCoordination.ts`) пишутся в
`chat_messages` с `message_type='system'` и `steps.coordination`, а
`is_session_marker` у них ноль. Значит в промпт личной комнаты роли попадала
строка вида «Разработчик → Критик: вопрос в очереди» — переговоры другой
сессии. То же с чипом памяти (`runtime/memoryObserverChatChip.ts`, «Память
обновлена · …», `steps.memory_update`) и с уведомлениями вроде «@builder срок
истёк: ответа нет». Выжимка (`runtime/chatCheckpoint.ts`) такие строки уже отбрасывала по
`message_type='system'`, а историей — нет: расхождение и было течью.

## Что стало

`server/src/lib/chatHistoryModel.ts` — одна точка для истории модели:

- `HISTORY_SELECT` переехал сюда из `routes/chats.ts`;
- `modelHistorySql(alias)` — условие «это строка для модели»: `is_session_marker = 0`
  **и** `message_type != 'system'` **и** `steps.coordination` не объект (страховка
  на случай карточки, записанной без служебного типа);
- `historyBefore(chatId, triggerId, limit)` и
  `historySince(chatId, triggerId, selfId, limit)` — обе выборки через это условие.

`routes/chats.ts` больше не держит свою копию SQL: оба места зовут хелперы.
Правило теперь одно на историю и на выжимку: **отображаемая карточка — не
вход модели**.

## Проверки

`server/test/chatHistoryIsolation.test.ts` (3 проверки):

1. карточка обращения, метка сессии, чип памяти и уведомление «срок истёк» не
   попадают в выборку первого хода;
2. то же — в продолжении сессии;
3. условие `modelHistorySql` само по себе отбирает ровно обычные сообщения.

RED снят честно, дважды: вернул в `modelHistorySql` самое первое условие (только
`is_session_marker = 0`) — 2 проверки из 3 упали; вернул условие без
`message_type != 'system'` — снова 2 из 3 упали (карточки вернулись). После
каждого отката фильтр восстановлен, 3/3 зелёные.

Соседние: `chatCoordination` 12/12, `chatCoordinationSubagent` 5/5,
`chatComposition` 5/5, `chatCheckpoint` 12/12, `chatHandoff` 2/2,
`chatContextBreakdown` 2/2, `memoryObserverChatChip` 4/4, `chatLiveTurn` 27/27,
`tsc --noEmit` чисто.

Живая база подтверждает размер течи: `chat_messages` — 2205 обычных, 268
`system`, 4 `task_proposal`; среди служебных «@builder срок истёк: ответа
нет…» (44), цитаты заголовков задач (26/21/21), «Оркестратор → Разработчик:
Ответ получен» (6) — ни одна не является содержанием разговора.

## Что осталось по §5

Выжимки (`chat_checkpoints`) служебные строки не берут и раньше — проверено
чтением `runtime/chatCheckpoint.ts:350`. Осталось перечитать кэш контекста
(`runtime/chatContextUsage` — считает токены, не вход) и память
(`chatMemoryCursor` — курсор, не вход). Карточки назначений уже вне переписки
(`docs/2026-11-08-chat-child-sessions.md`), карточки обращения, чип памяти и
уведомления теперь вне истории модели.
