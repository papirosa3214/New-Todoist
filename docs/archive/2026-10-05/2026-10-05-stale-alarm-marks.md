# Пометки: что в коде всё ещё описывает снятую схему «будильник trigger.py»

**Дата:** 05.10.2026. **Статус:** только пометки, код НЕ менялся. Этот список составил слабый агент без доверия — каждое место нужно перепроверить по живому коду перед правкой.

Что снято 05.10.2026: служба `taskflow-trigger` и скрипты `trigger.py`, `scheduler.py` и др. (копия — `~/Проекты/Архив/New-Todoist-trigger-2026-10-05/`). Роли исполняются внутри сервера.

## Места, где это НЕ просто комментарий (поведение или видимый текст)

- `server/src/index.ts:446-460` — проверка состояния сервера всё ещё опрашивает `systemctl --user is-active taskflow-trigger.service` (служба не существует).
- `server/src/routes/agent-service.ts:17-24` — `unitState()` теперь = режим приёма владельца (`automatic`), а в комментариях и именах (`alarmOn`, «будильник жив» в `routes/dispatch.ts:500,650,750`) он всё ещё назван «будильником». Имена и смысл разошлись.
- `src/components/TaskJournal.tsx:536` — текст для владельца: «будильник поднимет её заново».
- `src/screens/AgentsScreen.tsx:39-76,325` — на экране показывается строка `Pi-агент · --mcp-config ~/.pi/agent/taskflow-profiles/<роль>.json` (старая команда запуска).
- `src/api/agents.ts:57-78`, `src/api/server.ts:21`, `src/screens/SettingsScreen.tsx:295` — лампа «будильник» в настройках.
- `server/src/runtime/inProcessRun.ts:174` — исследовательские инструменты роли берут ключ из хранилища (`TASKFLOW_AGENT_TOKEN_RESEARCHER`), хотя остальные роли ходят без постоянных ключей.
- `server/scripts/seed-role-accounts.ts` — шапка и логика про токены ролей из хранилища (токены необязательные, сам скрипт заводит учётки ролей и нужен).

## Что проверено как ЖИВОЕ (не трогать, аудит от 05.10.2026 это ошибочно считал мёртвым или спорным)

- `server/scripts/graft_refresh.py`, `graft_refresh_watch.py` — таймеры `graft-refresh`, `graft-refresh-watch` активны.
- `~/.pi/agent/taskflow-profiles/<роль>.json` — серверный код (`roleRunAccess.ts`, `roles.ts`, `PiRuntimeAdapter.ts`, `roleContextResolver.ts`) читает из них список инструментов роли. Остался файл `synthesizer.json` для снятой роли.
- `server/scripts/mcp_server.py`, `issue-agent-token.ts`, `taskflow-mcp-net.service` — внешний MCP для Claude/Hermes/DeepSeek-Agent и ролевых чатов (`~/taskflow/roles/<роль>/scripts/mcp_server.py`, временный пропуск на 12 ч).
- `runtime/scheduler.ts` и `scheduler_watch.py` с таймером — живой планировщик.

## Не вычищено намеренно

- `server/scripts/dispatch_registry.md` — реестр «будильника», сам помечает trigger как архивируемый; не тронут.
- `server/scripts/role-routing.yaml` — по нему описано в `docs/current/README.md`, что модель роли пока выбирается там.
- `server/src/migrations.ts:970,1447` — тексты миграций, историю не правим.

## Все совпадения по шаблону (комментарии и строки)

- `server/src/lib/attemptLadder.ts:42` — * вычисляется отдельно (тесты / next_step_for в trigger.py).
- `server/src/lib/roleContextResolver.ts:135` — originRef: "~/.pi/agent/taskflow-profiles/<role>.json",
- `server/src/lib/roleContextResolver.ts:314` — : path.join(process.env.HOME ?? ".", ".pi", "agent", "taskflow-profiles");
- `server/src/lib/consultationTriggers.ts:4` — // для записи. Триггерную логику (когда срабатывает) считает trigger.py
- `server/src/lib/consultationTriggers.ts:35` — /** Кто сигнализирует (агент/trigger.py). null = системный (на будущее). */
- `server/src/index.ts:311` — // Агенты и служба-будильник (taskflow-trigger) бьют по /api/tasks и
- `server/src/index.ts:407` — // сколько работает, на каком коде, велика ли база, идёт ли будильник.
- `server/src/index.ts:446` — // Будильник — отдельная служба (taskflow-trigger.service): это она
- `server/src/index.ts:452` — ["--user", "is-active", "taskflow-trigger.service"],
- `server/src/routes/agent-inbox.ts:17` — // устаревшее тихо уходит в blocked. Триггер (trigger.py) вызывает тот же
- `server/src/routes/consultation.ts:18` — // оказаться в DSH_MODEL_ALIASES у trigger.py и вернуться через
- `server/src/routes/consultation.ts:36` — // ANTIGRAVITY_MODEL_ALIASES в trigger.py (там длинные имена) и с
- `server/src/routes/consultation.ts:361` — // 1.2, 1.2.7 (R7). trigger.py зовёт это после каждого действия агента,
- `server/src/routes/dispatch.ts:21` — //      оба шва доставки должны сработать, иначе будильник задачу не
- `server/src/routes/dispatch.ts:22` — //      увидит (см. AGENT-PROTOCOL.md и логику trigger.py:
- `server/src/routes/dispatch.ts:241` — // actorId — по нему будильник ловит назначение.
- `server/src/routes/dispatch.ts:360` — // Notification — основной шов, через него будильник ловит назначение.
- `server/src/routes/dispatch.ts:650` — // Раздача (проставление исполнителя) — только когда будильник жив:
- `server/src/routes/dispatch.ts:750` — // будильнике (назначать агента, которого некому разбудить, незачем).
- `server/src/routes/chat.ts:53` — // Будильник для резидента Гермеса (27-28.08.2026, подзадача «Сторона
- `server/src/routes/chat.ts:356` — // названа. Уведомление с task_id — это команда будильнику: trigger.py
- `server/src/routes/agent-state.ts:58` — * claim/launch_agent из trigger.py (см. taskflow-pipeline-head-plan.md,
- `server/src/routes/agent-state.ts:115` — // GET /api/agent/attempt-policies — для trigger.py, чтобы он мог построить
- `server/src/routes/agent-state.ts:175` — // По этой же нити его теперь будит и будильник.
- `server/src/routes/agent-state.ts:228` — // отпускает: напоминать о нём — дело доски и будильника, а не
- `server/src/routes/agent-state.ts:730` — // Сервисная дверь для trigger.py: при state=blocked сервисный
- `server/src/routes/agent-state.ts:971` — // когда она нужнее всего: будильник переставал понимать, куда
- `server/src/routes/agent-state.ts:1236` — // и именно ТОТ маршрут будит будильник (taskflow-trigger слушает
- `server/src/routes/agent-state.ts:1237` — // строго notification:new, см. trigger.py::_on_message). У этой
- `server/src/routes/agent-state.ts:1239` — // будильник не просыпался ни разу, задача просто зависала «в работе»
- `server/src/routes/projects.ts:607` — // их id зашиты в server/scripts/trigger.py (EXTERNAL_AGENTS) и в базовых
- `server/src/routes/manual-run.ts:15` — // Служба-будильник может быть выключена: это ОТДЕЛЬНЫЙ одиночный заход,
- `server/src/routes/manual-run.ts:67` — // Служебная запись будильника в ленту: он будит агентов в обход сервера,
- `server/src/routes/activity.ts:571` — // Claude Code и служба-будильник. У остальных исполнителей хука нет
- `server/src/routes/activity.ts:572` — // вовсе, а с выключенным будильником пинга не было ни у кого — и
- `server/src/routes/roles.ts:29` — path.join(process.env.HOME ?? ".", ".pi", "agent", "taskflow-profiles"),
- `server/src/routes/agent-service.ts:32` — *  воркер живёт независимо от будильника и делает расписание и повторы. */
- `server/src/routes/agent-service.ts:112` — // заход (scripts/scheduler.py, ветка 6). Отметка делает выборку
- `server/src/migrations.ts:970` — "Карточка 5f292e87 (шаг «прозрачный журнал и реестр будильника»). Читаемый реестр диспетчеризации в режиме наблюдения: источник, условие/команда (trig
- `server/src/migrations.ts:1447` — //     dispatched_role. Так Pi runtime и будильник читают одну и ту же
- `server/src/runtime/inProcessRun.ts:135` — * внешний MCP-профиль (`~/.pi/agent/taskflow-profiles/researcher.json`,
- `server/src/runtime/inProcessRun.ts:557` — /** Репозиторий проекта карточки — из того же файла, что читал будильник
- `server/src/runtime/inProcessRun.ts:1003` — // Те же решения, что принимал будильник (trigger.py → decide), но в сервере:
- `server/src/runtime/inProcessRun.ts:1004` — // он и так видит каждое изменение карточки. Будильник с флагом
- `server/src/runtime/PiRuntimeAdapter.ts:65` — ?? path.join(process.env.HOME ?? ".", ".pi", "agent", "taskflow-profiles");
- `server/src/runtime/scheduler.ts:2` — // внутри системы всё делает?»). Раньше это был scripts/scheduler.py на
- `server/src/runtime/scheduler.ts:4` — // а запуски по расписанию поднимал через manual_run.sh → trigger.py с
- `server/src/runtime/scheduler.ts:54` — /** Роль карточки и подъём её внутри сервера — вместо manual_run.sh --once. */
- `server/src/runtime/scheduler.ts:78` — // ── Ветки — один в один со scripts/scheduler.py ─────────────────────────
- `server/src/runtime/scheduler.ts:173` — *  старом scripts/scheduler.py эта ветка ни разу ничего не запускала.
- `server/src/runtime/roleRunAccess.ts:16` — * будильника и свой файл подключения. Теперь запуск делает сам сервер: он
- `server/src/runtime/roleRunAccess.ts:32` — const PROFILES_DIR = path.join(os.homedir(), ".pi", "agent", "taskflow-profiles");
- `server/src/runtime/types.ts:2` — // users, role-routing.yaml, role-prompts/, vault, taskflow-profiles/.
- `server/src/agentState.ts:10` — // исполнителя надо видеть быстро, а не через четверть часа. Служба-будильник
- `server/src/agentState.ts:318` — * заблокированный шаг поднимет задачу в blocked, а будильник такие обходит
- `server/src/roleRouting.ts:125` — *  trigger.py и roleRouting трактуют оба имени одинаково. */
- `server/src/roleRouting.ts:210` — *  server/scripts/trigger.py, server/test/roles.test.ts и server/src/routes/roles.ts
- `server/src/auth.ts:50` — // ниже не трогаем: им ходят службы трекера (taskflow-trigger).
- `src/api/agents.ts:57` — /** Состояние службы-будильника: включён ли автономный режим. */
- `src/api/agents.ts:63` — /** Когда будильник в последний раз отметился живым (ISO), null — не отмечался. */
- `src/api/agents.ts:70` — *  живёт вне будильника, делает запуск по времени и отложенные повторы. */
- `src/api/agents.ts:78` — // Автономный режим = служба-будильник. Включена — назначенную задачу
- `src/api/tasks.ts:218` — // Служба-будильник при этом может быть выключена: это одиночный заход, а не
- `src/api/server.ts:21` — /** active | inactive | failed | unknown — служба будильника. */
- `src/components/TaskFields.tsx:241` — // Ввод — БАРАБАНОМ, как в будильнике iPhone (просьба владельца
- `src/components/TaskJournal.tsx:69` — // (`claude --resume <session-id>`, тот же флаг, каким сам будильник
- `src/components/TaskJournal.tsx:70` — // TaskFlow продолжает свою сессию — server/scripts/trigger.py). Копируется
- `src/components/TaskJournal.tsx:337` — // одному — задача снова доступна, будильник тут же поднимает её, и берёт
- `src/components/TaskJournal.tsx:348` — // комментарий. Будильник (taskflow-trigger) просыпается по уведомлению о
- `src/components/TaskJournal.tsx:369` — //    смысла нет — задачу надо ОСВОБОДИТЬ, чтобы будильник поднял её
- `src/components/TaskJournal.tsx:374` — // handleAnswer, и по той же причине: будильник просыпается по
- `src/components/TaskJournal.tsx:536` — ? "Задача освободится, а ваш комментарий станет заданием: будильник поднимет её заново."
- `src/screens/SettingsScreen.tsx:295` — * сколько уже, на каком коде, велика ли база, идёт ли будильник. Никаких
- `src/screens/AgentsScreen.tsx:39` — invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/researcher.json",
- `src/screens/AgentsScreen.tsx:45` — invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/analyst.json",
- `src/screens/AgentsScreen.tsx:52` — "--mcp-config ~/.pi/agent/taskflow-profiles/critic_verifier.json",
- `src/screens/AgentsScreen.tsx:58` — invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/architect.json",
- `src/screens/AgentsScreen.tsx:64` — invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/builder.json",
- `src/screens/AgentsScreen.tsx:70` — invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/qa.json",
- `src/screens/AgentsScreen.tsx:76` — invocation: "--mcp-config ~/.pi/agent/taskflow-profiles/designer.json",
