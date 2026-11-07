# Runtime ролей, gateway инструментов и переходы состояний — 22.10.2026

## Итог и точка остановки

Проведена согласованная итерация серверного ревью по трём областям. **11 подтверждённых дефектов исправлены; 13 новых тестов проходят.** Для каждого дефекта есть прогон воспроизведения до исправления. Две дополнительные проверки сохраняют прежний контракт и проверяют освобождение reservation после отказа подготовки.

Широкий связанный прогон не зелёный: **249 PASS / 9 FAIL, 30 файлов, 258 тестов**. Отдельный baseline до исправлений также красный: **42 PASS / 9 FAIL, 4 файла, 51 тест**. Восемь падений совпадают по имени, одно меняется при выполнении всего файла; ниже приведены точные списки. Полностью исправным сервер по этим данным не объявляется.

На этой границе работа остановлена по поручению владельца. Другие API, полный аудит безопасности, миграции и восстановление БД не расширялись в эту итерацию.

## Репозиторий и безопасность работы

- Только сервер .110: `/home/maksim/Проекты/New-Todoist`.
- Исходная точка продолжения: `f97d0022`; ранее сохранённый аудит — `32def4d0`.
- Рабочая ветка: `codex/server-audit-20261022`.
- Worktree: `/home/maksim/.local/state/taskflow-runs/worktrees/codex-server-audit-20261022`.
- Временный baseline: отдельный worktree на `f97d0022`, без изменения source.
- Реальные AGENTS и scopes прочитаны; изменяемые файлы зарегистрированы в IN_PROGRESS перед правкой. Главный main остался на `b8a8724d`, чистый.
- iOS, frontend и Web Desktop не менялись. Живые карточки и runtime-данные не использовались для тестовых мутаций; push, merge, deploy и restart не выполнялись.

## Охват трёх областей

| Область | Прослеженные пути | Доказательства и пределы |
| --- | --- | --- |
| Runtime ролей | `kickRoleTaskStrict`/durable worker → `runRoleInProcess` → slot session → preparation/context → SDK session → completion/failover/settle; также CLI action handoff | Управляемое ожидание настоящих серверных функций, подмена модели и внешних MCP; гонки подготовки и архива воспроизведены без модели |
| Gateway | `buildRoleToolCatalog` → `createUniversalTaskflow` → alias/adapter → `asRole`/`asControlActor` → Fastify route; host bash/push; durable request replay | Настоящий gateway, настоящая временная SQLite `role_tool_requests`, настоящий API отказ; host-вызовы подменены, shell/git операции не выполнялись |
| Задачи/планы | `canTransition`, claim/state; subtask work/done/release/block и attempt mismatch; plan approval/mutations/admission/recovery/completion; final review/rework budget | Чтение маршрутов и инвариантов + связанные unit/API-тесты; отдельные новые HTTP-регрессии на release/block и recovery архива |

Прочитаны основные модули `agentState.ts`, `routes/agent-state.ts`, `routes/tasks.ts` (переходы status), `routes/subtasks.ts`, `routes/task-collaboration-plans.ts`, `routes/reviews.ts` (вызовы lifecycle), `runtime/inProcessRun.ts`, `roleRunQueue.ts`, `roleRunWorker.ts`, `slotSession.ts`, `slotRestart.ts` (через профильный тест), `roleRunAccess.ts`, `roleToolCatalog.ts`, `universalTaskflow.ts`, `toolRequestStore.ts`, `hostOperations.ts`, `hostRoleTools.ts`, `externalAgentActions.ts`, `cliAgentSession.ts`, `planMutations.ts`, `planSubtaskAdmission.ts`, `planReviewLifecycle.ts`, `reviewRunBudget.ts`, `taskExecutionState.ts`. Длинные модули проверялись по соответствующим функциям и переходам, а не построчно целиком.

Реальный SDK model run, реальные host file tools на Mac, Composio и внешние записи не запускались. Сохранённые боевые `toolCall`/`toolResult` не выдаются за проверенные: доказательство в этой итерации — действительный gateway/route и сохранённые state/result запроса в **изолированной БД**, а не UI-label или успешный describe.

## Подтверждённые дефекты и исправления

Строки относятся к source в **f97d0022**, до исправлений. Для воспроизведения: `git show f97d0022:<путь>`.

| № | Приоритет | Источник | Сценарий, последствия и исправление |
| --- | --- | --- | --- |
| R1 | P1 | `server/src/runtime/inProcessRun.ts:1359,1390–1400` | Два запуска без subtask проходят проверку activeRuns до первого await; пока готовится контекст, регистрации run ещё нет. Создаются две SDK-сессии одного окна. Добавлена синхронная reservation по task/subtask на подготовку, снимается в finally. |
| R2 | P1 | `server/src/runtime/inProcessRun.ts:1360`; `server/src/runtime/slotSession.ts:45–49` | Проверка живого holder видит только activeRuns. Медленная подготовка дольше leaseWait выглядит потерянной арендой: второй слот начинает готовить ещё одну сессию. Predicate теперь учитывает preparation reservation; тест удерживает подготовку дольше короткой тестовой аренды. |
| R3 | P1 | `server/src/runtime/inProcessRun.ts:1453–1462,1689` | Владелец архивирует карточку во время ожидания контекста; прежний код всё равно запускает роль. Повторная проверка доступности добавлена на входе, после контекста и непосредственно перед prompt. Тест архивирует временную карточку внутри этого окна. Это не полный протокол отмены уже идущей модели. |
| G1 | P1 | `server/src/runtime/universalTaskflow.ts:1199–1200` | Уже aborted SDK signal всё равно допускает write-адаптер, если тот сам не проверяет сигнал. Gateway отказывает до begin/execute; отменённый запрос не занимает durable request_id, последующий осознанный вызов может его использовать. |
| G2 | P1 | `server/src/runtime/hostOperations.ts:68–80` | Bash adapter не передаёт options.signal в host gateway. Остановка роли оставляет удалённую команду работающей до таймаута. Сигнал теперь доходит до runOperation и существующего cancel protocol. Тест проверяет точную идентичность AbortSignal на границе. |
| G3 | P1 | `server/src/runtime/hostRoleTools.ts:64–76` | Оба remote отклоняют push, но адаптер возвращает обычный текст; gateway сохраняет succeeded. Теперь хотя бы один неудачный remote вызывает ошибку с деталями каждого remote; durable outcome не успешный. При частичной отправке unknown_outcome сохраняет осторожную семантику, повтор того же request_id не отправляет снова. Список remote не менялся. |
| G4 | P2 | `server/src/runtime/inProcessRun.ts:400–402` | Обёртка заменяет ToolError от настоящего API на Error, теряя status/name. Обычный 4xx отказ становится OPERATION_FAILED/unknown_outcome. ToolError сохраняется; реальный 404 comment route проходит через gateway как REJECTED. |
| G5 | P1 | `server/src/runtime/externalAgentActions.ts:66,79` | Разные ходы CLI-агента используют ключ session:ext:0. Второе изменение конфликтует с первым или возвращает старый результат, не исполняясь. Теперь у каждого assistant-turn отдельная UUID-идентичность, а индекс различает действия внутри turn. Тест проводит два разных действия через настоящий universal gateway. |
| S1 | P1 | `server/src/runtime/planSubtaskAdmission.ts:1133–1147,1295` | Completion recovery выбирает архивную active-карточку с завершёнными шагами и переводит её в review, создавая новую версию результата. Архив исключён как на входе finishPlanIfComplete, так и в фоновом списке. Состояние/версии архивной карточки остаются неизменными. |
| S2 | P1 | `server/src/routes/subtasks.ts:939–943,993` | `work {state:null}` сбрасывает состояние, но закрытие current_attempt находится только в non-null ветке. Шаг выглядит свободным при открытой попытке; новый старт может упереться в unique active-attempt. Null-release теперь атомарно закрывает attempt и очищает ссылку вместе с состоянием. |
| S3 | P1 | `server/src/routes/subtasks.ts:957–963,999–1003` | Неверный snapshot блокировки проверяется уже после изменения state и agent_id. HTTP 400 оставляет шаг blocked с другим actor и прежней открытой попыткой. Snapshot валидируется до мутации; тест проверяет неизменность всех трёх полей и попытки после 400. |

Оптимизация здесь — устранение лишних запусков, ошибочных повторов и потерянных вызовов. Произвольного рефакторинга, новых таблиц/таймеров/метрик нет.

## Отброшенная гипотеза

Сначала отсутствие role_key в semantic dedupe add_step выглядело ошибкой. Существующий `livePlan.test.ts:314–324` явно закрепляет противоположный контракт: одинаковая работа от другой роли возвращает уже существующий слот. Гипотеза снята, изменение production planMutations полностью отменено. Новый положительный тест сохраняет этот контракт. Это не включено в 11 исправлений.

## Проверки и артефакты

Новые файлы: `runtimeAuditStart.test.ts` (4), `runtimeAuditGateway.test.ts` (3), `runtimeAuditPlans.test.ts` (2), `runtimeAuditTransitions.test.ts` (2), `runtimeAuditExternal.test.ts` (2). Всего **13/13 PASS** в заключительном общем прогоне.

RED подтверждён отдельно: исходные startup и lease — на baseline f97d0022; cancellation/host push/API error/CLI turn/plan archive/subtask release/snapshot — до соответствующих source-правок. Ошибки первоначальных fixture (порядок FK-вставок) устранены до зачтённого RED. Semantic dedupe — исключённая гипотеза.

- Финальный связанный прогон: **249 PASS / 9 FAIL**, 30 файлов, 258 тестов. Полный suite всего сервера не запускался.
- Baseline четырёх подозрительных файлов: **42 PASS / 9 FAIL**. LivePlan на baseline зелёный; случайно нарушавшая его гипотеза отменена, финальный livePlan тоже зелёный.
- `без продвижения повторно не зовёт` проходит отдельно на baseline и после изменений. В полном файле на текущем коде он падает, а на baseline в данном прогоне вместо него падает C2. Это свидетельство зависимости от порядка, а не доказательство исправности всех continuation-путей.
- `tsc --noEmit`: PASS (production src по существующему tsconfig).
- `git diff --check`: PASS.
- Node 22.23.1; Vitest setup задаёт временную SQLite/roles/runs/uploads/пустые model credentials. Финальные прогоны дополнительно используют `INBOX_TRIAGE_DISABLED=1` и отсутствующий временный `TASKFLOW_NOTIF_ROOT`, отключая наблюдение папки реальных уведомлений. Новые runtime-start tests подменяют Composio и infra MCP.
- Ранние новые прогоны использовали общий test/setup без дополнительного отключения watchers: в логах был старт наблюдения папки уведомлений. Проверка живого отсутствия каких-либо побочных файловых изменений задним числом не заявляется; новых живых карточек агент намеренно не создавал. Последующие контрольные прогоны выполнены с явной изоляцией этой поверхности.
- Временные логи: `/tmp/runtime-audit-final.log`, `/tmp/runtime-audit-baseline.log`, `/tmp/runtime-audit-focused.log`, `/tmp/runtime-audit-tsc.log`, RED `/tmp/runtime-audit-red.log`, `/tmp/runtime-audit-start-red.log`, `/tmp/runtime-audit-start-full-red.log`, `/tmp/runtime-audit-transitions-red.log`, `/tmp/runtime-audit-external-red.log`, `/tmp/runtime-audit-archive-start-red.log`.
- Машиночитаемое резюме: `docs/2026-10-22-server-runtime-audit-tests.json`.

## Красная база: точные сценарии

### Финальный прогон

- test/inProcessRun.test.ts > агент роли внутри сервера > рабочая карточка подтверждает доставку только при включении сообщения в контекст
- test/inProcessRun.test.ts > агент роли внутри сервера > групповой вопрос двум работающим ролям сохраняет отдельный адрес каждого ответа
- test/inProcessRun.test.ts > агент роли внутри сервера > работа начавшаяся во время ожидания чата получает вопрос без ложного failed
- test/inProcessRun.test.ts > агент роли внутри сервера > вышел посреди работы, но продвинулся — сервер зовёт снова, и агент доделывает (C3)
- test/inProcessRun.test.ts > агент роли внутри сервера > без продвижения повторно не зовёт
- test/planComplete.test.ts > план сдан — карточка на проверку > все узлы сданы — review, версия результата, проверяющий в очереди; второй раз — ничего
- test/planComplete.test.ts > план сдан — карточка на проверку > при старте сервера подбирается уже сданный план
- test/planComplete.test.ts > план сдан — карточка на проверку > закрытие последнего узла через API сдаёт карточку
- test/roleToolCatalog.test.ts > secretary cannot regain plan_request through chat additions

### Baseline f97d0022

- test/inProcessRun.test.ts > агент роли внутри сервера > рабочая карточка подтверждает доставку только при включении сообщения в контекст
- test/inProcessRun.test.ts > агент роли внутри сервера > групповой вопрос двум работающим ролям сохраняет отдельный адрес каждого ответа
- test/inProcessRun.test.ts > агент роли внутри сервера > работа начавшаяся во время ожидания чата получает вопрос без ложного failed
- test/inProcessRun.test.ts > агент роли внутри сервера > сервер сам будит роль, а после сдачи — Критика (этап C2)
- test/inProcessRun.test.ts > агент роли внутри сервера > вышел посреди работы, но продвинулся — сервер зовёт снова, и агент доделывает (C3)
- test/planComplete.test.ts > план сдан — карточка на проверку > все узлы сданы — review, версия результата, проверяющий в очереди; второй раз — ничего
- test/planComplete.test.ts > план сдан — карточка на проверку > при старте сервера подбирается уже сданный план
- test/planComplete.test.ts > план сдан — карточка на проверку > закрытие последнего узла через API сдаёт карточку
- test/roleToolCatalog.test.ts > secretary cannot regain plan_request through chat additions


Совпадение baseline исключает приписывание этих падений данной правке, но само по себе не исключает продуктовую ошибку. Автоматически переписывать тесты под нынешнее поведение или выдавать старые падения за решённые нельзя. Они остаются открытым ограничением приёмки и отражены в чек-листе.

## Оставшиеся риски внутри проверенных областей

- Красные baseline-сценарии continuation, messenger delivery, completion и catalog требуют отдельного разбора фикстур и продуктового поведения. Для них здесь не заявлены ни исправления, ни полная приёмка.
- At-least-once после crash между внешним эффектом и durable ack, многопроцессные lease-fences, полная отмена во всех адаптерах и recovery всего внешнего SDK здесь не доказаны.
- Нативные файловые инструменты удалённого host (`write/mkdir`, `ls/stat`, `find/glob`, `grep`) требуют отдельной реальной приёмки server→SDK→host; ранее KB уже отмечала ограничения этой связки. Данный цикл проверил bash cancel и push outcome, а не выдал низкоуровневые тесты за исправность всего host tool stack.
- `preparingRuns` — защита внутри одного server process; не распределённая блокировка. Она не добавляет публичный preparing-статус и не заменяет владельцу интерфейс отмены подготовки.
- Проверка архива перед prompt закрывает воспроизведённое окно подготовки; архивирование после начала prompt всё ещё зависит от существующего abort-протокола.
- Освобождение null-attempt и отказ snapshot проверены через HTTP. Полная транзакционность всех остальных subtask-переходов при I/O/SQLite-отказах не доказывалась.

## Source / tests / live и дальнейшая работа

Source: собственные изменения в изолированной ветке, выборочный коммит. Tests: новые регрессии зелёные, расширенная база красная и разобрана выше. Live: **не выложено**, реальная модель и host не использовались для приёмки. Без push, merge и restart.

Следующее действие по поручению владельца — остановиться и передать этот результат. Отложенные области перечислены в `docs/2026-10-22-server-audit-todo.md`; продолжение и выкладка не запускаются автоматически.
