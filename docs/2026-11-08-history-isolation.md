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
сессии. Выжимка (`runtime/chatCheckpoint.ts`) такие строки уже отбрасывала по
`message_type='system'`, а историей — нет: расхождение и было течью.

## Что стало

`server/src/lib/chatHistoryModel.ts` — одна точка для истории модели:

- `HISTORY_SELECT` переехал сюда из `routes/chats.ts`;
- `modelHistorySql(alias)` — условие «это строка для модели»: `is_session_marker = 0`
  **и** `steps.coordination` не объект;
- `historyBefore(chatId, triggerId, limit)` и
  `historySince(chatId, triggerId, selfId, limit)` — обе выборки через это условие.

`routes/chats.ts` больше не держит свою копию SQL: оба места зовут хелперы.
Правило теперь одно на историю и на выжимку: **отображаемая карточка — не
вход модели**.

## Проверки

`server/test/chatHistoryIsolation.test.ts` (3 проверки):

1. карточка обращения и метка сессии не попадают в выборку первого хода;
2. карточка не попадает и в продолжение сессии;
3. условие `modelHistorySql` само по себе отбирает ровно обычные сообщения.

RED снят честно: вернул в `modelHistorySql` прежнее условие (только
`is_session_marker = 0`) — 2 проверки из 3 упали (карточка вернулась в историю);
вернул фильтр — 3/3 зелёные.

Соседние: `chatCoordination` 12/12, `chatCoordinationSubagent` 5/5,
`chatComposition` 5/5, `chatCheckpoint` 12/12, `tsc --noEmit` чисто.

## Что осталось по §5

Проверить другие пути входных данных дочерних сессий: кэш контекста
(`runtime/chatContextUsage`), выжимки (`chat_checkpoints`), память
(`chatMemoryCursor`), подсказки подсказок (hint) и системные сообщения в личной
комнате. Карточки назначений уже вне переписки
(`docs/2026-11-08-chat-child-sessions.md`), карточки обращения теперь вне
истории модели.
