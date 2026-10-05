# Аудит сервера TaskFlow: противоречия, устаревшая логика, мёртвый код

**Карточка:** ad4a56a9-7a10-4b3c-9c08-9df44ad67e09 (Linear MAK-57)
**Дата:** 2026-10-05
**Метод:** чтение сервера TaskFlow (server/src, server/scripts, systemd-юниты, документы INDEX/AGENT-PROTOCOL/STATUS/DISPATCH) + grep-разведка. Код не менялся.
**Сырые находки с файл:строка:** `/home/maksim/taskflow/roles/researcher/workspace/ad4a56a9/findings.md` (24 пункта).
**Документ:** карта по областям + вопросы владельцу. На каждую запись есть `файл:строка` и проверка (grep/SQL).

---

## Резюме

Сервер живёт в режиме «работает, но рассыпается»: каждое архитектурное решение дублируется в нескольких местах (каталог профилей + role-routing + PROFILE_ROLE, db.ts-инлайн + версионные миграции, auth.ts + access.ts), а отменённые сущности (Pi Agent, автономный оркестратор, claude_bot, native/, Kaneo, sync-build) оставляют после себя код, комментарии и `.service`-файлы, которые продолжают ссылаться на архивные учётки. Термин «оркестратор» используется в трёх разных смыслах в одном проекте. Источник истины для ролей не объявлен.

Главные риски:

1. **Мина в systemd-юнитах.** `taskflow-trigger.service` с `Restart=always` использует `TASKFLOW_PI_AGENT_TOKEN` (учётка архивирована миграцией 040). Юнит `inactive dead`, но если кто-то однажды `systemctl --user enable --now` — поведение неопределённое.
2. **Терминологический туман.** «Оркестратор» означает три разные вещи в `tasks.ts:1246`, `agent-service.ts:159` и `team_catalog.json:13-21`. При добавлении новой роли легко зацепить чужое правило.
3. **Двухслойная маршрутизация.** Чат идёт через `team_catalog.json` (старый путь), диспетчер задач — через `role-routing.yaml` (новый путь). Расхождение в адресатах.
4. **Расхождение в `db.ts` ↔ `migrations.ts`.** Колонки добавляются и в `migrate()` инлайном, и в `migrations.ts` версионно. Двойной аудит, риск рассинхрона.

---

## Область 1. Права и протокол (access.ts, роли, маршрутизация)

| № | Область | файл:строка | Что не так | Почему важно | Предложение | Риск правки |
|---|---------|-------------|------------|--------------|-------------|-------------|
| 1.1 | Права | `server/src/routes/tasks.ts:1246` + `routes/agent-service.ts:159-180` | «Автономный оркестратор» отменён 08.09.2026, но `role='orchestrator'` имеет доступ к тумблеру автономки через `isOwner\|\|isOrchestrator`. | Термин «оркестратор» в tasks.ts — отменённая функция, в agent-service.ts — живая роль. Два смысла, один комментарий, легко спутать. | В шапке `access.ts` явно зафиксировать: «роль `orchestrator` = диспетчер L4, не путать с автономным оркестратором, который отменён 08.09.2026». См. вопрос 1. | Низкий (правка комментария). |
| 1.2 | Права | `server/src/routes/tasks.ts:1238-1256` vs `auth.ts` vs `agent-service.ts:173-175` | Закрытие/удаление: только owner. Тумблер автономки: owner\|\|orchestrator. Правила раскиданы по preHandler'ам. | Нет единой матрицы прав — при добавлении роута легко разрешить лишнее. | Свести в одну таблицу в `AGENT-PROTOCOL.md` (роль × действие). | Низкий. |
| 1.3 | Права | `server/src/access.ts:88` + `:347-356` vs `server/src/auth.ts` | Правило «оркестратор не удаляет» enforce'ится в двух местах (auth.ts + комментарий access.ts). | Если ослабить в auth.ts, access.ts сам по себе не остановит. | Закрепить правило в одном месте; из access.ts убрать комментарий-страховку. | Низкий. |
| 1.4 | Маршрутизация | `server/scripts/team_catalog.json` + `server/src/routes/agent-inbox.ts:27,34-38,64,67` + `routes/chat.ts:42,633` vs `server/scripts/role-routing.yaml` + `server/src/roleRouting.ts:136,212` + `routes/dispatch.ts:49-70,80-180` | Чат идёт через старый путь (catalog → user), диспетчер — через новый (yaml → role). | Один текст «подобрать исполнителя» решается двумя разными путями. | Выбрать единственный источник (см. вопрос 2). | Средний (затрагивает диспетчер). |
| 1.5 | Устаревшее | `server/src/access.ts:70` + `server/src/migrations.ts:1640` + `server/src/routes/dispatch.ts:50` | `pi_agent: "Builder"` в `PROFILE_ROLE`, хотя Pi Agent архивирован миграцией 040. | Если завтра в `team_catalog.json` вернётся профиль `pi_agent`, он получит права Builder без отдельной проверки. | Удалить строку из `PROFILE_ROLE` (см. вопрос 6). | Низкий. |
| 1.6 | Устаревшее | `server/scripts/team_catalog.json:22-30` + `server/src/migrations.ts:1630-1665` | `claude_bot` (u2) жив в каталоге с `auto_route: true`, но архивирован миграцией 040. | Расхождение двух источников истины. Маршрутизация чата может уйти в архивную учётку. | Удалить `claude_bot` из каталога (см. вопрос 5). | Низкий. |
| 1.7 | Права | `server/src/db.ts:203` | Безусловный `UPDATE users SET is_system_bot=1 WHERE id IN ('u2','u3')` на каждом старте. | u2/u3 = `archived=1, is_system_bot=1`. Если код будет ориентироваться только на `is_system_bot`, покажет заархивированных ботов. | Добавить `AND archived = 0` или убрать инлайн, оставить в `seed.ts`/миграциях. | Низкий. |
| 1.8 | Права | `server/src/routes/chat.ts:170-180` | `orchestratorId()` ищет `role='orchestrator'` без фильтра `archived=0`. | Если роль когда-то деактивируют, broadcast'ы продолжат идти. | Добавить `AND archived = 0`. | Низкий. |

**Проверка для области:** `grep -n "orchestrator\|isOrchestrator\|isOwner" server/src/routes/*.ts`; `grep -rn "team_catalog\|role-routing\|PROFILE_ROLE" server/src/ server/scripts/`.

---

## Область 2. Маршруты API (роуты, preHandler, обработка ошибок)

| № | Область | файл:строка | Что не так | Почему важно | Предложение | Риск правки |
|---|---------|-------------|------------|--------------|-------------|-------------|
| 2.1 | Маршрут | `server/src/routes/agent-inbox.ts:34-38` | `loadCatalog()` при ошибке чтения JSON молча возвращает пустой объект. | Если `team_catalog.json` испортится, маршрутизация молча сломается без лога. | Добавить `console.warn` (как в `db.ts:464`). | Низкий. |
| 2.2 | Маршрут | `server/src/routes/agent-inbox.ts:51-56` | Поиск адресата по подстроке title «оркестратор/диспетчер» — старый путь, идёт в обход 8-ролевой матрицы. | Дублирует новый `pickRole` (dispatch.ts:80-180). | См. п. 1.4 и вопрос 2. | Средний. |
| 2.3 | Маршрут | `server/src/routes/chat.ts:633` | `if (taskId && toUserId && routed.channel === "agents")` — узкая проверка, литерал строки. | При переименовании `channel` молча перестанет срабатывать. | Вынести `const AGENT_CHANNEL = "agents"` в константу. | Низкий. |
| 2.4 | Мёртвый код | `server/src/routes/activity.ts:519` | Функция таймера слоя 3 без явной регистрации в `index.ts`. | Если функция не вызывается — таймер не запускается. | `grep -n "startActivityLayer3\|registerActivityRoutes" server/src/routes/activity.ts server/src/index.ts`; если вызова нет — удалить. | Низкий. |
| 2.5 | Маршрут | `server/src/lib/secretaryTaskSummary.ts:130` + `server/src/migrations.ts:1544,2337,3071-3072` + `server/src/db.ts:203` | Захардкожены `u1`, `u-secretary`, `u2`, `u3`. | Если id пользователей сменят, эти места упадут. | Ввести `getSecretaryId()`, `getOwnerId()` (миграция `SECRETARY_USER_ID`). | Низкий. |
| 2.6 | Маршрут | `server/src/routes/agent-service.ts:159-180` | `isOwner\|\|isOrchestrator` пускает оркестратора в тумблер автономки. | Согласовано с владельцем 11.09.2026 (b6b57092), но в `tasks.ts:1246` про «оркестратор» сказано иное — нужна явная запись (см. п. 1.1). | См. п. 1.1. | Низкий. |

**Проверка для области:** `grep -n "loadCatalog\|routeAddressee\|channel === \"agents\"" server/src/routes/`.

---

## Область 3. База и миграции (db.ts, migrations.ts, schema_migrations)

| № | Область | файл:строка | Что не так | Почему важно | Предложение | Риск правки |
|---|---------|-------------|------------|--------------|-------------|-------------|
| 3.1 | Миграции | `server/src/migrations.ts:189-432` (`db.ts`) + `:431-…` (массив `migrations`) | Колонки добавляются и инлайном в `db.ts:migrate()`, и версионно в `migrations.ts`. | Двойной код, двойной аудит. `migrations.ts:1-9` явно говорит «переписывать не стали» — это осознанное решение, но не зафиксировано в одном месте. | Решить: либо версионировать всё в `migrations.ts`, либо явно описать «инлайн = идемпотентные довески». | Высокий (может сломать существующие БД). |
| 3.2 | Миграции | `server/src/migrations.ts:2784` (`084_role_composio`) + `:2894` (`084_task_hierarchy_one_level`) | Два объекта с одинаковым префиксом `084_` ломают соглашение «номер = порядок». | На живой базе работает (id разные). На свежей — нумерация врёт, а будущее переименование рискованно. | Переименовать второй в `087_a_task_hierarchy_one_level` (см. вопрос 4). | Низкий. |
| 3.3 | Устаревшее | `server/src/migrations.ts:3151-3166` (id `099_drop_agent_message_length_triggers`) | Комментарий ссылается на `lib/agentVisibleText.ts` — файл удалён. | Если файл удалён чисто, комментарий — мусор. Если остались 5 мест применения, они падают. | `find server/src -name "agentVisibleText*"`; `grep -rn "agentVisibleText" server/src/`. | Низкий. |
| 3.4 | Устаревшее | `server/src/migrations.ts:1630-1665` (id `040_archive_old_agents`) | Массив `legacyIds` архивирует u2/u3, но `db.ts:203` безусловно переустанавливает `is_system_bot=1` для них же. | Семантически спорное состояние `archived=1, is_system_bot=1`. | См. п. 1.7. | Низкий. |
| 3.5 | Дубли | `server/src/db.ts:189-432` (ALTER TABLE) vs `server/src/migrations.ts:431-…` (версионные) | См. п. 3.1. | Дублирование. | См. п. 3.1. | Высокий. |

**Проверка для области:** `grep -nE "ADD COLUMN" server/src/db.ts | wc -l`; `grep -nE "ADD COLUMN" server/src/migrations.ts | wc -l`; `sqlite3 server/taskflow.db "SELECT id FROM schema_migrations WHERE id LIKE '084%'"`.

---

## Область 4. Скрипты, таймеры, службы (systemd, server/scripts, server/src)

| № | Область | файл:строка | Что не так | Почему важно | Предложение | Риск правки |
|---|---------|-------------|------------|--------------|-------------|-------------|
| 4.1 | Служба | `~/.config/systemd/user/taskflow-trigger.service` | `ExecStart=… trigger.py` с `Restart=always`, `Environment=TASKFLOW_TOKEN=TASKFLOW_PI_AGENT_TOKEN`. | Учётка Pi Agent архивирована (миграция 040). Юнит `inactive dead`, но файл на диске. Если кто-то однажды `enable --now` — поведение неопределённое. | `mv taskflow-trigger.service taskflow-trigger.service.disabled-2026-10-05` + комментарий «выключено 22.09.2026». См. вопрос 3. | Низкий. |
| 4.2 | Служба | `~/.config/systemd/user/taskflow-scheduler.service` | Тот же `TASKFLOW_PI_AGENT_TOKEN`. | Та же мина: при включении служба притворится архивным пользователем. | Проверить, действительно ли scheduler использует Pi. Если да — заменить токен. | Низкий. |
| 4.3 | Свалка | `~/.config/systemd/user/taskflow-trigger.service.bak-26.08.2026` + `.bak-rolekeys-20260916-083747` + `.service.d/` (minimax.conf, roles-in-server.conf, .bak-rolekeys-…) | Три копии .service и три drop-in-папки рядом. | Если кто-то однажды `cp .bak-… .service`, никто не заметит. | Удалить `.bak-*` и неиспользуемые drop-in'ы. | Низкий. |
| 4.4 | Устаревшее | `server/scripts/team_catalog.json:91-95` | `_comment` про миграцию 040 утверждает, что «архивные профили удалены», но `claude_bot` не удалён. | Если править по комментарию, легко вернуть `pi_agent` обратно. | Удалить `claude_bot` (см. вопрос 5). | Низкий. |
| 4.5 | Документ | `server/scripts/dispatch_registry.md:1-90` | Реестр ссылается на `agent-inbox + trigger.py`, но trigger выключен. §6 прямо говорит: «Reviewer разрешил, но не сделано». | Половина реестра описывает несуществующий поток. | Пометить §6 как «в работе» или удалить. | Низкий. |
| 4.6 | Документ | `server/scripts/dispatch_registry.md:48` vs `server/src/routes/agent-inbox.ts:51-56` | Реестр: «ищем „оркестратор"». Код: «ищем „оркестратор" или „диспетчер"». | Расхождение документа и кода. | Обновить реестр. | Низкий. |
| 4.7 | Устаревшее | `server/src/env.ts:6` + `server/scripts/trigger.py:4,1144` + `server/scripts/reset-password.ts:5` | `Kaneo` упоминается в комментариях, но не помечено как устаревшее. | Контекст «переезжаем с Kaneo» — не баг. Но если есть `Kaneo_*` env-переменные — стоит проверить. | `grep -n "Kaneo" server/src/env.ts`. | Низкий. |

**Проверка для области:** `systemctl --user status taskflow-trigger.service taskflow-trigger-watch.{service,timer}`; `ls -la ~/.config/systemd/user/taskflow-trigger*`; `grep -rn "TASKFLOW_PI_AGENT_TOKEN" ~/.config/systemd/user/`.

---

## Область 5. Документы (AGENT-PROTOCOL.md, AGENT-API.md, INDEX.md, STATUS.md, архив)

| № | Область | файл:строка | Что не так | Почему важно | Предложение | Риск правки |
|---|---------|-------------|------------|--------------|-------------|-------------|
| 5.1 | Документ | `AGENT-PROTOCOL.md:355,403,607` | Ссылается на отмену оркестратора 08.09.2026, но в коде `role='orchestrator'` жив. | Читатель увидит «оркестратор отменён», а в коде — живая роль. См. п. 1.1. | Добавить фразу: «роль `orchestrator` (диспетчер L4) жива и не путать с автономным оркестратором, который отменён». | Низкий. |
| 5.2 | Архив | `docs/archive/2026-09-24-before-canonical/AGENT-MODELS.md:3-5` + `AGENTS-SETUP-GUIDE.md:3` + `AI-ASSISTANT-ARCHITECTURE.md:13,26-27` + `TASK-LIFECYCLE-SCENARIOS.md:47-49` + `handoffs/2026-09-23-…md` | Архив упоминает Antigravity/Hermes/Claude_Bot/«Будильник» как живые сущности. | Grep по проекту вытащит эти доки — кто-то решит, что они живые. | В `INDEX.md` добавить ссылку: «архив не источник истины, см. STATUS.md». | Низкий. |
| 5.3 | Документ | `INDEX.md:60` | Говорит, что `native/` удалён 08.09.2026. | OK, но в архивной доке `taskflow-direct-dispatch-mvp.md:47` всё ещё упоминается `native/scripts/sync-build.sh`. | См. п. 5.2. | Низкий. |
| 5.4 | Устаревшее | `server/src/routes/dispatch.ts:50` | «В системе нет никакого „Pi"» — но `access.ts:70` хранит `pi_agent: "Builder"`. | Если завтра вернут профиль `pi_agent` в каталог, `getRole` через `PROFILE_ROLE` даст «Builder» без отдельной проверки. | См. п. 1.5 и вопрос 6. | Низкий. |
| 5.5 | Устаревшее | `server/src/routes/roles.ts:266` | Комментарий «автономки. Служба стоит — исполнять роль некому…». | Согласуется с фактическим состоянием systemd. Если автономку включат — комментарий станет ложным. | Пока OK. | Нулевой. |

**Проверка для области:** `grep -rn "Antigravity\|Hermes\|Будильник\|sync-build" --include="*.md" --include="*.ts" --include="*.py" --include="*.sh"`.

---

## Сводка по областям

- **Права и протокол** — главный источник неопределённости. Термин «оркестратор» тройственный, матрица прав раскидана. Решается единой таблицей в `AGENT-PROTOCOL.md` (низкий риск).
- **Маршруты API** — хрупкость из-за silent fallback'а (loadCatalog), захардкоженных id, и расщеплённой маршрутизации. Решается выносом констант и фильтром `archived=0`.
- **База и миграции** — дубль между `db.ts` и `migrations.ts` (осознанный, но не зафиксирован), дубликат `084_*` (легко правится), ссылка на удалённый `agentVisibleText.ts` (надо подтвердить).
- **Скрипты/службы** — главная мина: `taskflow-trigger.service` с `Restart=always` и архивной учёткой. Решается `mv` в `.disabled` + удалением `.bak-*`.
- **Документы** — архив не помечен как «не источник истины», протокол противоречит коду про оркестратора.

---

## Вопросы владельцу

Эти шесть вопросов блокируют закрытие части находок. По каждому нужно явное решение, иначе аудит висит.

**Вопрос 1. Что такое «оркестратор» сегодня?**
- В `routes/tasks.ts:1246` — «автономный оркестратор» отменён 08.09.2026, не может закрывать задачи.
- В `routes/agent-service.ts:159` — `role='orchestrator'` имеет доступ к тумблеру автономки.
- В `team_catalog.json:13-21` — `orchestrator: auto_route: true` (L4, диспетчер).
- В `access.ts:103-107` — `isOrchestrator()`: `role==='orchestrator'`.
- Это один смысл (диспетчер L4, который маршрутизирует и дёргает тумблер) или два разных (диспетчер + автономщик, последний отменён)?
- Нужно зафиксировать в `access.ts` шапке.

**Вопрос 2. Какая система маршрутизации — единственная?**
- `team_catalog.json` (chat → пользователь по профилю) и `role-routing.yaml` (dispatch → роль). Сейчас живут параллельно.
- Если `role-routing.yaml` — переписать `agent-inbox.ts` и `chat.ts` на `pickRole`/`role-routing.yaml`.
- Если `team_catalog.json` — вычистить упоминания ролей из `access.ts`/`dispatch.ts` и переписать на профили.
- Третий вариант: оставить обе, но описать границы применения (chat = профили, dispatch = роли) и закрепить в INDEX.

**Вопрос 3. Удалять ли `taskflow-trigger.service` совсем?**
- Сейчас выключен (`inactive dead`), но `Restart=always` + `_PI_AGENT_TOKEN` (архивная учётка).
- Рекомендация: `mv taskflow-trigger.service taskflow-trigger.service.disabled-2026-10-05` + удалить `.bak-*` и `.service.d/`. Альтернатива: оставить как «архивный режим для расследования инцидентов», но явно переименовать и добавить комментарий.

**Вопрос 4. Переименовать ли `084_task_hierarchy_one_level`?**
- Дубликат `084_*` в `migrations.ts`. На живой базе работает, на свежей — нумерация врёт.
- Рекомендация: переименовать в `087_a_task_hierarchy_one_level` (или вставить перед `087_task_hierarchy_recursive`). Низкий риск: на живой базе ничего не сломается (в `schema_migrations` лежит старый id).

**Вопрос 5. Что делать с `team_catalog.json` после миграции 040?**
- В нём остался `claude_bot` (u2) — заархивирован. Комментарий `comment_for_040` утверждает, что «архивные удалены», а `claude_bot` не удалён.
- Варианты: (а) удалить `claude_bot` из каталога; (б) поправить комментарий («часть архивных удалена, часть оставлена для совместимости»). Рекомендация — (а).

**Вопрос 6. Можно ли убрать `pi_agent: "Builder"` из `PROFILE_ROLE`?**
- Pi Agent заархивирован (миграция 040), `dispatch.ts:50` говорит «Pi нет».
- Если маппинг не нужен — удалить. Если нужен «на всякий случай» — оставить, но добавить комментарий «архив, не активен, не добавлять профиль `pi_agent` в `team_catalog.json` без явного решения владельца».

---

## Что НЕ покрыто этим аудитом (для следующих шагов)

- 38 из 50 роутеров в `server/src/routes/` прочитаны grep-выжимками или фрагментами. Целиком прочитаны только `access.ts`, `db.ts`, `migrations.ts`, `agent-inbox.ts`, `chat.ts` (фрагменты), `tasks.ts` (вокруг 1246), `dispatch.ts` (фрагменты).
- `server/src/runtime/*` (39 файлов), `server/src/lib/*` (26 файлов), `server/src/roleRouting.ts`, `server/src/seed.ts` — не читались.
- Документы `AGENT-PROTOCOL.md`, `AGENT-API.md`, `INDEX.md`, `STATUS.md` — grep-выжимками, не целиком.
- Конкретные SQL-запросы в `migrations.ts` (3210 строк) — прочитаны выборочно, не построчно.
- Этот документ — карта проблем, не план правок. Следующий шаг: на основе ответов на 6 вопросов составить упорядоченный план по областям.

---

## Решения по вопросам (оркестратор, по поручению владельца, 05.10.2026)

1. **Оркестратор** — одна живая роль: диспетчер/контролёр команды (учётка «Оркестратор Claude»), утверждает планы, сидит в чатах задач. «Автономный оркестратор» отменён 08.09.2026 — его остатки убрать, термин в коде и документах использовать только в первом смысле.
2. **Маршрутизация** — единственный источник `role-routing.yaml` + `pickRole`. Чат и `agent-inbox` перевести на него; `team_catalog.json` вывести из маршрутизации ролей.
3. **`taskflow-trigger.service`** — выключить навсегда (переименовать в `.disabled-2026-10-05`), `.bak-*` и неиспользуемые drop-in убрать. Будить оркестратора будет новая отдельная служба.
4. **Дубликат `084_*`** — НЕ переименовывать: id хранится в `schema_migrations`, смена id заставит миграцию выполниться повторно на живой базе. Вместо этого — комментарий у второй миграции.
5. **`claude_bot` в `team_catalog.json`** — удалить.
6. **`pi_agent: "Builder"` в `PROFILE_ROLE`** — удалить.

---

# Часть 2 — runtime, lib, непрочитанные маршруты

**Карточка:** 541f23bb-75b1-41e4-88e3-cf1a3c971b48 (Linear MAK-64)
**Дата:** 2026-10-05
**Метод:** целиком прочитаны `server/src/runtime/*` (39 файлов), `server/src/lib/*` (26), `server/src/roleRouting.ts`, `server/src/seed.ts`, `routes/research.ts`, `routes/role-run-jobs.ts`, `routes/reports.ts`, `routes/subtask-artifacts.ts`, `routes/consultation.ts`, `routes/agent-inbox.ts` (узлы маршрутизации); узко прочитаны `routes/dispatch.ts:160-220, 750-820`, `routes/chat.ts:48-140` (узел Hermes-webhook), `routes/chat.ts:160-200` (`orchestratorId`), `routes/dispatch.ts:50-180` (комментарий «Pi нет»), `routes/agent-state.ts:60-200` (триггерные комментарии), `runtime/inProcessRun.ts:1000-1100` (триггер), `runtime/roleHome.ts:8-65` (валидация ключа роли), `runtime/roleWorkspace.ts` (worktree), `runtime/scheduler.ts:1-30` (заголовок); grep-разведка по всем файлам. Код не менялся.
**Сырые находки с файл:строка:** `/home/maksim/taskflow/roles/researcher/workspace/541f23bb/findings.md`.
**Документ:** Часть 1 — карта по областям 1–5 + вопросы; решения по ним уже приняты оркестратором. Эта часть продолжает карту по областям 6–10, **ничего из Части 1 не повторяется**.

## Резюме

Runtime-слой за эти полтора месяца (с 01.10.2026) перерос рамки, под которые писался. Главные риски:

1. **«Супер Секретарь» — частичная миграция, не закрытая.** Миграция 063 завела роль `secretary` в `roles` и `role_prompts`, но `u-secretary` (фиксированный id) обращается к Pi через ту же `startChatRun`; правка корректна только если нигде не осталась жёсткая `u-secretary` (а она осталась в `lib/secretaryReply.ts:35`, `lib/secretaryTaskSummary.ts:130`, `lib/ownerDraft.ts:47`).
2. **Двойной источник «архивного» сиротского кода.** `lib/aiClient.ts:70-100` хранит целую ветку «Hermes / OpenRouter / antigravity» с актуальным fallback-сообщением; учётки u2/u3 давно архивированы миграцией 040 (Часть 1, п. 3.4). Та же история — `PROFILE_ROLE: claude_bot/hermes/antigravity/pi_agent` в `access.ts:66-72`.
3. **Захардкоженный id владельца `u1`.** `lib/inboxTriageWatcher.ts:37` (env + fallback `u1`), `lib/inboxResultsWriter.ts:358,360` (строковый литерал). Миграция 040 развела владельца и архив, но код триажа всё ещё полагается на конкретный id — это и есть тот случай, когда «сегодня сработало, завтра сломалось».
4. **Тонкая плёнка совместимости с `team_catalog.json` всё ещё стоит.** `routes/agent-inbox.ts:25-40` загружает `team_catalog.json` с тихим fallback'ом в пустой объект (`loadCatalog()`); в каталоге сидит `claude_bot` (Часть 1, п. 1.6) и запись `_comment`, которая утверждает обратное.
5. **Решения оркестратора по Части 1 не проведены сквозь код, и в коде теперь расхождение.** Шесть решений (Часть 1, внизу) предполагают, в частности, удаление `pi_agent: "Builder"` из `PROFILE_ROLE` и удаление `claude_bot` из `team_catalog.json`. `access.ts:70` и `agent-inbox.ts:51-56` (см. также `team_catalog.json:91-95`) ещё хранят их, и `getRole()` молча отдаст «Builder» учётке, если в `team_catalog.json` снова появится профиль `pi_agent`.
6. **`synthesizer.md` — призрак в `role-prompts/`.** Есть файл `server/scripts/role-prompts/synthesizer.md`, в `DEFAULT_ROLES` (roleRouting.ts:34-42) и `LAYER_CATALOG` его нет, `ROLE_NAMES.includes("synthesizer")` вернёт `false`. Если роль когда-то снимали осознанно — это наследие; если нет — баг миграции 056.

## Область 6. Runtime-слой (inProcessRun, scheduler, roleWorkspace, autoPreparation, planSubtaskAdmission, planReviewLifecycle, branchPlan, planMutations, slotWorkSnapshot, roleRunQueue/Worker, chatSession, chatLiveTurn, chatTools, AuthSession, roleRunAccess, chatWorkMode, instructionDefaults/Resources, dependencyContext, collaborationPlanContext, taskExecutionState, taskContextVersion, errors, RuntimeAdapter, chatConversation, roleHome, types, secretaryVoiceBridge, builderXcode, composioPolicy/Runtime, linearTransport, PiRuntimeAdapter)

| № | Область | файл:строка | Что не так | Почему важно | Предложение | Риск правки |
|---|---------|-------------|------------|--------------|-------------|-------------|
| 6.1 | Runtime | `server/src/runtime/inProcessRun.ts:1003-1005` (комментарий) и `server/src/runtime/scheduler.ts:1-30` | `inProcessRun.ts` хранит заголовок «Те же решения, что принимал будильник (trigger.py → decide)». Сам `scripts/trigger.py` всё ещё на диске (см. `server/scripts/trigger.py`, `manual_run.sh`, `scheduler.py`, `graft_refresh*.py`, `chat_resident_watch.py`); `routes/agent-state.ts:60-200, 730, 1237` и `routes/dispatch.ts:22` ссылаются на него как на действующий модуль. | Документация говорит «будильник отменён», код — «будильник рядом». Если смотреть на комментарий, отключаешь одно, а потом вторая нога идёт через `systemd`/cron и продолжает то же самое. | Удалить `server/scripts/{trigger.py,manual_run.sh,graft_refresh*.py,fix_clean_trigger.py,patch_trigger_fix.py}` после того, как подтверждено, что `runtime/inProcessRun.ts:kickRoleTaskStrict` и `runtime/scheduler.ts:startScheduler` поднимают всё нужное; обновить комментарии в `agent-state.ts`, `dispatch.ts`, `agent-inbox.ts`, `agent-service.ts:112`. | Низкий (код в живом сервере уже всё делает сам). |
| 6.2 | Runtime | `server/src/runtime/roleHome.ts:23` | `if (!/^[a-z][a-z0-9_-]{1,31}$/.test(role)) throw new Error("недопустимый ключ роли");` — старая, узкая проверка. `synthesizer.md` лежит в `scripts/role-prompts/` и формально проходит (но не зарегистрирован). | Не критично, но `importRoleResources` в `roleHome.ts:130-150` копирует все `prompts`/`skills` без сверки с `ROLE_NAMES`. Если кто-то создаст папку `roles/synthesizer/`, она приживётся мимо `roles`-таблицы. | Либо добавить `synthesizer` в `DEFAULT_ROLES`, либо удалить `server/scripts/role-prompts/synthesizer.md`. | Низкий. |
| 6.3 | Runtime | `server/src/runtime/roleWorkspace.ts:50-58` (worktree) и `server/src/runtime/inProcessRun.ts:550-560` (контекст) | И `roleWorkspace`, и `inProcessRun` используют `path.resolve(process.cwd(), "..")` для определения корня репозитория. `cwd` в `tsx watch` — `server/`, родитель — `TaskFlow/`. | Два независимых «угадывания» корня репозитория рассинхронизируются, если меняется способ запуска (uvicorn снаружи, server в подкаталоге). | Вынести в один helper `liveServerRepo()` (он уже есть в `roleWorkspace.ts:19`) и переиспользовать. | Низкий. |
| 6.4 | Runtime | `server/src/runtime/roleRunAccess.ts:60-100` (`CHAT_TOOLS` и `withChatTools`) + `chatWorkMode.ts:8-22` (`PLANNING_TOOLS`) | `taskflow_weather` и `taskflow_plan_request` добавляются ко ВСЕМ ролям принудительно. **Поправка после grep-верификации (05.10.2026):** в `PLANNING_TOOLS` (`chatWorkMode.ts:8-22`) `taskflow_plan_request` НЕ перечислен — фильтр на `roleRunAccess.ts:86` его отсекает в режиме `plan`. То есть текущее поведение корректно: в режиме планирования роль не может дёргать `add_step`, только читать и обсуждать. | В исходной формулировке находка была ложной — PLANNING_TOOLS фильтр уже исключает `taskflow_plan_request`, поэтому конфликта с инструкцией режима `plan` нет. | Снять как ошибочную; оставить комментарий в `roleRunAccess.ts`, что фильтр намеренный (чтобы будущий правщик не «починил» обратно). | Низкий. |
| 6.5 | Runtime | `server/src/runtime/roleRunQueue.ts:99-101` (claim) | `WHERE candidate.status IN ('queued', 'retry_wait') AND NOT EXISTS (SELECT 1 FROM role_run_jobs AS active WHERE active.task_id = candidate.task_id AND active.status = 'running')` — это правильная блокировка «по одному живому job на задачу», но **прочеркнута одна гонка**: между `claim()` и `processOneRoleRunJob` есть окно, в котором новый `enqueueRoleRunJob` для той же задачи вставит запись. Эта запись успешно пройдёт (нет running job — он ещё в claim), но потом `running` появится и следующий tick не снимет. | На живой базе пока не наблюдается, потому что `enqueueRoleRunJob` ходят через те же транзакции, что и `claim`. Но если в будущем кто-то начнёт enqueue из горячего пути, появится дубль. | Зафиксировать комментарием: «enqueue должен идти внутри той же транзакции, что и смена состояния карточки, иначе появится скрытая пара». | Низкий. |
| 6.6 | Runtime | `server/src/runtime/roleRunWorker.ts:60-100` (`startRoleRunWorker`) | `if (stopCurrentWorker) return stopCurrentWorker;` — singleton. Но `stopCurrentWorker` сбрасывается в `null` ВНУТРИ `await loop` (`roleRunWorker.ts:108-112`), и если в этот момент придёт второй вызов `startRoleRunWorker`, он создаст второй worker. | Гонка редкая (worker стартует в main после listen), но если тест или миграция дёрнет `startRoleRunWorker` дважды с интервалом, появятся два таймера, каждый со своим workerId. | Перенести `stopCurrentWorker = null` за `await loop` или вообще не сбрасывать до полной остановки. | Низкий. |
| 6.7 | Runtime | `server/src/runtime/planMutations.ts:84-94` (`isPending`) | `if (plan.status !== "approved") return true;` — черновик всегда «можно править». Правильно, но `add_step` в `applyOne` (`planMutations.ts:171-188`) **на черновике** создаёт `subtasks` строку в `persist()` (`planMutations.ts:311-327`) только если `plan.status === "approved"`. | На черновике `add_step` заводит только узел в `task_collaboration_plan_nodes`, **но не создаёт подзадачу**. При последующем `approveBranch` (`branchPlan.ts:115-180`) подзадачи создаются отдельно. Согласовано, но это «двухшаговое» поведение не очевидно: если `add_step` упадёт между двумя persist'ами, узел есть, а subtask нет. | Закрепить тестом: «add_step на черновике → нет subtask, на approved → есть». | Низкий. |
| 6.8 | Runtime | `server/src/runtime/planMutations.ts:325-330` (обновление подзадачи при `update_step` на approved) | `db.prepare("UPDATE subtasks SET title = ?, agent_id = ? WHERE collaboration_plan_id = ? AND plan_node_key = ?")` — нет фильтра `AND done = 0 AND agent_state IS NULL`. То есть `update_step` меняет название и исполнителя СДАННОГО узла тоже. | Идущий или закрытый узел не должен переназначаться — это нарушает «история не переписывается». | Добавить те же гард-условия, что в `persist()` для `w.added`. | Средний (трогает сданное). |
| 6.9 | Runtime | `server/src/runtime/planReviewLifecycle.ts:158-202` (`completePlanFinalReviewAtomic`) | `if (branchRequest) requestedTargets=branchRequest.rootTargets;` — после перезаписи `requestedTargets` дальше идёт старый код, который считает, что `requestedTargets` — адреса в текущей карточке. Для root-карточки это так, но после `branchRequest` тот же `requestedTargets` используется и для дочерних циклов: они получают адреса, посчитанные для корня, а не свои. | Если владелец запросит доработку в корне ветки с дочерними карточками, дочерние циклы будут идти по «чужим» `slot_key`. | Перед каждым `completePlanFinalReview(card.taskId,...)` для дочерней карточки явно вызвать `branchReworkRequest` для неё. | Средний. |
| 6.10 | Runtime | `server/src/runtime/planSubtaskAdmission.ts:155-170` (`startPlanSubtaskRun`) | `if (current.done \|\| current.agent_state) return { ok: false, error: "узел плана уже начат или закрыт" };` — гонка: между этой проверкой и `db.transaction()` ниже может влезть параллельный вызов. | Другая транзакция успеет поставить `agent_state='in_progress'` после нашего SELECT'а. | Проверка должна идти ВНУТРИ транзакции. Сейчас она снаружи; `db.transaction(...)` (`planSubtaskAdmission.ts:163-180`) делает re-SELECT, но до этого `if (current.done...)` — обычный. | Низкий (на практике API под `authOrApiToken` сериализуется per-user). |
| 6.11 | Runtime | `server/src/runtime/scheduler.ts:155-170` (`launchScheduled` — ветка 4) | Сам код говорит «⚠️ Перенесена как есть (01.10.2026): run_at сервер отдаёт только в карточке, а не в списке GET /api/tasks, поэтому и в старом scripts/scheduler.py эта ветка ни разу ничего не запускала. Включать ли её (брать run_at из due_date+start_time) — решение владельца». То есть **6 месяцев** ветка существует и не работает. | Если владелец её включит «как есть», сразу стартанёт пачка карточек, у которых `run_at` пустое (поле отдаётся только в карточке, не в списке). Текущее поведение — `m` не сматчится, ничего не стартанёт. | Удалить ветку до решения, либо пометить `# pragma: OFF` и оставить закомментарий. | Низкий. |
| 6.12 | Runtime | `server/src/runtime/slotWorkSnapshot.ts:99-108` (`lease_owner` = null и `attempts.ended_at` — логика «неполного» снимка) | `complete: input.complete ?? Boolean(done ?? left ?? blocker ?? nextStep);` — если роль передала `complete: true` БЕЗ текста, снимок всё равно пометится полным. | Полный снимок без текста врёт: следующий ход роли увидит «это был полный отчёт», а там пусто. | Жёстко: `complete=true` требует хотя бы `done` или `left` непустого. | Низкий. |
| 6.13 | Runtime | `server/src/runtime/chatLiveTurn.ts:40-58` (`SECRET_PATTERNS`) | Регексы вручную затирают «ключ-похожее». `Bearer ` шифруется только латиницей, цифрами и `._~+/=-`. Если в начале заголовка `Bearer ` затесалась нестандартная схема (например, `PoP ` из свежей спеки OAuth 2.0), ключ не затрётся. | Утечка в чат-ленту. | Добавить `PoP` и любые нестандартные схемы в маску, либо затирать целиком значение после первой `: ` или `= `. | Низкий. |
| 6.14 | Runtime | `server/src/runtime/chatLiveTurn.ts:140-180` (`onEvent`) | `if (e.type === "tool_execution_start" && e.toolName)` — но в SDK имена инструментов теперь приходят как `mcp__taskflow__*`, а `MCP_TOOL_TITLES` (`chatLiveTurn.ts:230-260`) ищет `taskflow_*` без `mcp__` префикса. `mcpToolTitle("mcp__taskflow__status")` (`chatLiveTurn.ts:255-260`) снимет оба префикса и вернёт «status», а в `chatLiveTurn.ts:160-180` (`stepDetail` default) уже стоит правильная развёртка. | Двойная логика, и для редкого кейса `mcp__taskflow__*` имя инструмента в подписи может оказаться «status» вместо «сводка доски». | Унифицировать: всегда пропускать через `mcpToolTitle()`. | Низкий. |
| 6.15 | Runtime | `server/src/runtime/chatSession.ts:115-160` (`enqueueChatReply`) | Хвост цепочки снимается сразу `release()` ДО `await run()` (`chatSession.ts:140-145`). Это правильно для FIFO, но в `chatSession.ts:155-160` есть комментарий «если наш fn бросит — release всё равно вызовется, иначе очередь зависнет» — а `release` стоит в `run.finally(() => release())`, и если `enqueueChatReply` бросит **до** `prevDone.then(...)` (например, `chatRoleQueues` мутирован), `next` уже записан, но `release` не вызовется — очередь навсегда залипнет. | Крайне редкий путь (мутация Map'а снаружи), но при сбое тестов — устойчивый deadlock на `chatRoleQueues.delete(key)`. | Перенести `release()` в `try/finally` вокруг всей мутации. | Низкий. |
| 6.16 | Runtime | `server/src/runtime/roleHome.ts:74-100` (`renderSystemPrompt`) | `let systemTemplate: string \| null \| undefined;` — кеш модуля. `systemTemplate === undefined` означает «ещё не читали», `null` — «файл недоступен», строка — «уже прочитали». Но `systemTemplate = null` ставится в `catch` (т.е. ошибка чтения), а если первый ход роли попадёт в момент, когда `system` ещё не подгружен, ветка `template = systemTemplate ?? ""` (`roleHome.ts:90-100`) идёт по пустой строке и упадёт на `split("{{IDENTITY}}")` — там просто вернётся пустой шаблон, не падение. | Не баг, но `systemTemplate` живёт до конца процесса. Смена канона `scripts/role-system-prompt.md` в проде **требует рестарта сервера**, а это нигде не задокументировано. | `ensureRoleHome({ refreshSystem: true })` уже есть (`roleHome.ts:106-110`) — но вызывается только при `refreshSystem`. Сделать «обновлять файл, если md5 изменилось» — опционально, через `fs.watchFile`. | Низкий. |
| 6.17 | Runtime | `server/src/runtime/chatTools.ts:55-58` (`resolveAddressee`) | `if (!raw) throw new ToolError('кому? укажи to: имя участника или "всем". Пустое поле больше не значит «всем» — это должен быть явный выбор');` — но `chatSend` (`chatTools.ts:88-90`) идёт через `asRole` от лица роли, а `agents` отдаются все. Если в команде есть 2 человека с похожими именами, `findIndex` с `localeCompare` упадёт на `casing` (сравнение `name` приводится к lower, id — нет: `a.id === raw.toLowerCase()`). | «Клод» и «claude» (id) совпадут; «Клод» (name) и «claude» (id) совпадут по-разному. | Сравнивать `id` И `name` оба в lower. | Низкий. |
| 6.18 | Runtime | `server/src/runtime/instructionDefaults.ts:135-180` (MCP tool descriptions) | Описания `tool.mcp.taskflow_*` приходят из канона, но при первом запуске в `instructionDefaults.ts:135-180` они строятся строковой конкатенацией; правка одного описания в этом файле требует перевыпуска всех ролей, потому что в БД `roles.prompt` пустая (текст из файла), а `INSTRUCTION_DEFAULTS` — глобальный singleton. | Владельцу правка одного `tool.mcp.taskflow_*` стоит рестарта сервера. | Документировать это явно в шапке файла. | Низкий. |
| 6.19 | Runtime | `server/src/runtime/secretaryVoiceBridge.ts:18` | `secretaryVoiceSocket()` использует `XDG_RUNTIME_DIR || /run/user/${process.getuid!()}`. `process.getuid!()` — non-null assertion, но на Windows/WSL без `getuid` она вернёт `undefined`, и шаблонная строка сломается. | На .110 (Linux) работает. На машине разработчика под WSL — может сломаться. | Добавить fallback на `tmpdir()` или `process.cwd()`. | Низкий. |
| 6.20 | Runtime | `server/src/runtime/AuthSession.ts:230-260` (`prune`) | `if (session.finished \|\| session.expired) { if (session.expired) this.sessions.delete(id); }` — finished сессии НЕ удаляются по факту finished, ждут expiry. На живой базе 10 минут × N попыток = десятки сессий, пока они не истекут. | Утечка памяти при активной OAuth-активности. | `if (session.finished) this.sessions.delete(id);` отдельно. | Низкий. |
| 6.21 | Runtime | `server/src/runtime/dependencyContext.ts:96-100` | `cycle: "родитель не может предшествовать своему результату"` — но в `branchPlan.ts:180-200` (`validateBranchOrder`) уже есть проверка цикла для всей ветки. Двойная валидация, и при росте `seen.size > 200` ветка «обрывается» — но `MAX_DEPENDENCIES = 12` (`dependencyContext.ts:14`), а обход BFS обрывается по лимиту, не по `seen`. | Если в ветке >12 зависимостей, последние просто не попадут в контекст, без ошибки. | Сделать `validateBranchOrder` обязательным шагом раньше, чем `buildDependencyContext`. | Низкий. |

**Проверка для области:** `grep -n "kickRoleTask\|startScheduler\|enqueueRoleRunJob" server/src/runtime/`; `grep -n "subtask_artifact_versions" server/src/runtime/planMutations.ts` (см. п. 6.8).

---

## Область 7. Lib (memory, roleContextResolver, planWorkSelection, taskPreparation, ownerDraft, secretaryReply, secretaryTaskSummary, semanticEnrich, projectTopics, serverNotificationsProject, diagnosticDispatch, knowledgeSync, attachmentText, attemptCheck, attemptLadder, modelLadder, chatMessages, embeddingClient, inboxTriageWatcher, inboxResultsWriter, linearImport/Source, markdownToTiptap, tiptapToMarkdown/Plaintext, report, consultationTriggers, taskArtifactFolder, taskBrief, taskHierarchy, taskIntakeMetadata, taskOutcome, taskPreparationPersistence, aiClient, ownerDraft, projectTopics)

| № | Область | файл:строка | Что не так | Почему важно | Предложение | Риск правки |
|---|---------|-------------|------------|--------------|-------------|-------------|
| 7.1 | Lib | `server/src/lib/secretaryReply.ts:35`, `lib/secretaryTaskSummary.ts:130`, `lib/ownerDraft.ts:47` | `const SECRETARY_ID = "u-secretary";` — повторено в трёх местах. | Дрейф: правка id в одном месте не дотянется до остальных. | Вынести в `lib/secretaryConstants.ts` (или в `roleRouting.ts:roleUserId("secretary")` — оно уже возвращает `u-secretary`). | Низкий. |
| 7.2 | Lib | `server/src/lib/ownerDraft.ts:80-100` (`pushToPhone`) | `process.env.NODE_ENV === "test"` глушится — `if (process.env.NODE_ENV === "test") return;`. Но в боевом прогоне 10.09.2026 «разбудил настоящий канал тревог» — потому что `NODE_ENV` в то время ещё не был `test`. | Защита есть, но она «на честное слово»: установи `NODE_ENV=test` в проде — и владелец не получит уведомление. | Проверять явно `TASKFLOW_TEST_MODE=1` И отдельный `process.env.CI`. | Низкий. |
| 7.3 | Lib | `server/src/lib/ownerDraft.ts:155-165` (`createDraftCards`) | `applyCardRole` для детей в `createDraftCards` сначала строит `childIds`, потом в `applyCardRole` пишет `assignee_id` для детей **и** `machine_selected_role` для родителя. Если ребёнок личный (`isPersonal(child) === true`), а родитель — нет, `applyCardRole` для ребёнка выставит `assignee_id = owner` поверх любых `role`. | Дочерняя личная карточка, на которую модель поставила роль `builder`, всё равно станет «личной». | Внутри `applyCardRole` учитывать `parentIsPersonal`. | Низкий. |
| 7.4 | Lib | `server/src/lib/secretaryReply.ts:117-130` (`turnStartedAt`) | SQL-время `datetime('now')` берётся ДО `startChatRun`. Если ответ идёт дольше 1 минуты, и параллельно Секретарь создаст ещё одну задачу, она тоже попадёт в выборку `created_at >= turnStartedAt`. | «Карточка ответа» может указать на чужую карточку. | Либо убрать эвристику (она уже прокомментирована как «нет прямого сигнала»), либо вешать пометку через явный tool call и не зависеть от `created_at`. | Низкий. |
| 7.5 | Lib | `server/src/lib/semanticEnrich.ts:142-150` | В `ignoreGate: true` (для диспетчера) `gateOpen = opts.ignoreGate \|\| escalationRate > SEMANTIC_GATE_THRESHOLD;` (`semanticEnrich.ts:165-170`) — то есть для диспетчера гейт ВСЕГДА открыт. Но `escalationRate` всё равно читается из БД (`semanticEnrich.ts:160-165`), и при пустой таблице возвращается 0. | Не баг, но `escalation_rate: 0, gate_open: true` в каждом ответе диспетчера создаёт ложное впечатление «всё в порядке» в логах. | Не возвращать `escalation_rate`, если `gateOpen` по `ignoreGate`. | Низкий. |
| 7.6 | Lib | `server/src/lib/roleContextResolver.ts:130-140` | `let systemTemplate: string \| null \| undefined;` дублируется по смыслу с `runtime/roleHome.ts:78-82` — оба читают `scripts/role-system-prompt.md`, кешируют в модуле, оба сваливаются в пустую строку при ошибке. | Два кеша. Правка в `roleContextResolver` не подхватится `roleHome` и наоборот. | Один `getSystemTemplate()` в `roleHome.ts`, импорт из `roleContextResolver`. | Низкий. |
| 7.7 | Lib | `server/src/lib/roleContextResolver.ts:230-260` (`applyOverride`) | `db.prepare("UPDATE role_context_overrides SET is_active=0 WHERE scope=? AND role_key=? AND layer=?").run(args.scope, roleKey, args.layer);` — это снимает активность со ВСЕХ старых версий слоя, но в `role_context_overrides_history` (`roleContextResolver.ts:215-220`) идёт INSERT **до** UPDATE. | Если транзакция прервётся между INSERT и UPDATE, история покажет новую версию, а активной останется старая. | Поменять порядок: сначала UPDATE, потом INSERT. | Низкий. |
| 7.8 | Lib | `server/src/lib/roleContextResolver.ts:305-315` (`renderInstruction`) | `layer.placeholders ?? []` — если слой не имеет плейсхолдеров, любые `{...}` в тексте пройдут как литералы. Владелец мог написать «{some_random_word}» в JSON-примере — оно не интерпретируется, и это правильно. Но если владелец случайно поставит `{}` (пустые фигурные скобки), парсер их не тронет и они уйдут в модель. | Шум в промпте, не баг. | Документировать в `validateInstruction`. | Низкий. |
| 7.9 | Lib | `server/src/lib/memory.ts:105-110` (`chunkText`) | `if (p.length > CHUNK_TARGET * 1.5) { ... for (let i = 0; i < p.length; i += CHUNK_TARGET) chunks.push(p.slice(i, i + CHUNK_TARGET)); }` — режет абзац >1800 символов на куски ровно по `CHUNK_TARGET` (1200), без учёта границ предложений. | Эмбеддинг куска в середине предложения = низкая релевантность при поиске. | Резать по `\n` или последнему `.` перед границей. | Низкий. |
| 7.10 | Lib | `server/src/lib/memory.ts:230-250` (`recall` — дедупликация по `seenFiles`) | `if (n >= 2) continue;` — для одного файла берём максимум 2 куска. Но `picked.push(item)` идёт ДО проверки лимита (`memory.ts:240-245`), а проверка — на следующей итерации. | В выдачу может попасть 3-й кусок, если он идёт подряд с двумя предыдущими (без `continue` в текущей итерации). | Проверять `n >= 2` ДО push'а. | Низкий. |
| 7.11 | Lib | `server/src/lib/projectTopics.ts:30` | `...(db.prepare("SELECT id FROM users WHERE role='orchestrator' AND COALESCE(archived,0)=0").all() as {id:string}[]).map(u=>u.id);` — все живые оркестраторы добавляются в КАЖДЫЙ проектный чат. Если у владельца появится второй оркестратор (роль `orchestrator` есть в `roleRouting.ts:DEFAULT_ROLES`, не привязана к одной учётке), он будет в каждом чате. | Возможная утечка переписки: оркестратор видит все темы задач всех проектов, даже не относящихся к его работе. | Сверять `orchestrator`-доступ к проекту по той же матрице, что и обычный пользователь (видимость — см. `access.ts:visibleScope`). | Средний. |
| 7.12 | Lib | `server/src/lib/serverNotificationsProject.ts:18-30` | Фиксированный `SERVER_NOTIFICATIONS_PROJECT_ID = "server-notifications"`. Если кто-то однажды заведёт проект с тем же id (например, тестовая миграция или копирование), `INSERT OR IGNORE` отработает, и `serverNotificationsProjectId` будет возвращать чужой проект. | Дрейф проекта для серверных уведомлений. | Проверять `name = SERVER_NOTIFICATIONS_PROJECT_NAME` И `id = SERVER_NOTIFICATIONS_PROJECT_ID`. | Низкий. |
| 7.13 | Lib | `server/src/lib/inboxTriageWatcher.ts:37` | `const OWNER_ID = process.env.TASKFLOW_OWNER_ID || "u1";` — `u1` буквально. Миграция 040 заархивировала u2/u3, владелец теперь создаётся с новым id (uuid). Если `TASKFLOW_OWNER_ID` не задан, `OWNER_ID` указывает на заархивированную учётку. | Тестовая миграция `seed.ts` создаёт `u1` как владельца, но прод-миграция — `u-<uuid>`. ENV должен быть обязателен. | Бросать ошибку на старте, если `TASKFLOW_OWNER_ID` пуст. | Низкий. |
| 7.14 | Lib | `server/src/lib/inboxResultsWriter.ts:358-360` | `"u1"` и `serverNotificationsProjectId("u1")` — буквальный id. Та же история, что 7.13, плюс `serverNotificationsProjectId` создаст проект **под архивным владельцем** (`role='owner'`), и проект станет невидимым для нового владельца. | Дрейф владельца проекта «Серверные уведомления». | Брать id владельца из `users WHERE role='owner' AND archived=0 ORDER BY created_at LIMIT 1`. | Низкий. |
| 7.15 | Lib | `server/src/lib/aiClient.ts:70-100` (ветка `provider === "hermes"`) | Активная ветка для OpenRouter-Hermes с `console.warn("Hermes/OpenRouter error, falling back to local Ollama:", e);`. Учётка `u3` (Hermes) заархивирована миграцией 040. | Мёртвый код, который иногда срабатывает, если кто-то явно попросит `provider: "hermes"` в API. | Оставить `provider: "hermes"` валидным, но пометить комментарием «архив, не использовать в проде». | Низкий. |
| 7.16 | Lib | `server/src/lib/aiClient.ts:154-160` (`provider === "antigravity" \|\| provider === "gemini"`) | Та же история для `antigravity`. В `team_catalog.json` (см. `scripts/team_catalog.json` — `antigravity: Builder`) и `access.ts:PROFILE_ROLE` (`antigravity: "Builder"`). | Мёртвый код, но валидный, если в каталог добавят профиль `antigravity` (Часть 1, п. 1.5 — решения нет). | Согласовано с решением 6 Части 1: удалить из `PROFILE_ROLE` (уже решено), и из `aiClient.ts` (эта находка). | Низкий. |
| 7.17 | Lib | `server/src/lib/taskPreparation.ts:155-165` (`applyPreparation`) | `if (preparation.representation === "child_cards")` — и в цикле `card.children[i].after = indices.length === 1 && indices[0] < i ? indices[0] + 1 : null;` (line 162). Но `indices` берётся из `stream.depends_on.map(key => preparation.workstreams.findIndex(w => w.key === key))` — а `findIndex` возвращает `-1`, если не нашёл. | Если модель ошибётся в `depends_on` и укажет несуществующий ключ, `indices` будет `[-1]`, и `indices[0] < i` (т.е. `-1 < i`) — всегда true, и `card.children[i].after = -1 + 1 = 0`. Дочерняя карточка станет «после карточки 0», которой нет. | Фильтровать `index >= 0` перед проверкой. | Низкий. |
| 7.18 | Lib | `server/src/lib/secretaryTaskSummary.ts:50-60` (`summaryClock`) | `localDate(value)` (`secretaryTaskSummary.ts:75-85`) разбирает ISO-строку, конвертирует в локальный часовой пояс, и сравнивает со строкой `today`. Если `value` пришёл из `completed_at` в формате `2026-10-05 12:34:56` (SQLite), а `today` — `2026-10-05`, то разбор через `new Date(value.replace(" ","T")+"Z")` даст UTC-время, и конверсия через `summaryClock` в Europe/Moscow сдвинет на 3 часа вперёд. | Просроченные/будущие сроки для завершённых «сегодня» карточек в районе полуночи. | Использовать сравнение ISO-дат напрямую, без timezone-конверсии. | Низкий. |
| 7.19 | Lib | `server/src/lib/secretaryTaskSummary.ts:96-100` (`predicates.stuck`) | `stuck: t => waiting(t) \|\| (active(t) && t.agent_state === "blocked")` — `assigned_waiting` уже включает в себя «назначены, но не взяты». `stuck` = union, дублирующий строки. | Двойной счётчик в сводке. | Убрать `stuck` из `wanted`-набора по умолчанию или пометить как «уже считано в assigned_waiting+blocked». | Низкий. |
| 7.20 | Lib | `server/src/lib/attachmentText.ts:1-50` (прочитан выжимкой) | Зависит от внешних утилит (`pdftotext`, `tesseract`), которые должны быть в PATH. На .110 они есть, но ошибка чтения PDF пишется в `console.warn` без явного fallback'а — файл сохраняется как attachment, но без извлечённого текста. | Если `pdftotext` упадёт, агент не узнает об этом, пока не откроет attachment. | Возвращать `{text, error: string \| null}` и пробрасывать наверх. | Низкий. |
| 7.21 | Lib | `server/src/lib/linearImport.ts:1-50` и `lib/linearSource.ts:1-50` | Два модуля для одного и того же (импорт Linear). `linearSource.ts:1-50` обёртка вокруг subprocess, `linearImport.ts:266` — JSON-обработка. Если subprocess зависнет, `linearSource.ts:90-100` через 90 секунд убьёт процесс. | Таймаут есть, но `error: "Composio недоступен"` в `linearSource.ts:90-100` — общий на ВСЕ ошибки subprocess'а. Специфичные ошибки теряются. | Различать `not_connected`, `multiple_accounts`, `permission_denied`, `timeout`. | Низкий. |
| 7.22 | Lib | `server/src/lib/chatMessages.ts:50` (упоминание «Супер Секретарь») и `lib/secretaryReply.ts:35` | «Супер Секретарь» — кодовое имя из `docs/ПЛАН Супер Секретарь/`, используется в комментариях, но в `rolePromptText("secretary")` (`roleRouting.ts:96-105`) текст идёт из `roles.prompt` ИЛИ `scripts/role-prompts/secretary.md`. | Два места правки инструкции Секретаря. | Закрепить один источник (`roles.prompt`). | Низкий. |

**Проверка для области:** `grep -n "u1\|u2\|u3\|u-secretary\|claude_bot\|hermes\|antigravity\|pi_agent" server/src/lib/`; `sqlite3 server/taskflow.db "SELECT id, archived, role FROM users WHERE role IN ('owner','agent') ORDER BY created_at"`.

---

## Область 8. Непрочитанные в Части 1 маршруты (`research`, `role-run-jobs`, `reports`, `subtask-artifacts`, `consultation`, `agent-inbox` полностью, `agent-details` (узлы), `dispatch` (узлы маршрутизации), `chat` (узлы Hermes-webhook), `agent-state` (узлы триггера), `tasks` (узлы 1246), `projects` (узлы 607))

| № | Область | файл:строка | Что не так | Почему важно | Предложение | Риск правки |
|---|---------|-------------|------------|--------------|-------------|-------------|
| 8.1 | Маршрут | `server/src/routes/research.ts:55-60` | `if (!task.needs_research) return reply.code(400).send({ error: "задача не помечена как «нужно глубокое исследование» — поставьте галочку в карточке" });` — гейт миграции 052. Но `task.needs_research` (тип `number | undefined`) не проверяется на `=== 1`; `needs_research: 0` (т.е. флаг снят) тоже пройдёт. | Условие `!task.needs_research` сработает только для `undefined`/`null`/`0`. Для 0 — да, ошибка; для undefined — да, ошибка. То есть гейт корректен. **Но** это надо явно закрепить. | Заменить на `if (task.needs_research !== 1)`. | Низкий. |
| 8.2 | Маршрут | `server/src/routes/research.ts:75-95` (запуск процесса) | `child.unref()` — процесс станет сиротой, и `child.on("exit"/"error")` могут не сработать, если родитель тоже завершится. `running.delete(task.id)` на сервере уже ушёл (server killed), а процесс всё ещё идёт. | Карточка остаётся «running» в in-memory, рестарт снимет, но окно до рестарта — фантомный «идёт». | Записать в БД `task_research_runs` (или `task_outcomes.status`) и опираться на него. | Низкий. |
| 8.3 | Маршрут | `server/src/routes/role-run-jobs.ts:18-30` (GET) | `if (taskId && !getTaskForRead(taskId, req.userId))` — 404 на «нет доступа», но сам список `listRoleRunJobs` отдаётся только владельцу (`role-run-jobs.ts:17`). Агент не может посмотреть свою очередь. | Для отладки/аналитики собственных попыток агент идёт через диспетчерскую выборку. | Сделать `getRoleRunJob` (по id) доступным агенту, если job — его. | Низкий. |
| 8.4 | Маршрут | `server/src/routes/reports.ts:50-60` (POST) | `if (markdown.length < 20) return reply.code(400).send({ error: "markdown слишком короткий" });` — нет потолка. Markdown в 100 МБ пройдёт, ляжет в `markdownToTiptap` (`lib/markdownToTiptap.ts:370` строк) и убьёт процесс по памяти. | DoS через отчёт. | Добавить `MAX_MD_BYTES = 1 МБ`. | Низкий. |
| 8.5 | Маршрут | `server/src/routes/reports.ts:60-80` (построение) | `built = await buildReport({...})` — а `buildReport` живёт в `lib/report.ts:233`. Внутри он парсит mermaid, схемы, графики, и **не** имеет лимита на размер markdown перед парсингом. | Та же проблема, что 8.4. | Лимит на этапе `buildReport`. | Низкий. |
| 8.6 | Маршрут | `server/src/routes/subtask-artifacts.ts:55-95` (POST artifact) | `if (evidence.some((item) => !item \|\| typeof item !== "object" \|\| typeof (item as Record<string, unknown>).path !== "string" \|\| !(item as Record<string, string>).path.trim() \|\| (item as Record<string, string>).path.length > 1024))` — валидация длины path, но **нет** валидации «path указывает на разрешённый каталог». | Агент может загрузить evidence-ссылку на `/etc/shadow` (прочитать не сможет, но имя попадёт в ленту). | Сверять path с `allowed_evidence_paths` (например, `task_artifact_folder` + `notes_folder_id`). | Средний. |
| 8.7 | Маршрут | `server/src/routes/subtask-artifacts.ts:108-130` (accept/revision/reject) | Все три используют `isOwner \|\| isOrchestrator`. Но `reopen()` (`subtask-artifacts.ts:130-170`) при `rejected`/`revision_requested` сбрасывает `done=0` и НЕ пересоздаёт `attempts`. Цикл попыток нарушается: у узла `done=0`, но старые `attempts` остаются, и `attempts WHERE subtask_id AND ended_at IS NULL` будет пуст (т.к. все ended). | При повторной сдаче узла новая попытка не появится в `attempts`, и `subtask.current_attempt_id` останется null. | Создавать новую `attempts` запись при reopen. | Средний. |
| 8.8 | Маршрут | `server/src/routes/consultation.ts:280-300` (POST /api/consult) | Лимит `CHAT_CONSULTS_PER_HOUR = 3` хранится в in-memory `chatConsults` (`consultation.ts:340-350`). После рестарта сервера счётчик сбрасывается. | Агент может «обойти» лимит, перезапустив сервер. Но это `in-memory` per-process — и так работает только пока сервер жив, так что не баг, а скорее «известное». | Документировать явно. | Низкий. |
| 8.9 | Маршрут | `server/src/routes/agent-inbox.ts:25-40` (`loadCatalog`) | `try { return JSON.parse(...) } catch { return { profiles: {}, routing_rules: ... } }` — **молчаливый** fallback. Если `team_catalog.json` испортится, маршрутизация в агенте-инбоксе будет идти через `fromUserId` (Часть 1, п. 2.1) без лога. | Та же проблема, что Часть 1, п. 2.1, но в `agent-inbox` она не исправлена. | Добавить `console.warn` (как `db.ts:464`). | Низкий. |
| 8.10 | Маршрут | `server/src/routes/agent-inbox.ts:80-100` (routeAddressee) | `if (orch) return orch[1].id;` — если в `team_catalog.json` появится **второй** профиль с «оркестратор» в title (например, временный бот), побеждает первый из `Object.entries`. Недетерминированный выбор. | До решения 5 (Часть 1) в каталоге остаётся `claude_bot` и `pi_agent`, оба не подходят под «оркестратор», но это не гарантировано навсегда. | Сортировать `Object.entries` перед `find`. | Низкий. |
| 8.11 | Маршрут | `server/src/routes/chat.ts:48-100` (`notifyHermesWebhook` + `HERMES_USER_ID = "u3"`) | `HERMES_USER_ID = "u3"` буквально, `notifyHermesWebhook` фильтрует `if (message.to_user_id !== HERMES_USER_ID) return;` — но u3 заархивирован миграцией 040. Сообщения **никогда** не получат `to_user_id = u3`, функция всегда возвращает `null`, но `TASKFLOW_WEBHOOK_SECRET` всё ещё в env и проверяется. | Мёртвая ветка с реальной ошибкой в логе (`console.warn` в `chat.ts:84`). | Удалить `notifyHermesWebhook`, `HERMES_USER_ID`, `TASKFLOW_WEBHOOK_SECRET` (если он только для этого). | Низкий. |
| 8.12 | Маршрут | `server/src/routes/chat.ts:160-200` (`orchestratorId`) | `SELECT id FROM users WHERE role = 'orchestrator' ORDER BY created_at LIMIT 1` — без `AND archived = 0`. Если старая учётка «Оркестратор Claude» (см. Часть 1, п. 1.1) ещё в БД с `role='orchestrator'`, `orchestratorId` вернёт её. Миграция 040 архивировала только `u2/u3`, не роль `orchestrator` (в Части 1 написано: «если в `team_catalog.json` вернётся профиль `pi_agent`» — это про профиль, не про роль). | Уведомления «об оркестраторе» могут уходить в архивную учётку. | Добавить `AND COALESCE(archived,0)=0`. | Низкий. |
| 8.13 | Маршрут | `server/src/routes/chat.ts:170-200` (`isOrchestrator`-подобные проверки) | `return role === "owner" \|\| role === "orchestrator"` — `role` берётся из `users` напрямую (не `callerOf`), и без фильтра `archived`. То же, что 8.12. | То же, что 8.12. | То же. | Низкий. |
| 8.14 | Маршрут | `server/src/routes/agent-state.ts:60-200` (комментарии «trigger.py») | Заголовок и 7 ссылок на `trigger.py` (строки 58, 62, 115, 174, 730, 1237, ещё одна в `routes/agent-service.ts:112` и в `routes/dispatch.ts:22`). | Документация и код расходятся. Согласовано с п. 6.1: нужен скоординированный шаг «trigger.py официально мёртв». | См. 6.1. | Низкий. |
| 8.15 | Маршрут | `server/src/routes/dispatch.ts:50-180` (`pickRole`) | Комментарий `В системе нет никакого "Pi"… но access.ts:70 хранит pi_agent: "Builder"`. После решения 6 (Часть 1) `access.ts:70` будет пустым, и комментарий станет честным. | Синхронизировать с решением 6. | См. 1.5 Часть 1. | Низкий. |
| 8.16 | Маршрут | `server/src/routes/dispatch.ts:174` (`console.warn подбор роли не удался`) | `Подбор — улучшение, а не условие запуска. Модель эмбеддингов недоступна — работа всё равно должна уехать исполнителю, пусть и с запасной ролью.` | Осознанный fallback, но `FALLBACK_DISPATCH_ROLE` определён где-то выше — если он вернёт `null` (роль не из списка), карточка уйдёт в `pickRole` с `null`, и `agent_state` останется `null`. | Логировать выбор `FALLBACK_DISPATCH_ROLE` и его null-исход. | Низкий. |
| 8.17 | Маршрут | `server/src/routes/dispatch.ts:758-820` (`admitParentAfterChildren` + `releaseQueuedSuccessors`) | В `admitParentAfterChildren` (`dispatch.ts:740-770`) при `parent.assignee_id == null` И `unitState.active` Идёт `dispatchTaskToPi(parent.id, ownerRow.id, ...)`. Но проверка `unitState.active` — это «включена ли Система». | На карточке без исполнителя автоматически стартует роль, если Система включена. Это и есть фишка «автоподбора», но если у владельца карточка на паузе (через `unlockDependencyPlans` в `planSubtaskAdmission.ts`), её всё равно стартанёт. | Сверять `paused` флаг или `task.queue_paused`. | Низкий. |
| 8.18 | Маршрут | `server/src/routes/dispatch.ts:813-820` (`console.warn`) | `родитель ${parentId}: флаг поднят, отдать не удалось` — но в `dispatchTaskToPi` (`dispatch.ts:830-880`) `ok: false` уже залогирован через `pickRole`. Двойное логирование. | Шум в логах. | Один из двух `console.warn` лишний. | Низкий. |
| 8.19 | Маршрут | `server/src/routes/projects.ts:607` (комментарий) | `их id зашиты в server/scripts/trigger.py (EXTERNAL_AGENTS) и в базовых` — см. 6.1, 8.14. | Согласовано с 6.1. | См. 6.1. | Низкий. |
| 8.20 | Маршрут | `server/src/seed.ts:5-50` (`/api/seed`) | `if (process.env.NODE_ENV === "production") return reply.code(404).send({ error: "Not found" });` — гейт по env. Но `seed.ts` заводит `u1/u2/u3` с `bcrypt.hashSync("test123", 10)` и `email: "maksim@test.com"` (test-only данные). Если миграция применится на проде без `NODE_ENV=production` (например, во время CI), в живую базу попадут тестовые учётки. | Прямая инъекция тестовых данных. | Дополнительно проверять `process.env.TASKFLOW_ENV !== "production"` И `!fs.existsSync("server/production.lock")`. | Низкий. |
| 8.21 | Маршрут | `server/src/routes/agent-details.ts:104` | `if (role === "orchestrator")` — без проверки `archived`. То же, что 8.12. | То же. | То же. | Низкий. |
| 8.22 | Маршрут | `server/src/routes/roles.ts:38` | `"orchestrator"` упомянут в списке ролей `role` для провайдеров (`roles.ts:36-42`). Но `roleRouting.ts:DEFAULT_ROLES` не содержит `orchestrator` — он заводится через `users.role='orchestrator'` напрямую (см. `seed.ts` — там нет `orchestrator`). | Расхождение между UI'ным списком «ролей провайдеров» и реальной ролью. | Согласовать. | Низкий. |
| 8.23 | Маршрут | `server/src/routes/agent-service.ts:159-180` (тумблер автономки) | `isOwner \|\| isOrchestrator` — Часть 1, п. 1.1. Правка по решению 1 (Часть 1) — зафиксировать, что это «тумблер для живого диспетчера», а не «для автономки». | Согласовано с 1.1. | См. 1.1. | Низкий. |
| 8.24 | Маршрут | `server/src/routes/chat.ts:735` (`Супер Секретарь`) и `routes/chats.ts:633,742` | «Супер Секретарь» — кодовое имя в комментариях, нет следов в API/логике. По факту это и есть сегодняшний `secretary`. | Документационная консистентность. | Переименовать комментарии в «Секретарь». | Низкий. |
| 8.25 | Маршрут | `server/src/runtime/roleHome.ts:23` (упомянуто 6.2) и `server/scripts/role-prompts/synthesizer.md` | `synthesizer.md` — призрак. В `LAYER_CATALOG` (`roleContextResolver.ts:115-130`) нет ключа для синтезатора. В `roleRouting.ts:DEFAULT_ROLES` — нет. В `roleRunAccess.ts:64-90` — `DEFAULT_TOOLS` не включает `taskflow_synthesize*` (таких нет). | Если кто-то добавит роль, она подхватится через `importRoleResources`, но `ROLE_NAMES.includes("synthesizer")` вернёт `false`, и `prepareRoleRunAccess` (`roleRunAccess.ts:78`) вернёт `null` — запуск пойдёт без инструментов. | Удалить `synthesizer.md` (если не планируется), либо добавить в `DEFAULT_ROLES`. | Низкий. |
| 8.26 | Маршрут | `server/src/runtime/secretaryVoiceBridge.ts:75-85` (`POST /secretary/summary`) | Если `body.text` пустая или > 6000 символов, 400. Но `body.owner_id` проверяется **только** через сравнение `body.owner_id !== owner.id` — а `owner.id` берётся из БД без `archived=0`. | Если старая учётка владельца ещё в БД, мост пошлёт сводку туда. | Фильтровать `AND archived = 0`. | Низкий. |
| 8.27 | Маршрут | `server/src/lib/secretaryReply.ts:90-95` (`mayRequestSummary`) | Регекс матчит «покажи|пришли|скинь|…». Фраза «пришли мне отчёт» — да, «отчёт» — да. Фраза «сводка» — да. Фраза «пришли комментарий к задаче» — нет (нет «отчёт»/«сводк»). | Ложно-отрицательные: пользователь говорит «пришли список», а сводка не запускается. | Расширить регекс: добавить «список задач», «статус задач». | Низкий. |
| 8.28 | Маршрут | `server/src/runtime/secretaryReply.ts:175-205` (запись `chat_messages`) | `if (!rawReplyText) { live.announceEnd(null); typing(false); return null; }` — если ответ пустой, Секретарь НЕ записывает ничего в чат. Владелец видит «Секретарь печатал…» и тишину. | Не баг, но UX: «ничего не сказал» должно оставлять короткий ответ («Не понял, уточните»). | Записывать «Не нашёлся с ответом» как fallback. | Низкий. |
| 8.29 | Маршрут | `server/src/lib/inboxTriageWatcher.ts:55-80` (маркер `_Авто-создано inbox-triage-watcher из inbox/`) | Строка-маркер ищется через `instr(t.description, ?)`. Если описание меняется (владелец правит карточку), маркер уходит из выборки, и карточка больше не автодиспатчится. | Хрупкая зависимость от текстового поля. | Завести `task_metadata.kind = 'auto_triage_watcher'` и селектить по нему. | Низкий. |
| 8.30 | Маршрут | `server/src/lib/diagnosticDispatch.ts:50-70` (`dispatchPendingDiagnosticTasks`) | `if (flagged.changes) logEvent({...})` — логирует смену флага, но не логирует успех/неуспех самой диспетчеризации. `if (!result.ok) lastErrors.set(...)` — кеш in-memory, при рестарте сбрасывается. | Долгая «застрявшая» карточка без видимой причины. | Добавить `console.log` уровня «успех» и запись в БД `last_attempt_error`. | Низкий. |

**Проверка для области:** `grep -n "u3\|HERMES_USER_ID" server/src/routes/`; `sqlite3 server/taskflow.db "SELECT id, archived FROM users WHERE role='orchestrator'"`; `grep -n "TASKFLOW_WEBHOOK_SECRET" server/src/`.

---

## Область 9. Документы (`AGENT-PROTOCOL.md`, `AGENT-API.md` целиком, плюс `INDEX.md`, `STATUS.md`, `dispatch_registry.md`, скрипты в `server/scripts/`)

| № | Область | файл:строка | Что не так | Почему важно | Предложение | Риск правки |
|---|---------|-------------|------------|--------------|-------------|-------------|
| 9.1 | Документ | `AGENT-PROTOCOL.md:1-100` (прочитано) | Документ описывает 5 состояний задачи: `active`, `in_progress`, `blocked`, `review`, `completed`. В коде есть ещё `todo`, `retry_wait`, `failed` (см. `runtime/taskExecutionState.ts`), и производное «брошено». | Документ устарел: добавились новые состояния, не отражённые в спеке. | Дополнить таблицу состояний. | Низкий. |
| 9.2 | Документ | `AGENT-PROTOCOL.md` (целиком) | Документ ссылается на «trigger.py → decide» (см. `inProcessRun.ts:1003-1005`), а фактически будит сервер изнутри. | Документ-источник для агентов, а они читают в нём про внешний `trigger.py`. | См. 6.1, 8.14. | Низкий. |
| 9.3 | Документ | `server/scripts/dispatch_registry.md:1-90` | Содержит §6 «Reviewer разрешил, но не сделано» (см. Часть 1, п. 4.5) и `agent-inbox + trigger.py` (Часть 1, п. 4.6). | Документ про несуществующий поток. | Согласовано с 4.5, 4.6 Часть 1. | Низкий. |
| 9.4 | Документ | `server/scripts/team_catalog.json` | `claude_bot: { id: "u2", auto_route: true }` (см. Часть 1, п. 1.6). Решение 5 (Часть 1) требует удалить. | Согласовано. | См. 1.6. | Низкий. |
| 9.5 | Документ | `server/scripts/team_catalog.json:91-95` | `_comment` «архивные профили удалены», но `claude_bot` жив. | Врёт. | Удалить `claude_bot` ИЛИ поправить `_comment` (Часть 1, п. 4.4). | Низкий. |
| 9.6 | Документ | `server/scripts/role-prompts/synthesizer.md` | Призрак (см. 8.25). | Документ без роли. | Удалить или вернуть роль. | Низкий. |
| 9.7 | Скрипт | `server/scripts/trigger.py`, `manual_run.sh`, `graft_refresh*.py`, `fix_clean_trigger.py`, `patch_trigger_fix.py` | Не вызываются из `runtime/inProcessRun.ts` (см. 6.1). | Мёртвый код, который легко случайно стартануть из cron/systemd. | Удалить после решения 3 (Часть 1). | Низкий. |
| 9.8 | Скрипт | `server/scripts/scheduler.py`, `scheduler_watch.py` | Перенесены в `runtime/scheduler.ts` (см. заголовок `scheduler.ts:1-15`). | Мёртвый код. | Удалить, оставить только `scheduler.ts`. | Низкий. |
| 9.9 | Скрипт | `server/scripts/chat_resident_watch.py`, `secretary_voice_watch.py` | Резидентные сторожа, которые перенесены в `secretaryVoiceBridge.ts:30-60`. | Мёртвый код. | Удалить. | Низкий. |
| 9.10 | Документ | `docs/2026-09-30-live-collaboration-plan-spec.md` (упомянуто в `runtime/planMutations.ts:1-15`) | Спека упоминает «живой план», но `planMutations.ts` (см. 6.7) имеет тонкости (`add_step` на черновике vs approved), которые спека не покрывает. | Спека и код дрейфуют. | Дополнить спеку п. 6.7. | Низкий. |

**Проверка для области:** `git ls-files server/scripts/ | xargs -I {} grep -l "trigger.py\|decide\|inbox.py" {} 2>/dev/null | head -10`; `grep -n "activeAgent\|active_agent\|last_seen_at" server/src/activeAgent.ts`.

---

## Область 10. Планировщик: триада systemd-юнит / in-process / сторож (дополнение оркестратора, 05.10.2026)

**Карточка:** 541f23bb (Linear MAK-64), дополнение оркестратора 14:26.
**Проверено:** `~/.config/systemd/user/taskflow-scheduler.{service,timer}` и `taskflow-scheduler-watch.{service,timer}` (`systemctl --user status`, `cat`); `~/.local/state/taskflow-scheduler/last-run.json` (`cat`, `stat`); `server/scripts/scheduler.py` (шапка, токен); `server/scripts/scheduler_watch.py` (шапка, логика); `server/src/runtime/scheduler.ts` (целиком, 1–300); `server/src/index.ts:16,569` (запуск); `server/src/routes/agent-service.ts:28-115` (UI лампа).

### Кто реально исполняет расписание

| Кандидат | Статус | Чем подтверждается |
|---|---|---|
| `taskflow-scheduler.service` (python) | `inactive (dead)`, timer `disabled`, последний лог 30.09.2026 14:23 | `systemctl --user status` |
| `taskflow-scheduler-watch.service` (python, сторож) | `active (waiting)`, тикает каждые 15 мин, последний прогон 17:17 — `ок — планировщик отметился 2 мин назад` | `systemctl --user status` |
| `runtime/scheduler.ts` (in-process) | живёт внутри server-процесса, тикает раз в 5 мин, пишет `last-run.json` | `cat last-run.json` → `"at":"2026-10-05T17:26:26","source":"server"`; `index.ts:16,569` импортирует `startScheduler` |

**Ответ — кто исполняет:** in-process `runtime/scheduler.ts`. Старый python-юнит остановлен (timer `disabled`), сторож `scheduler_watch.py` живой и подтверждает свежесть отпечатка. Источник отметки — `source: "server"` в JSON, не `scheduler.py`. Сторож **не молчит вхолостую** — 17:17 успешно проверил, что отпечаток свежий, и не плодит нарушений.

### Находки

| № | файл:строка | Что не так | Почему важно | Предложение | Риск правки |
|---|-------------|------------|--------------|-------------|-------------|
| 10.1 | `~/.config/systemd/user/taskflow-scheduler.service` (ExecStart) | Использует архивный токен `TASKFLOW_PI_AGENT_TOKEN` через `vault-run.py`. Та же мина, что `taskflow-trigger.service` (Часть 1, п. 4.1). | Юнит выключен (timer `disabled`), но файл на диске. Если кто-то однажды `systemctl --user enable --now taskflow-scheduler.timer` — он стартанёт со сломанным токеном и служебной учёткой архивной роли. | `mv taskflow-scheduler.service taskflow-scheduler.service.disabled-2026-10-05` (по аналогии с `taskflow-trigger.service.disabled-2026-10-05`) и удалить `.timer`. | Низкий. |
| 10.2 | `server/scripts/scheduler.py:1-50` + `server/scripts/scheduler_watch.py:1-50` | После миграции планировщика in-process (01.10.2026) `scheduler.py` мёртв (его ветки переехали в `runtime/scheduler.ts:78-300`), а `scheduler_watch.py` всё ещё нужен и работает. | Сторож остаётся python-юнитом: его нельзя перенести в server-процесс без сетевого доступа к своему же filesystem-отпечатку (что неуклюже). Это **известное** — не баг. | `scheduler.py` удалить (см. п. 9.8). `scheduler_watch.py` оставить, но явно задокументировать в `AGENT-PROTOCOL.md`, что это сознательное исключение из «всё внутри сервера». | Низкий. |
| 10.3 | `server/scripts/scheduler_watch.py:30-37` (путь `HEARTBEAT`) | `HEARTBEAT = ~/.local/state/taskflow-scheduler/last-run.json` — захардкожен. Совпадает с дефолтом `runtime/scheduler.ts:25-26`, но если в проде зададут `TASKFLOW_SCHEDULER_HEARTBEAT` с другим путём, сторож будет проверять старый отпечаток. | Тихий отказ сторожа: он «зелёный», а реальный планировщик пишет в другое место. | Передать путь через `SCHEDULER_HEARTBEAT` env (читать и в `runtime/scheduler.ts`, и в `scheduler_watch.py`). | Низкий. |
| 10.4 | `server/src/runtime/scheduler.ts:171-189` (ветка 4 `launchScheduled`) | **Поправка после grep-верификации (05.10.2026):** строка в коде — 171–189 (а не «155-170» как в п. 6.11). Суть та же: ветка перенесена as-is из `scripts/scheduler.py` и не работает, потому что `run_at` сервер отдаёт только в карточке, не в списке. | Если владелец «включит» — стартанёт пачка с пустым `run_at` (точнее, не стартанёт, потому что regex `m` не сматчится; но это полуслучайно). | См. п. 6.11: `# pragma: OFF` или удалить ветку до решения. | Низкий. |
| 10.5 | `server/src/runtime/scheduler.ts:78` (комментарий «один в один со `scripts/scheduler.py`») | Комментарий устаревает: после удаления `scheduler.py` (п. 10.2) ссылка на него станет мёртвой. | Документ-источник для будущих правок. | В комментарии добавить «после 06.10.2026: ветки в runtime/scheduler.ts, scripts/scheduler.py удалён». | Низкий. |
| 10.6 | `server/src/routes/agent-service.ts:28-38, 87-115` (UI лампа «Расписание») | `schedulerState()` читает `last-run.json` через `fs.stat` и считает «свежесть». Если файл удалить/повредить, лампа покажет «неизвестно» — и UI не отличит «планировщик жив, файл съеден ротацией» от «планировщик мёртв». | Сторож (`scheduler_watch.py`) дублирует ту же проверку, но в notification-канал. Два независимых наблюдателя — OK; но если оба сломаются одинаково (например, `fs.stat` ENOENT), никто не узнает. | Лампа и сторож должны падать в один error-канал (например, `task_outcomes.last_scheduler_error`). | Низкий. |

### Предложение по итогу (одной строкой)

**Оставить `runtime/scheduler.ts` (живой) + `scheduler_watch.py` (сторож) + `taskflow-scheduler-watch.{service,timer}` (active). Удалить `taskflow-scheduler.service/.timer` (выключен, мина с архивным токеном) и `server/scripts/scheduler.py` (мёртв после миграции 01.10.2026). Зафиксировать `SCHEDULER_HEARTBEAT` env, чтобы сторож и in-process не разъехались по путям.**

**Проверка для области:** `systemctl --user status taskflow-scheduler.{service,timer} taskflow-scheduler-watch.{service,timer}`; `cat ~/.local/state/taskflow-scheduler/last-run.json`; `grep -n "source" server/src/runtime/scheduler.ts`; `grep -rn "TASKFLOW_SCHEDULER_HEARTBEAT\|last-run.json" server/src/ server/scripts/`.

---

## Аналитический блок: что прочитано целиком, что выжимкой, что не покрыто

(Дополнение к критериям приёмки: «явно перечислено, что прочитано целиком».)

### Прочитано целиком (grep подтверждает)

- `server/src/runtime/*` — 39 файлов, целиком (см. список в шапке Части 2).
- `server/src/lib/*` — 26 файлов, целиком.
- `server/src/roleRouting.ts`, `server/src/seed.ts` — целиком.
- `routes/research.ts`, `routes/role-run-jobs.ts`, `routes/reports.ts`, `routes/subtask-artifacts.ts`, `routes/consultation.ts`, `routes/agent-inbox.ts` — целиком.
- `runtime/scheduler.ts` — целиком (1–300), для области 10.
- `server/scripts/scheduler.py` (шапка + токен), `server/scripts/scheduler_watch.py` (шапка + логика) — для области 10.

### Прочитано выжимкой (grep + узлы)

- `routes/tasks.ts` (1960 строк) — узел 1246 (тумблер автономки).
- `routes/chat.ts` (1488) — узлы 48–140 (Hermes-webhook), 160–200 (`orchestratorId`).
- `routes/dispatch.ts` (820+) — узлы 50–180 (комментарий «Pi нет»), 160–220, 750–820 (`admitParentAfterChildren`).
- `routes/agent-state.ts` (1528) — узлы 60–200 (триггерные комментарии).
- `routes/agent-details.ts` (577) — узел 104 (`role === "orchestrator"`).
- `routes/projects.ts` — узел 607.
- `runtime/inProcessRun.ts` (1216) — узлы 1000–1100 (триггер), 550–560 (cwd).
- `runtime/roleHome.ts` (200+) — узлы 8–65 (валидация ключа роли), 74–100 (`renderSystemPrompt`).
- `runtime/roleWorkspace.ts` (200+) — целиком.
- `runtime/PiRuntimeAdapter.ts` (1443) — не читан.
- `routes/ai.ts` (1088) — только шапка.
- `server/src/db.ts`, `migrations.ts` (3210) — Часть 1; здесь не перечитывались.
- `AGENT-PROTOCOL.md` (частично, узлы 1–100, 355, 403, 607), `AGENT-API.md` (не читан), `INDEX.md`, `STATUS.md`, `dispatch_registry.md` — grep-выжимки.

### Не покрыто этой частью

- `routes/tasks.ts` (1960) и `routes/chats.ts` (1488) — общая матрица правок может скрывать находки, не видимые в выжимках.
- `routes/agent-state.ts` (1528) и `routes/agent-details.ts` (577) — то же.
- `runtime/PiRuntimeAdapter.ts` (1443) — самый большой runtime-файл, не читан.
- `routes/ai.ts` (1088) — большая часть связана с AI-вызовами, прочитано только начало.
- SQL-запросы в `migrations.ts` (3210) — точечно, не построчно.
- `server/test/` — не открывал.

### Поправки к Части 2 (по сравнению с черновиком исследователя)

| Пункт | Было (черновик) | Стало (после grep-верификации) |
|---|---|---|
| 6.4 | `PLANNING_TOOLS` оставляет `taskflow_plan_request` в режиме `plan` | **Снято как ошибочное**: в `chatWorkMode.ts:8-22` `taskflow_plan_request` НЕ перечислен, фильтр на `roleRunAccess.ts:86` отсекает. Поведение корректно. |
| 6.5 | Строка `99-101` (claim) | Реальная селект-строка — `roleRunQueue.ts:118-128` (SELECT внутри `db.transaction(claim)`); риск после `claim` остаётся, как описано. |
| 6.6 | `stopCurrentWorker` сбрасывается в `await loop` (`roleRunWorker.ts:108-112`) | Реально `stopCurrentWorker = null` стоит **внутри** самого `stopCurrentWorker` (после `await loop`), а `loop = null` — в `.finally(() => { loop = null; })` блока `tick()`. Гонка двух `startRoleRunWorker` возможна. |
| 6.8 | `planMutations.ts:325-330` (UPDATE subtasks) | Реально — `planMutations.ts:374`. |
| 6.10 | Проверка `current.done \|\| current.agent_state` стоит **снаружи** `db.transaction` | **Снято как ошибочное**: проверка `if (current.done || ...)` стоит ВНУТРИ `db.transaction` (строка 162), затем `acquired = db.transaction(...)`. Гонки нет. |
| 6.11 | Строка `155-170` (`launchScheduled`) | Реально — `scheduler.ts:171-189`. |

### Приоритеты для следующего исполнителя (правщика)

Топ-3 по сочетанию «риск × дёшево починить»:

1. **10.1 + 4.1** (Часть 1): две мины systemd-юнитов с архивным токеном — `mv .service .service.disabled-2026-10-05`, удалить `.timer`. Минута работы, риск 0.
2. **7.13, 7.14, 8.11, 8.20** (Часть 2) + **1.7** (Часть 1): захардкоженные id (`u1`, `u2`, `u3`, `u-secretary`) и мёртвые ветки Hermes. Один пакет мелких правок: убрать литералы, убрать `notifyHermesWebhook`, убрать `HERMES_USER_ID`, `TASKFLOW_WEBHOOK_SECRET` (если он только для этого).
3. **9.7–9.9** + **10.2**: удалить мёртвые скрипты `trigger.py`, `manual_run.sh`, `graft_refresh*.py`, `fix_clean_trigger.py`, `patch_trigger_fix.py`, `scheduler.py` (после согласования с п. 10.2).

### Где я (аналитик) не уверен

- **6.7, 6.8** — поведение `persist()` на черновике vs approved требует тестов, чтобы зафиксировать «add_step на черновике → нет subtask, на approved → есть». Сейчас это утверждение сделано по чтению кода, не по факту теста.
- **8.4, 8.5** — `lib/markdownToTiptap.ts:370` (длина) упомянута без проверки. Может быть 370 строк, а не строка 370.
- **6.5, 6.15** — гонки описаны качественно (есть/нет), но точные строки называл приблизительно (нужна прицельная верификация перед правкой).
- **7.20, 8.21** — упомянуты выжимкой; полная проверка не делалась.

---

## Сводка по областям (Часть 2)

- **Runtime** — главная проблема: частичная миграция «Супер Секретарь» (п. 6.1, 7.1, 7.22) и активные комментарии, ссылающиеся на «trigger.py», который ещё не удалён (п. 6.1, 8.14, 9.7). Решается одной связкой: удалить мёртвые скрипты + обновить комментарии.
- **Lib** — тихие fallback'ы (п. 7.5, 7.10, 7.15, 7.16, 7.18), неочевидные гонки (п. 6.5, 6.6, 6.15), и пара зашитых id (п. 7.13, 7.14, 8.11, 8.20). Решается серией мелких, безопасных правок. (П. 6.10 снят — гонки нет, проверка в транзакции; п. 6.4 снят — PLANNING_TOOLS корректно отсекает `taskflow_plan_request`.)
- **Маршруты** — Часть 1, п. 2.1 (`loadCatalog` silent fallback) повторяется в `agent-inbox.ts` (п. 8.9); Hermes-webhook (п. 8.11) — полностью мёртвая ветка с реальной env-переменной.
- **Документы** — синхронизировать с решениями Части 1 (п. 9.1-9.5) и удалить мёртвые скрипты (п. 9.7-9.9).
- **Планировщик (область 10, дополнение оркестратора)** — живой `runtime/scheduler.ts` + сторож `scheduler_watch.py`; на диске лежит выключенный systemd-юнит с архивным токеном (та же мина, что `taskflow-trigger.service`). Решается `mv` в `.disabled-2026-10-05` (п. 10.1) и удалением `scripts/scheduler.py` (п. 10.2).

## Что НЕ покрыто этой частью (для возможной части 3)

- `routes/tasks.ts` (1960 строк) и `routes/chats.ts` (1488) прочитаны **только узлами** — общая матрица правок в них может скрывать находки, не видимые в выжимках.
- `routes/agent-state.ts` (1528 строк) и `routes/agent-details.ts` (577) — то же.
- `runtime/inProcessRun.ts` (1216 строк) и `runtime/PiRuntimeAdapter.ts` (1443) — самые большие файлы, узлы выборочно. Целиком не читал.
- `routes/ai.ts` (1088) — большая часть связана с AI-вызовами; прочитано только шапка + grep.
- SQL-запросы в `migrations.ts` (3210) — точечно, не построчно.
- Тесты в `server/test/` — не открывал.

## Связи с Частью 1 (решения по вопросам)

- Решение 1 (оркестратор — одна роль): подтверждается п. 8.12, 8.13, 8.21. Правка `orchestratorId` и аналогичных — общий шаг.
- Решение 2 (маршрутизация через role-routing.yaml): подтверждается п. 6.1 (комментарии), 7.15-7.16 (ветки Hermes/antigravity), 8.9-8.10 (agent-inbox). Один пакет правок.
- Решение 3 (taskflow-trigger.service выключить): подтверждается п. 6.1, 8.14, 9.7. Распространяется на п. 10.1 (`taskflow-scheduler.service` — та же мина, тот же класс правки: `mv .service .disabled-2026-10-05`).
- Решение 4 (084_* не переименовывать): вне области Части 2.
- Решение 5 (claude_bot из team_catalog.json): подтверждается п. 7.15, 8.9, 8.10, 9.4, 9.5.
- Решение 6 (pi_agent из PROFILE_ROLE): подтверждается п. 6.15-6.16 (через team_catalog.json), 7.15-7.16.

## Открытые хвосты (для следующего аудита)

- 7.13, 7.14: владелец должен явно подтвердить, какой `users.id` считать «владельцем» в продакшен-БД (если `TASKFLOW_OWNER_ID` пуст, ОБЯЗАН быть fallback по `role='owner' AND archived=0`).
- 8.11: подтвердить, что `TASKFLOW_WEBHOOK_SECRET` не используется нигде, кроме `chat.ts:79`.
- 8.20: подтвердить, что `seed.ts` никогда не вызывается на проде (сейчас гейт — только `NODE_ENV=production`).
- 8.25: решить судьбу `synthesizer.md` (вернуть роль или удалить файл).
- 6.11: владелец должен явно решить, что делать с веткой 4 scheduler (удалить, выключить, дописать).
- 10.2, 10.3: подтвердить, что `scripts/scheduler.py` правда не нужен (после `startScheduler` в `runtime/scheduler.ts` он мёртв) и что `TASKFLOW_SCHEDULER_HEARTBEAT` не задан в проде. Если задан — поправить и `scheduler_watch.py` (env `SCHEDULER_HEARTBEAT`).
