# Отзыв сообщения до начала работы — 26.10.2026

POST /api/chats/:id/messages/:messageId/withdraw: только автор и участник чата. В одной синхронной транзакции повторная проверка, superseded для pending и удаление сообщения; attachments отвязываются, slot_topic_inbox удаляется по FK. 409 сохраняет начатое сообщение и не останавливает исполнение.

can_withdraw в представлении сообщения запрещает отзыв при picked/done, picked_at, ответе, активном SDK steering, messengerMessages активной карточки, delivered_at слота или подтверждённой координации. После await выбора роли и доставки повторно проверяется существование исходного сообщения. Событие chat:withdrawn адресуется участникам чата.

Проверки: новый endpoint до реализации — RED (8 падений); тестовый JWT затем исправлен на id вместо sub. Финальный Vitest 26/26 (11 withdrawal + 12 steering + 3 delivery), изолированные временные БД без моделей. tsc --noEmit PASS, diff --check PASS.

Административное удаление истории не изменено. Сервер не перезапускался, push не выполнялся. Клиент реализован в /Users/max/Проекты/TaskFlowNativeBuild, отчёт docs/2026-10-26-chat-withdrawal.md.

Перед сдачей: role_run_jobs queued/running=0, chat_message_queue pending=1. Живой процесс не перезапускать, ожидающее сообщение не трогать.

## Выполненное обновление
26.10.2026 npm run build PASS; резервная копия БД и старого dist: /home/maksim/.local/state/taskflow-backups/20261026-233300-chat-withdraw. Перед restart нет queued/running role_run_jobs и picked deliveries. Служба перезапущена: PID 3639102 → 3930297; health ok=true; withdraw route без авторизации отвечает ожидаемым 401. После запуска pending/picked=0. Штатный install-iphone.sh: BUILD SUCCEEDED, физический iPhone — установка и запуск PASS. Без UI-тестов, симулятора и push.
