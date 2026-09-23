# Независимый технический отчёт: перенос ролей TaskFlow внутрь сервера

**Дата среза:** 23 сентября 2026 года.  
**Автор:** Manus AI.  
**Проверенные ревизии:** серверный feature `8d1dbf3a5a1f98131d486ee5e973bfcf8d68e1b3`, `origin/main` `bff130eebac5f6d43d0fcbd9ddc2198041e2ecdf`; iOS feature `7e1f0a726c36cb49649a6ed6914b58780e9582d6`, `origin/main` `0de5d4f694849c2d9b14106e2fb8820d35da100d`.

> **Граница ревью.** Отчёт основан на удалённом состоянии веток и их локальных read-only копиях **на 23.09.2026**. Репозитории и рабочие деревья не изменялись. Ревью сочетает анализ плана, истории Git, исходного кода, целевых тестов и воспроизводимых сборок. Оно не подтверждает состояние production-служб, systemd-конфигурации, настоящих моделей или неисполненные живые сценарии.

## Прямой вывод

**Стадия реализации — работающий, но незавершённый server-first prototype, не готовый к merge или production-эксплуатации.** Серверное ядро действительно существует: роли перенесены в таблицу `roles`, запуск Pi встраивается в сервер, инструменты трекера вызываются через `app.inject`, сервер реагирует на изменения карточек, а server CRUD ролей реализован. На iOS реализована существенная часть управления ролями и чатов. Это больше, чем план или макет.

**Концепция архитектурно удачна как направление, но её нельзя считать удачно завершённой реализацией.** Отказ от постоянных ключей на новом внутреннем пути и хранение ролей в реестре БД устраняют центральную причину прежней сложности. Однако обещанный единый объект роли пока распадается между БД, `role-routing.yaml`, prompt-файлами, legacy `users` и статическими каталогами клиентов. Переход не имеет надёжной оркестрации, а воспроизведённый дефект позволяет создать роль с зарезервированным ключом `owner` и получить AI-учётку с authority `owner`. При таком дефекте, красных сборках и незавершённой C4 merge следует блокировать.

### Что установлено как факт

* Миграции `056_roles` и `057_roles_prompt`, in-process runtime, автоматические `kickRoleTask`, хранение C3-сессий и server API ролей присутствуют в серверной ветке. Целевые тесты ролей прошли.
* Прямой security-прогон в изолированной БД создал `role_owner` с `role='owner'`; JWT этой учётки получил `200` на owner-only `PATCH /api/roles/owner`. Это воспроизводимый факт, а не предположение.
* Веб-клиент читает роли, но не подключает POST/PATCH управления ролями. iOS позволяет создать, изменить и отключить роль, но выбор модели не доступен владельцу из обычного пути экрана «Команда».
* Полные production-проверки не проведены. В частности, C3-продолжение диалога между запусками и реальное включение `TASKFLOW_ROLES_IN_SERVER=1` остались неподтверждёнными.

### Профессиональная оценка

Архитектурный выбор следует сохранить, но дальнейшее расширение следует остановить до устранения P0 и определения durable-контракта запусков. Нельзя объявлять миграцию на «безключевую» схему завершённой, пока остаются `roleRunAccess.ts`, временный JWT/MCP-путь, постоянные профили и неунифицированные источники конфигурации.

## Объект и метод проверки

Канонический handoff-план находится в `docs/2026-09-23-roles-in-server-plan.md`. Он сам называет готовыми пункты 3.1–3.4, а пункты 3.5–3.7 оставляет незавершёнными. История этого файла ограничена двумя коммитами: создание `bb20f4c` и уточнение `8d1dbf3`; второе изменение перевело серверную часть 7.2 в «✅ Сервер сделан». Восемь milestone-коммитов `8315ee8c`…`891b704e` являются предками серверного HEAD. Это подтверждает историю поставки, но само по себе не доказывает корректность реализации.

Статусы в матрице ниже означают следующее: **Сделано** — функция присутствует и имеет достаточное кодовое/тестовое подтверждение в заданной границе; **Частично** — ядро есть, но нарушен контракт, неполон охват либо остался критический эксплуатационный разрыв; **Не сделано** — работа отсутствует или явно отложена; **Не подтверждено** — утверждение нельзя подтвердить без живого запуска или недоступной среды.

## Матрица пунктов плана

| Пункт плана | Статус | Фактическое состояние | Доказательство до файла, символа или строки; коммит |
|---|---|---|---|
| §3.1. Роль — запись `roles`; весь код получает список из таблицы | **Частично** | Таблица с `key`, `title`, `summary`, `enabled`, `position` и seed-ролями есть. `refreshRoles()` наполняет реестр. Но «весь код» неверно: web сохраняет `PI_ROLE_META`, `ROLE_ORDER`, `AVATAR_SLUGS`; также есть YAML, embeddings и legacy-каталоги. | `server/src/migrations.ts:2018–2058,2081–2145`; `server/src/roleRouting.ts`; `src/screens/AgentsScreen.tsx:34–82,712–735`; `src/screens/CreateChatSheet.tsx:35–70`; `src/lib/liveActivity.ts:151–176`. `1ab75f60`, `891b704e`. |
| §3.2. Pi работает внутри сервера и пользуется внутренними инструментами без постоянного API token | **Частично** | Новый task-path создаёт `createAgentSession`, вызывает API через подписанный сервером `app.inject`, держит heartbeat и блокирует карточку при ошибке. Но остаётся legacy `startRun` с 12-часовым JWT и временным `--mcp-config`; authority роли небезопасна из-за незащищённых ключей. | `server/src/runtime/inProcessRun.ts:394–495`; `server/src/runtime/roleRunAccess.ts:47–80`; `server/src/runtime/PiRuntimeAdapter.ts:736–749`; `server/src/routes/roles.ts:291–413`. `e9b5812e`, `caf53350`, `891b704e`. |
| §3.3. Сервер сам решает, кого будить; будильник не занимается ролями | **Частично** | `kickRoleTask` вызывается из dispatch, tasks, comments/subtasks и review; `trigger.py` пропускает роли при `TASKFLOW_ROLES_IN_SERVER=1`. Запуск fire-and-forget: событие может потеряться после DB-коммита, ошибки подавляются, durable retry/recovery нет. Фактический systemd drop-in не проверен. | `server/src/routes/dispatch.ts:418–421`; `tasks.ts:1381–1385`; `subtasks.ts:805–809`; `agent-state.ts:1179–1183`; `runtime/inProcessRun.ts:542–586`; `scripts/trigger.py`. `f9e7595c`. |
| §3.4. Диалог переживает заходы; есть повтор, папка и справка | **Частично** | `SessionManager.continueRecent` хранит сессию на пару task+role; цепочка ограничена тремя заходами, определяются working directory и repo note. Ключевой сценарий C3 не испытан живьём, а память зависит от локальной файловой директории и не восстанавливается как durable workflow. | `server/src/runtime/inProcessRun.ts:394–495`; план: `docs/...roles-in-server-plan.md:73,84–88,119–122`. `0a71253f`. |
| §3.5 / C4. Удалить ключи, профили, `--secret` и временный шаг A | **Не сделано** | Сам план откладывает уборку до нескольких дней стабильности. `roleRunAccess.ts` и legacy `PiRuntimeAdapter.startRun` всё ещё выпускают JWT и передают MCP-config; архивные профили и связанные артефакты остаются. | План: строки `138–145`; `server/src/runtime/roleRunAccess.ts:47–80`; `PiRuntimeAdapter.ts:736–749`. `caf53350`; на HEAD `8d1dbf3`. |
| §3.6. «Команда»: добавить, отключить и изменить роль, включая модель | **Частично** | Сервер реализует GET/POST/PATCH. iOS создаёт/правит title, summary, prompt и enabled. Веб — read-only для ролей. Model routing вынесен из CRUD в отдельный YAML endpoint; owner не попадает к model menu из обычного Team-flow iOS. | `server/src/routes/roles.ts:291–414`; `server/src/routes/runtime.ts:239–292`; `src/screens/AgentsScreen.tsx:382–493,540–572,603–735`; iOS `AgentsScreen.swift:41–65,126–146`; `RoleEditorSheet.swift`; `AgentProfileScreen.swift:354–397`. `891b704e`, iOS `7e1f0a7`. |
| §3.7. Остальная логика будильника переезжает в сервер либо будильник исчезает | **Не сделано** | Будильник продолжает обслуживать оркестратора и родителя; конечная модель не выбрана. | План: строки `46–47,155–156`; `server/scripts/trigger.py`. HEAD `8d1dbf3`. |
| §5. Удаление Синтезатора | **Сделано** | Commit удаляет роль из используемого набора; план привязывает сведение к Исследователю. Эта строка относится к историческому cleanup, а не доказывает полноту нового реестра. | План: строка `67`; Git commit `8315ee8c` — предок HEAD. |
| §5, этап 1. Реестр, динамический `ROLE_NAMES`, шаблон Секретаря | **Сделано** | Реестр и миграция реализованы; `rolesPromptBlock()` применяется для динамического блока исполнителей. Глобальное устранение всех копий ролей отдельно остаётся частичным по §3.1. | План: строка `68`; `server/src/migrations.ts`; `server/src/roleRouting.ts`. `1ab75f60`. |
| §5, шаг A. Временный JWT/MCP-конфиг | **Сделано как временная мера** | Код существует именно как промежуточный обходной путь. Это не положительный критерий конечной архитектуры и должен быть удалён в C4. | План: строка `69`; `server/src/runtime/roleRunAccess.ts`; `PiRuntimeAdapter.ts`. `caf53350`. |
| §5, C1. Внутрисерверный ручной запуск | **Сделано** | Manual-run направляет исполнителя/верификатора в in-process path; целевые тесты проходили. | План: строка `70`; `server/src/routes/manual-run.ts`; `runtime/inProcessRun.ts`. `e9b5812e`. |
| §5, C2. Автопробуждение по событиям | **Частично** | Event hooks реализованы, но не обеспечивают доставку: нет outbox, lease, retry или crash recovery; in-memory guard имеет race. | План: строка `71`; `runtime/inProcessRun.ts:403–450,542–586`; перечисленные routes. `f9e7595c`. |
| §5, изоляция теста от живого будильника | **Сделано** | `roleMatrix.test.ts` использует заглушку `systemctl`; тесты изолированы от живой службы. | План: строка `72`; `server/test/roleMatrix.test.ts`. `b8c58387`. |
| §5, C3. Continuation до трёх заходов | **Частично** | Логика и тесты есть; реальный контекст смены blocked → comment → resume не запускался с моделью. | План: строки `73,84–88`; `runtime/inProcessRun.ts`; `server/test/inProcessRun.test.ts`. `0a71253f`. |
| §5 / §7.2 сервер. CRUD ролей и `roles.prompt` | **Частично** | `GET`, `GET?all`, `POST`, `PATCH` и migration 057 реализованы, target tests проходят. API не принимает model, reserved key не защищены, HTTP-проба не проведена. | План: строка `74`; `server/src/routes/roles.ts:291–414`; `server/src/migrations.ts`; `server/test/rolesManage.test.ts`. `891b704e`. |
| §7.1. Живая C3-проба с созданием и удалением тестовой карточки | **Не подтверждено** | План прямо фиксирует, что проба не выполнена: «Система» выключена владельцем. Новой независимой live-проверки не было. | План: строки `84–88,119–122`. HEAD `8d1dbf3`. |
| §7.2 iOS-клиент | **Частично** | iOS имеет CRUD основных полей и включение/отключение, но нет model/position в `RoleEditorSheet`; key validation шире серверного ASCII regex; права и модель не являются единым контрактом роли. | `ios-feature/Sources/Features/Chat/AgentsScreen.swift`; `RoleEditorSheet.swift:44–61,113–127,189–257`; `APIClient+Roles.swift:30–89`. iOS `7e1f0a7`. |
| §7.2 веб-клиент | **Не сделано** | `useRoles` читает GET; hooks/UI POST/PATCH не подключены. Статический блок «Роли Pi-агента» остаётся источником метаданных. | `src/screens/AgentsScreen.tsx:382–493,540–572,603–735`; `CreateChatSheet.tsx`; `liveActivity.ts`. Сервер `891b704e`; web HEAD `8d1dbf3`. |
| §7.3. Перевести/удалить `team_catalog`, embeddings, `apns` | **Не сделано** | Явно отложено вместе с C4. Нет доказательства завершённой миграции этих источников. | План: строки `138–145`; упомянутые артефакты репозитория. HEAD `8d1dbf3`. |
| §7.4. Перенести недостающие MCP-инструменты | **Не сделано** | Внутренний `taskflowTools` покрывает ограниченный набор. Chat/task/project/files/web/OCR/YouTube/local-model/report и другие перечисленные возможности не перенесены как общий in-process набор. | План: строки `147–151`; `server/src/runtime/inProcessRun.ts:101–103`; `server/scripts/mcp_server.py`. `e9b5812e`, `0a71253f`. |
| §7.4. Учет стоимости и ограничение параллелизма | **Не сделано** | Нет token/cost accounting, глобальной очереди, capacity limit или durable lease. `activeRuns` — локальная память процесса. | План: строки `152–154`; `runtime/inProcessRun.ts:403–450`. HEAD `8d1dbf3`. |
| §7.4. Судьба остального будильника и `agent_inbox` | **Не сделано** | План признаёт неполный перенос: не-ролевые исполнители остаются в trigger, delivery journal для ролей больше не ведётся. | План: строки `155–156`; `scripts/trigger.py`. HEAD `8d1dbf3`. |
| Внерепозиторные заявления плана: `NODE_USE_ENV_PROXY`, `TASKFLOW_ROLES_IN_SERVER`, архив role_synthesizer | **Не подтверждено** | Это самоотчёт плана. Sandbox не имеет пользовательского systemd и не обнаружил доступного drop-in; live deployment не утверждается. | План: строки `76–82`; попытка `systemctl --user` недоступна в sandbox. |
| Внерепозиторное заявление: две живые пробы и «498/498» | **Не подтверждено** | Самоотчёт от 23.09 не повторялся. В отдельной независимой полной проверке suite дал 497/501; причины включали внешний embedding endpoint и жёстко заданный путь checkout. | План: строки `84–90`; см. раздел «Тесты». |

## Сервер: что реализовано и почему этого недостаточно

### Реализованное ядро

Серверная часть является наиболее зрелой частью работы. Migration 056 создаёт `roles` и seed-данные. После миграций `refreshRoles()` строит динамический registry. В `inProcessRun.ts` `createAgentSession` соединён со встроенными инструментами Pi и серверными taskflow-инструментами. Последние действуют через `app.inject` от имени role account, а не через внешний постоянный ключ. В run loop предусмотрены heartbeat и попытка выставить `blocked` при ошибке. [1]

Контекст C3 создаётся для пары `taskId + role`, хранится в `SessionManager.continueRecent`, повтор запуска ограничен тремя итерациями. Для ручных запусков и event-driven execution есть общий in-process путь. Роуты ролей позволяют получать включённые или все роли, создавать роль с `role_<key>` AI-учёткой и отключать её через `enabled=0`, сохраняя историю. Это согласуется с ключевым бизнес-инвариантом «не удалять роль». [1]

### Критические серверные разрывы

**P0 — эскалация authority через ключ роли.** `POST /api/roles` принимает любой ключ, удовлетворяющий regex, без reserve-list. Создание `key=owner` порождает `role_owner` с `users.role='owner'`. В isolated DB proof role JWT успешно выполнил owner-only PATCH. [Постоянное доказательство и безопасный скрипт воспроизведения](evidence/2026-09-23-role-owner-authority-escalation.md) сохранены рядом с отчётом. Полагаться на то, что роль создаёт уже владелец, недостаточно: server создал ещё одну bearer identity с полномочиями владельца, а системные роли оказываются forgeable. Требуется блокировать privileged/internal keys, разъединить role capability и authority `users.role`, добавить DB-инварианты и регрессионные тесты.

**P1 — не существует durable доставки запуска.** Изменение состояния задачи коммитится отдельно, затем route запускает `void kickRoleTask(...)`. Ошибки в этой background-ветке проглатываются. Падение процесса, неуспешный runtime или гонка между проверкой и `activeRuns.set` оставляют задачу активной, но без исполнителя. `activeRuns` и `chainCount` не атомарны, не разделяются между процессами и исчезают после рестарта. Поэтому нынешняя реализация — удобный in-process launcher, но не оркестратор с гарантией доставки.

**P1 — семантика disable неполна.** `enabled=0` исключает ключ из `ROLE_NAMES`, однако не отменяет активный run, не снимает assignment, не останавливает очередь/чат и не даёт владельцу видимой обратной связи. Disabled роль может оставаться участником чата и впоследствии молча не выбираться для ответа.

**P2 — агрегат роли расщеплён.** БД хранит базовую запись и prompt; models/fallbacks/defaults находятся в `server/scripts/role-routing.yaml`; effective prompt может прийти из файла; legacy `users.permissions`, embeddings, catalog и профили — ещё в других источниках. Нет FK, unique constraint на `users.role`, канонического immutable role ID, revision, аудита или атомарного create+model change.

### Что требуется от серверной архитектуры

До дальнейшей функциональности необходимо определить единый versioned Role aggregate: immutable ID и key, authority matrix, связь role↔account, enabled/disabled lifecycle, модель, prompt/source, position, permissions, revision и правила совместимости API. Затем требуется transactional outbox/job, idempotency key, unique active lease на task+attempt, retry/backoff/dead-letter, restart recovery и явная capacity policy. Это профессиональная рекомендация, вытекающая из обнаруженных разрывов; план пока такого контракта не задаёт.

## Веб: статус и разрыв с целевой «Командой»

Веб-клиент получает серверный список ролей через GET и отображает его. Однако `AgentsScreen.tsx` содержит только `useCreateAgent` и `useDeleteAgent`, а не создание/редактирование/включение roles. Блок «Роли Pi-агента» продолжает рендериться из `PI_ROLE_META`. В `CreateChatSheet.tsx` есть `ROLE_ORDER`, в `liveActivity.ts` — `AVATAR_SLUGS`. Следовательно, web по факту сочетает динамическое чтение с несколькими ручными copies словаря ролей. [1]

**Факт:** обещание §7.2 для web не выполнено. Пользователь не может из веб-интерфейса добавить роль, изменить title/summary/prompt, отключить её либо установить модель. **Мнение:** нужно не только добавить формы POST/PATCH. Следует сначала согласовать агрегат роли и contract модели, иначе web UI закрепит текущую неатомарность между `roles` и YAML.

## iOS: существенно дальше веба, но цель не закрыта

iOS feature содержит `RoleProfile`, API для GET/POST/PATCH roles и отображает runtime status, prompt, tools, permissions, модель, fallback-модели, задачу, summary и enabled. «Команда» периодически обновляется, разделяет включённые и отключённые роли. Владелец может создать роль, изменить key/title/summary/prompt, сбросить prompt и включить/отключить роль. UI ожидает ответ сервера, а не выполняет optimistic PATCH. Ролевые чаты включают список, личные и групповые комнаты, сообщения, вложения, typing, WebSocket и polling fallback; manual task run запускает server-side in-process execution. [2]

Но обычный owner-flow «Команды» открывает `RoleEditorSheet`, где есть key/title/summary/prompt/enabled, но **нет model и position**. Единственное model menu находится в `AgentProfileScreen`; owner не переходит туда из строки Команды. При этом серверный POST/PATCH roles модели вообще не принимают: она меняется отдельным `PUT /api/runtime/routing/:role`. Новая роль получает наиболее частую default model. Поэтому формулировка плана «добавить/править роль, включая модель» не выполнена ни атомарно, ни в нормальном iOS UX.

Есть и дополнительные факты качества контракта. Client validation key допускает любую lowercase letter Unicode, в том числе кириллицу, тогда как сервер принимает лишь `[a-z]`. `markRoleChatRead(id:)` объявлен в клиенте, но caller отсутствует, поэтому unread badge не обязан сбрасываться после открытия комнаты. При ошибке chat turn пользовательский текст уже сохранён, а background failure может быть только залогирован: нет событий accepted/queued/running/failed/succeeded-empty, receipt или Retry target-role. Редактирование не имеет revision/ETag, так что PATCH и YAML routing подвержены last-write-wins между устройствами.

Сборка iOS не запускалась не по причине исходной ошибки, а потому что в Ubuntu sandbox отсутствуют `swift`, `xcodebuild` и `xcodegen`. Историческое заявление документа о `xcodebuild BUILD SUCCEEDED` не является независимым подтверждением. Нужен запуск на macOS с `xcodegen generate && xcodebuild -scheme TaskFlow -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build test`.

## Результаты тестов и сборок

| Проверка | Результат | Значение и ограничение |
|---|---|---|
| Targeted server role suite | **PASS**: 13 файлов, 144 теста, 8.65 s | Пройдены `rolesRegistry`, `rolesManage`, `roleMigration`, `roleProfiles`, `roles`, `roleMatrix`, `inProcessRun`, chat/manual/runtime tests. Это сильное подтверждение ядра, но не security/durable-orchestration coverage. |
| Полный server `npm test` | **FAIL**: 497/501 | 2 semantic-enrichment cases зависели от недоступного embedding endpoint; 2 task-intake cases используют отсутствующий абсолютный путь `/home/maksim/.../tsx`. Ошибки не отнесены к role-коммитам, но HEAD не зелёный. |
| Server `npm run build` | **FAIL** | `ai.ts:1005` — undefined `maxChars`; `chats.ts:292` — potentially undefined `chat`. Blame относит их к 20 и 22 сентября, не к заявленным role milestones. Merge-gate всё равно красный. |
| Root web `npm test` | **PASS**: 9 файлов, 126 тестов | Unit tests web проходят. Это не проверяет Team CRUD, которого нет. |
| Root web `npm run build` | **FAIL** | `ProjectsScreen.tsx`: unused `noProjectCount`, undefined `navigate`, undefined `noProjectCount` в двух местах. Production web build красный. |
| Security proof в isolated DB | **PASS как воспроизведение дефекта** | Создание `key=owner` вернуло 201; JWT `role_owner` выполнил owner-only PATCH с 200. Не использовалась production БД. |
| Focused `rolesManage.test.ts` в iOS-аудите | **Не подтверждено в той sandbox-попытке** | Первый Vitest run потерял fork workers; повтор с threads завершился SIGSEGV 139 до assertions. Это не assertion failure и не отменяет независимый server run выше. |
| iOS build/test | **Не запускались** | Нужна macOS/Xcode-среда. |
| C3 live continuation и live HTTP roles | **Не подтверждено** | «Система» выключена владельцем; рабочего agent key для плановой HTTP-пробы нет. |

Полная test-картина не противоречит целевым role tests: они действительно демонстрируют реализованное ядро. Однако она противоречит любому утверждению о merge-ready состоянии, потому что оба build gate красные, а ключевые race/security/recovery сценарии не покрыты.

## Расхождение feature и main

| Репозиторий | Проверенная линия | Отношение к main | Вывод |
|---|---|---|---|
| Server | `HEAD=8d1dbf3`; `origin/main=bff130e`; merge-base равен `bff130e` | feature линейно содержит main; `origin/main..HEAD` содержит 121 commit | Ролевые commits `8315ee8c`, `1ab75f60`, `caf53350`, `e9b5812e`, `f9e7595c`, `b8c58387`, `0a71253f`, `891b704e` относятся к feature и отсутствуют в main. |
| Native iOS | `HEAD=7e1f0a7`; `origin/main=0de5d4f`; merge-base `dce3e9e` | main не является предком iOS feature | Это расходящиеся ветви, а не простой feature поверх текущего main. Перед merge нужна отдельная интеграционная оценка конфликтов и совместимости server API. |

Факт расхождения iOS важен не только для Git-процесса. Его API/UI изменения проверялись против server feature `8d1dbf3`, а не против гарантированного общего baseline. Нельзя интерпретировать наличие кода в iOS feature как готовность к безрисковому merge в текущий main.

## Архитектурная оценка

**Сильные стороны.** Центральное решение верно разделяет внутреннее выполнение и внешний API: Pi является библиотекой/сессией сервера, а TaskFlow tools вызываются не через отдельную программу с долговременным секретом, а как внутренние request-инъекции. Таблица `roles` позволяет добавлять и отключать базовые роли без server code change. Диалог C3, рабочий каталог, manual run и role chats показывают, что архитектура уже обслуживает реальные сценарии, а не только миграцию данных.

**Главное ограничение.** Внутрипроцессный запуск сам по себе не образует надёжную систему исполнения. Пока запуск появляется как подавляемый background side effect после state change, delivery, deduplication, cancellation, timeout, concurrency, audit и recovery определяются памятью одного Node-процесса или вообще не определены. Если `tsx watch` допустимо обрывает запуск по решению владельца, это может быть временным эксплуатационным допущением, но не отменяет потребности явно маркировать и восстанавливать незавершённые runs.

**Контрактные расхождения.** План обещает единое действие над ролью, включая model. Код реализует несколько независимых ресурсов: `roles` в SQLite, routing в YAML, effective prompt из БД/файла, legacy permissions в users. Это препятствует консистентному UI, откату, аудиту и конкурирующему редактированию. Нужен либо один транзакционный API агрегата, либо чётко versioned separate resources с idempotency, revision и явным progress/error UX.

## Риски, упорядоченные по приоритету

| Приоритет | Риск | Основание и возможное последствие |
|---|---|---|
| **P0 — блокирует merge** | Forgeable системная authority | `POST /api/roles` принимает `owner`; созданный `role_owner` получил owner-only mutation. Возможна подделка privileged/internal identities и неясная граница полномочий. |
| **P1** | Двойной или потерянный run | `activeRuns` проверяется до нескольких `await`, map заполняется позднее; два kick могут пройти одновременно. `void kickRoleTask` после коммита теряется при crash/error, retry нет. |
| **P1** | Отсутствие lifecycle control | Нет wall-clock timeout, durable cancellation, lease, межпроцессной очереди, capacity limit или restart recovery. Отключение роли не определяет судьбу уже начатого run. |
| **P1** | Неясный UX чат-ответа | Сообщение сохраняется, но failure/no-target/disabled/empty reply не становятся статусом для iOS; пользователь видит тишину и не знает, ждать ли или повторять. |
| **P2** | Расхождение источников роли | DB, YAML, prompt files, users permissions, embeddings, catalog и static UI maps могут показывать разные имя, модель, статус или возможности. |
| **P2** | Неготовые migration/operations | 056/057 forward-only, нет rollback/backup/upgrade acceptance, audit trail role CRUD, метрик run lifecycle, cost accounting и alerting. |
| **P2** | Совместимость клиентов | Static seven-role assumptions и отсутствие API capability/version negotiation приводят к decode/route failures на старом server либо ложному UI. |
| **P2** | Красные инженерные gates | Server и web TypeScript builds падают; full server suite не зелёный; root lockfile не воспроизводится через обычный `npm ci`. |

## Приоритетный следующий шаг

**Немедленно заблокировать merge и исправить P0 до любой новой UI или C4-работы.** Нужно зарезервировать/отвергать как минимум `owner`, `viewer`, `agent`, `orchestrator` и все legacy/internal identity keys; запретить вывод authority из произвольного role key; установить DB-инварианты связи role↔AI-account; добавить негативные tests создания каждого reserved key и проверки JWT/API escalation. До исправления не следует выполнять live C3 с включением системы и тем более выпускать динамическое создание ролей владельцу.

После P0 следующий инженерный gate — **зафиксировать durable orchestration contract**: job/outbox в транзакции с изменением task state, idempotency, unique active lease, recovery после рестарта, retry/backoff/dead-letter, cancellation/timeout и лимит мощности. Затем можно провести разрешённую владельцем C3-живую пробу и удалить тестовую карточку. Только после нескольких стабильных дней и подтверждённого отсутствия consumers для `startRun` допустима обратимая C4-уборка секретов/профилей/шага A с явным согласием владельца.

Веб-Team CRUD и iOS model flow должны следовать после согласования единого contract роли, а не предварять его. Перед merge нужно также восстановить зелёные server/web build gates, проверить migrations на upgrade DB и выполнить iOS build/test на macOS.

## Итоговый вердикт

**Не готово к merge.** Существующий код подтверждает жизнеспособность основного server-first направления, но не готовность к завершению миграции: есть воспроизводимый P0 authority escalation, недетерминированная доставка запусков, красные сборки, неполный web, нецелостное управление model на iOS, не выполненная C4 и неподтверждённые live claims. Правильный статус — **частично реализованная концепция с качественным ядром, требующая security и orchestration stabilization до расширения функциональности**.

## References

[1]: https://git.mizernyukmy.netcraze.pro/maksim/taskflow-server "TaskFlow server repository"
[2]: https://git.mizernyukmy.netcraze.pro/maksim/taskflow-native-ios "TaskFlow native iOS repository"
