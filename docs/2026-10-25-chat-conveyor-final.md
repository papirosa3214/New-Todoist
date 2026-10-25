# Чек-лист роли в чате: интеграция и проверка

25.10.2026. Прямое поручение владельца завершить b504958a без карточки. Подхвачена ветка `08dc72da` поверх main `5d991afc`; сохранены сегодняшние native tools Pi (`70288c36`, `c5b98313`). Исходный worktree роли оставлен нетронутым.

## Исправлено при интеграции

- `taskflow_work_item_submit` в ядре нативных инструментов; чатовый `taskflow_work_plan` не навязывает 3–7 пунктов и не советует ручной done.
- Доставка считается по исходному сообщению человека, а не по ответу роли.
- Обычный `/chats/:id/stop`, используемый iOS, останавливает план до отмены, повышает поколение и отсекает pending/picked. Старые сдачи и запоздалая запись плана нативным инструментом не снимают стоп.
- Перестановка/вставка пункта перед текущим отклоняется: следующий допускается после сдачи.
- Явно перенесённая выжимка требует свежей сессии даже при совпавшем поколении.
- Потолок времени/тишины останавливает чек-лист с `budget_exhausted`. Новый необязательный `TASKFLOW_CHAT_MAX_ACTIONS` ограничивает фактические вызовы инструментов до побочного эффекта; операции управления планом/сдачи/сообщения остаются доступны. Без положительного согласованного значения новый предел не включён. Настройки времени и повторов сохранены.

## Проверки

87 теста в 15 файлах успешно; `npm run build` (tsc) успешно. Группа: chatActionBudget, chatDeliveryState, chatWorkItemSubmit, chatWorkPlanConveyor, chatWorkPlanClarification, chatWorkPlanStop, chatWorkPlanPrompt, chatOwnerBoundary, chatInterruptFlow, chatCheckpoint, pi0844ChatContract, nativeToolLoading, nativeToolSchemas, nativeToolPayload, roleToolCatalog. Скриптованные сессии Pi/локальный mock, тестовые БД, без настоящих моделей.

RED/GREEN: доставка 3 ошибочных assertion; отсутствие сдачи в ядре; стоп iOS оставлял active; выжимка возвращала continue; перестановка и вставка обходили сдачу (2 assertion); поздняя запись снимала стоп; устаревшая инструкция требовала 3–7; таймаут оставлял вечный current. Каждый проверен на коде до исправления, затем целевой набор прошёл. Новый бюджет: RED отсутствующий модуль, GREEN 4 теста доэффектного ограничения и конфигурации.

Артефакты прогона: `/tmp/chat-conveyor-{red,stop-red,checkpoint-red,order-red,write-red,description-red,time-red,budget-red}.log`; итог `/tmp/chat-conveyor-final-tests.log`. Логи также включены ниже сокращёнными результатами, чтобы результат не зависел от очистки /tmp.

| Проверка | До | После |
|---|---|---|
| Доставка + ядро | 4 failed, 7 passed | входят в 87 passed |
| Обычный стоп iOS | 1 failed, 5 passed | входит в 87 passed |
| Перенос выжимки | 1 failed, 9 passed | 10 passed |
| Перестановка/вставка | 2 failed, 6 passed | 8 passed |
| Поздняя запись плана | 1 failed, 8 passed | 9 passed |
| Потолок времени | 1 failed, 1 passed | 2 passed |
| Итоговая группа | — | 15 files / 87 passed, TEST_EXIT=0, BUILD_EXIT=0 |

## Регрессии вне группы

Расширенный `chat-session-runtime.test.ts` даёт 9 падений и на исходном main `5d991afc` (временный неизменяемый снимок исходников `/tmp/taskflow-conveyor-baseline`, лог `/tmp/chat-conveyor-baseline.log`): устаревшие ожидания steering вместо остановки, discussion, plan_request и локальные имена/настройки роли. Тот же набор из 9, новых падений после интеграции не наблюдалось. Файл не менялся; полный серверный набор не заявляется зелёным.

## Выкладка

Production-рестарт, live-model, push не выполнены. Боевые численные бюджеты требуют согласования; новых чисел не задавали. Миграции 173/174/176/177 проверены изолированными тестами, в боевую БД не применялись. Для выкладки: пустая очередь ролей, backup, миграции, рестарт и health. Нативный отчёт и кадр находятся на Mac в `docs/2026-10-25-chat-conveyor-final.md`.

## Independent re-review
Three additional defects were reproduced and fixed: long histories now use newest 100 messages in chronological order; migration 177 persists transfer source and UUID until successful replacement reply persistence, and stale acknowledgement cannot clear a newer transfer; root and branch rooms share one authoritative checklist (legacy branch rows remain readable), including stop/fencing across rooms.
RED: /tmp/chat-conveyor-review-red.log (latest window and durable transfer); /tmp/chat-conveyor-branch-red.log (missing current item in branch); /tmp/chat-conveyor-branch-stop-red.log (picked delivery after root stop).
GREEN: 15 files / 87 passed, TEST_EXIT=0, BUILD_EXIT=0. Independent read-only re-review found no further blockers.
