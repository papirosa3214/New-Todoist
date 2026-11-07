# Discover с параметрами операции: явное объяснение конфликта

20.10.2026. Запрос владельца: исправить цикл помощника, получавшего каталог вместо сводки.

## Изменение
Общий шлюз taskflow при action=discover с operation или arguments возвращает ok=false, ACTION_CONFLICT и конкретную подсказку с примерами поиска, describe и invoke. Операция не исполняется, request_id не резервируется. Подсказка не отражает присланные значения аргументов. Обычный поиск и каталог без query сохранены. Автоматического превращения discover в invoke нет.

## Доказательства
- До изменения исходника: новые проверки — 4 FAIL / 1 PASS (ожидали конфликт, получали ok=true).
- После: universalTaskflow.test.ts — 18/18 PASS.
- secretary-tool-parity.test.ts — 5/5 PASS; toolRequestStore.test.ts — 4/4 PASS.
- roleToolCatalog.test.ts — 4/5 PASS. Единственный FAIL: secretary cannot regain plan_request through chat additions, ожидает FORBIDDEN, получает INVALID_ARGUMENTS. Отдельный запуск на исходнике HEAD до нашей правки воспроизвёл тот же FAIL. За пределами этой работы.
- npx tsc --noEmit — PASS.
- git diff --check — PASS.

## Граница приёмки
Исправлен источник шлюза на .110. Сервис не перезапускался, живой модельный сценарий не выполнялся. Нельзя утверждать, что MiniMax после подсказки перестанет повторяться: доказана обработка конфликтного вызова и последующий правильный describe/invoke в тесте.

## Применено 20.10.2026, 09:40 МСК
По прямому поручению владельца: npm run build PASS; очереди role_run_jobs queued/running/retry_wait и chat_message_queue pending/picked пусты. SQLite online backup: /home/maksim/.local/state/taskflow-backups/2026-10-20-discover-conflict-094032/taskflow.db, integrity_check=ok.
taskflow-server перезапущен, MainPID 4029001 → 4147146, active/running. GET /api/health ok=true. Пробный конфликтный вызов на собранном dist/runtime/universalTaskflow.js: ok=false, ACTION_CONFLICT, execute не вызван. Живой модельный запрос не запускался.

## Говорящие ошибки параметров — 20.10.2026, 09:54 МСК
Владелец потребовал не общую отсылку к схеме, а конкретное исправление.
INVALID_ARGUMENTS теперь получает контекстный hint: для верхнеуровневого поля операции — перенос query → arguments.query и полный исправленный invoke с исходным значением; для отсутствующих обязательных полей — arguments.<поле>; для других ошибок — места ошибок схемы и describe конкретной операции. Специальные подсказки адаптеров и host сохранены. Параметры автоматически не перемещаются, действие до исправления не исполняется.
RED: 4 новые проверки FAIL. GREEN: 22 теста шлюза + 4 request store PASS. npm run build PASS после исправления TypeScript narrowing внутри Check. На собранном dist реальный ошибочный формат помощника выдаёт точный перенос и JSON.
Online backup: /home/maksim/.local/state/taskflow-backups/2026-10-20-argument-errors-095314/taskflow.db (integrity_check ok).
Применено перезапуском taskflow-server после успешной сборки и проверки пустых очередей. Health ok=true. Модельный сценарий отдельно не запускался.

## Откат смягчения — 20.10.2026, 10:00 МСК
По прямому поручению владельца удалены Convert, синонимы id/task_id и text/body/content, автоматическое version=1 из ea537f08. Теперь аргументы проверяются без этих исправлений. Диагностика и говорящие подсказки сохранены; отдельная логика определения проекта для taskflow_remember не относится к проверке шлюза и не менялась.
RED: 6 FAIL на прежнем смягчении. GREEN: universalTaskflow 26/26 + toolRequestStore 4/4 PASS. npm run build PASS, diff --check PASS. Пробы собранного dist: числовой id и task_id вместо id → INVALID_ARGUMENTS; без версии → VERSION_MISMATCH.
Backup /home/maksim/.local/state/taskflow-backups/2026-10-20-strict-args-100019/taskflow.db, integrity_check ok. Очереди пусты; taskflow-server перезапущен, MainPID 86619, active; health ok=true. Исправление поведения модели этим не доказано.
