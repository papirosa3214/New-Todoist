# Состав обычного чата определяет адресацию — 16.10.2026

По прямому поручению владельца после создания/добавления/удаления участников сервер сохраняет kind в той же транзакции: >2 участников с создателем — group, иначе direct. При запуске исправляются старые несоответствия. chat-common, проектные группы и темы задач сохраняют групповой контракт. История, сессии, состав не удаляются.

Проверки:
- Новая API-регрессия до правки: 3 FAIL.
- chats, chats-online, chats-common-lifecycle, chatComposition: 83 PASS.
- Дополнительные проверки проектной группы и старого kind: окончательный chatComposition 5/5 PASS, суммарно 85 разных тестов.
- Runtime: личный чат отвечает без @, после добавления второй роли без @ молчит, @qa отвечает; после удаления qa оставшийся собеседник снова отвечает без @. Pi замокан, живых сообщений моделям нет.
- npm run build (tsc): PASS.
- Живой iOS XCUITest через реальные API: создана временная группа с u-secretary и role_designer, удаление u-secretary вернуло direct, приглашение обратно вернуло group. Тестовый чат удалён; на .110 осталось 0 чатов с его тестовым префиксом. UI-кадры и xcresult — в нативном репозитории docs/2026-10-16-chat-composition.md.

Deploy:
- Очереди role_run_jobs и chat_message_queue unfinished=0 перед restart.
- SQLite backup: /home/maksim/.local/state/taskflow-backups/chat-composition-20261016-044331.db, integrity_check=ok.
- Перезапущен taskflow-server, health ok=true. chat-secretary теперь group, несоответствий среди обычных чатов 0.

Откат кода: вернуть предыдущую версию server/src/routes/chats.ts, собрать tsc и перезапустить только при пустых очередях. Нормализованные kind соответствуют составу и не требуют отката данных. Полная резервная копия сохранена для восстановления при необходимости, без автоматического отката пользовательской истории.

Команды тестов: в server, Node v22.23.1; npx vitest run test/chatComposition.test.ts test/chats.test.ts test/chats-online.test.ts test/chats-common-lifecycle.test.ts; npm run build. Последние 2 дополнительных теста прогнаны целевым npx vitest run test/chatComposition.test.ts (5/5).
Логи проверки: /tmp/taskflow-chat-composition-{red,green,extra}.log, /tmp/taskflow-chat-composition-build.log.
Чужие untracked server/*key*.mjs, read-*.mjs, check-token.mjs не читались и не включаются в коммит.
