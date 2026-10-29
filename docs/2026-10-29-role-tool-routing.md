---
id: taskflow-role-tool-routing
project: taskflow-server
category: architecture
status: verified
last_verified: 2026-10-29
verified_commit: 9594291d
verification_evidence:
  - "vitest: 5 файлов / 34 теста зелёные (roleToolCatalog, roleToolScope, nativeToolLoading, nativeToolSchemas, toolRequestStore), --maxWorkers=4, Node v22.23.1"
  - "живая БД .110 прочитана в режиме mode=ro"
  - "git log по roleToolScope.ts, noteSearch.ts, knowledgeSync.ts, kbSearchWatcher.ts"
sources:
  - kind: code
    repo: taskflow-server
    path: server/src/runtime/roleToolCatalog.ts
    symbol: buildRoleToolCatalog
    commit: 9594291d
  - kind: code
    repo: taskflow-server
    path: server/src/lib/roleToolScope.ts
    symbol: roleToolAllowed
    commit: 9594291d
  - kind: code
    repo: taskflow-server
    path: server/src/runtime/nativeToolLoader.ts
    symbol: createToolLoader
    commit: 9594291d
  - kind: code
    repo: taskflow-server
    path: server/src/runtime/errorLoopStop.ts
    symbol: MISTAKE_LIMIT
    commit: 9594291d
  - kind: code
    repo: taskflow-server
    path: server/src/runtime/toolAuditStore.ts
    symbol: recordToolAudit
    commit: 9594291d
  - kind: doc
    repo: taskflow-server
    path: docs/2026-10-28-role-tool-audit.md
  - kind: doc
    repo: taskflow-server
    path: docs/2026-10-29-owner-decisions.md
  - kind: history
    repo: taskflow-server
    commit: 5c3734ec
    note: "taskflow_kb_search переведён с RAGFlow на внутренний поиск по заметкам"
related:
  - taskflow-knowledge-search-path
  - taskflow-library-curation
---

# Маршрутизация инструментов ролей

## Назначение

Механизм решает одну задачу: **какая роль, в каком ходе, каким набором инструментов
обращается к модели и что происходит, если она вызывает инструмент неверно или
не тот**.

Он же отвечает на четыре вопроса, которые важны для живой базы знаний:

1. Какие операции роль вообще может вызвать (права).
2. Что уходит в запрос к модели, а что подключается по требованию (экономия и шум).
3. Где фиксируется факт вызова — чтобы утверждение «роль это сделала» можно было
   проверить, а не поверить.
4. Что происходит при неверном вызове — чтобы знание о поломке не терялось.

Компонент серверный. Нативный клиент и веб-клиент в границы не входят.

## Границы

- Охватывает серверную часть (`server/` в репозитории `New-Todoist`, живая копия
  на .110, порт 3001).
- Не охватывает нативный iOS-клиент (`TaskFlowNativeBuild` на Mac) и веб-клиент
  (заморожен по прямому указанию владельца 24.10.2026).
- Не описывает сам Pi SDK: здесь только то, что TaskFlow задаёт поверх него.
- Не описывает права на уровне HTTP-маршрутов; только права на уровне операций роли.

## Входы

| Вход | Источник | Что даёт |
|---|---|---|
| `role`, `model`, `taskId`, `subtaskId`, `chatId`, `messageId`, `executionMode`, `runId` | `CatalogContext`, `server/src/runtime/roleToolCatalog.ts:57` | кто и в каком контексте работает |
| `adapters` | вызывающий код | внешние инструменты, добавляемые к операциям TaskFlow |
| `~/taskflow/roles/<роль>/AGENTS.md` | `roleHome.ts:14`, `roleHomeInstruction` (`roleHome.ts:33`) | собственная инструкция роли |
| `~/taskflow/roles/<роль>/ROLE.md` | `roleContextResolver.ts:218` | личность роли |
| `~/taskflow/roles/<роль>/behavior.json` | каталог роли | сохранённые настройки поведения |
| `server/scripts/role-system-prompt.md` | `systemPromptSourceFile()` (`roleHome.ts:75`) | общий системный промпт ролей |
| `user_ai_prompts` | `roleContextResolver.ts:288` | переопределения владельца поверх слоёв инструкций |

## Выходы

| Выход | Где | Что это |
|---|---|---|
| `customTools` | `roleToolCatalog.ts:171` | массив инструментов сессии: `[universal, ...aliases, loader.tool]` — первым идёт единый шлюз |
| `activeNames` | `roleToolCatalog.ts:170` | что реально активно в сессии: ядро + загрузчик |
| `registeredNames` | `roleToolCatalog.ts:171` | полный реестр операций, доступных роли (ядро + всё, что ей по праву) + загрузчик |
| `operations` | `roleToolCatalog.ts:171` | сырой список операций после фильтра по режиму |
| `scope` | `onDemandScopeKey` (`nativeToolLoader.ts:25`) | ключ памяти подключённых по требованию операций: роль + чат/задача |
| `onToolExecutionEnd` | `roleToolCatalog.ts:166` | разбор отказа SDK: автоподключение, отсев, счётчик ошибок |
| `attachSession` | `roleToolCatalog.ts:172` | привязка загрузчика к сессии Pi |
| запись аудита | `recordToolAudit` (`toolAuditStore.ts:129`) | факт вызова: инструмент, результат, код ошибки |

## Поток данных

1. **Сбор операций.** `taskflowTools(role, model, taskId, subtaskId, true, {chatId, messageId})`
   (`roleToolCatalog.ts:63`) даёт операции TaskFlow; сверху добавляются
   `roleHostAccessTools`, `createHostRoleTools`, инструменты вызова роли-субагента
   и `adapters`.
2. **Два способа доступа к операциям.** Кроме отдельных операций есть **единый
   шлюз `taskflow`** с действиями `discover` / `describe` / `invoke`
   (`universalTaskflow.ts:883-885`, описание — `universalTaskflow.ts:821`).
   Через него роль ищет операцию по смыслу, получает её схему и только затем
   вызывает. Шлюз стоит первым в `customTools` (`roleToolCatalog.ts:171`).
   Ошибки шлюза объясняют права, режим и недостающий контекст
   (`universalTaskflow.ts:282-290, 429`).
3. **Отсев по режиму.** `operations.filter(t => !operationRestriction(t.name, context))`
   (`roleToolCatalog.ts:88`) — операция, запрещённая в текущем режиме, не попадает
   в набор вовсе.
4. **Проверка прав.** `authorize` (`roleToolCatalog.ts:61`) → `roleToolAllowed(role, name)`
   (`roleToolScope.ts:51`): списки `ONLY` (`roleToolScope.ts:8`) и `DENY`
   (`roleToolScope.ts:43`), плюс частные правила — `taskflow_claim` запрещён
   при заданном `subtaskId`, `taskflow_subtask_done` запрещён роли `critic_verifier`
   (`roleToolCatalog.ts:62`), а для `secretary` запрещено всё, что содержит
   `delete|purge|remove` (`roleToolScope.ts:57`).
5. **Обёртка вызова.** Каждая операция оборачивается (`roleToolCatalog.ts:88`):
   - `Check(tool.parameters, own)` — проверка схемы до действия; при несовпадении
     `INVALID_ARGUMENTS` с перечислением полей;
   - `request_id` отсекается от аргументов — это служебное поле прежнего шлюза;
   - для операций записи (`isReadOperation` → false) `toolRequestStore` даёт
     идемпотентность: повтор с тем же `request_id` возвращает прежний результат,
     а не делает действие второй раз;
   - каждый вызов пишется в аудит через `recordToolAudit`.
6. **Ядро и подключение по требованию.** `CORE_OPERATIONS`
   (`roleToolCatalog.ts:22`) — операции, без которых ход не начинается и не
   закрывается. `core = aliases.filter(...)` (`roleToolCatalog.ts:167`) →
   `activeNames` (`roleToolCatalog.ts:170`). Остальное не активно, пока роль не
   подключит его через загрузчик `taskflow_tools`
   (`TOOL_LOADER_NAME`, `nativeToolLoader.ts:17`), который показывает индекс
   операций и подключает нужную. `rememberOnDemandTool(scope, name)`
   (`nativeToolLoader.ts:29`) запоминает подключение в пределах роли и
   чата/задачи; `installNativeToolCore` (`roleToolCatalog.ts:190`) при новом ходе
   возвращает ранее подключённые операции в активный набор.
   **Модель при этом знает все имена:** в запрос уходит
   `[...builtin, ...toolCatalog.registeredNames]` (`PiRuntimeAdapter.ts:1579`),
   а активными остаются только `activeNames` и подключённые по требованию.
   Отсюда и «не найдено»: операция известна, но не активна.
7. **Схемы.** `installNativeToolSchemas` (`roleToolCatalog.ts:198`) →
   `restoreNativeToolSchemas` (`roleToolCatalog.ts:177`): Pi-конвертер Anthropic
   теряет корневые ограничения JSON Schema, поэтому исходная схема
   восстанавливается. Схемы с `strict=true` не трогаются — это нормализация SDK.
8. **Отказ SDK.** `onToolExecutionEnd` (`roleToolCatalog.ts:166`):
   - «not found» → `TOOL_NOT_CONNECTED`: операция подключается сама из реестра
     роли (права не расширяются), и это **не** считается неверным вызовом;
   - серверный отказ (`isServerRefusal`) → ошибкой роли не считается;
   - иначе — `INVALID_ARGUMENTS` с разбором поля и ожидаемого типа из текста
     отказа; счётчик по инструменту; на третьем одинаковом отказе
     (`MISTAKE_LIMIT = 3`, `errorLoopStop.ts:15`) — `stopRoleOnErrorLoop`
     (`errorLoopStop.ts:46`) останавливает ход роли.

## Зависимости

```
inProcessRun.ts ──► roleToolCatalog.buildRoleToolCatalog ──► universalTaskflow.createUniversalTaskflow
                            │                                        │
                            ├── roleToolScope.roleToolAllowed         └── taskflow_* (операции)
                            ├── nativeToolLoader.createToolLoader
                            ├── toolRequestStore (идемпотентность записи)
                            ├── toolAuditStore.recordToolAudit (факт вызова)
                            └── errorLoopStop.stopRoleOnErrorLoop (стоп после 3 ошибок)
```

Отдельные подсистемы, к которым ведёт этот компонент:

- **Поиск по знаниям** — `taskflow_kb_search` → `searchNotes`
  (`server/src/lib/noteSearch.ts:42`), прямой поиск по таблице `user_notes`.
- **Документы** — `taskflow_docs` (`inProcessRun.ts:756`), `taskflow_doc_read`
  (`inProcessRun.ts:766`), `taskflow_doc_write` (`inProcessRun.ts:770`).
- **Контекст роли** — `roleContextResolver.LAYER_CATALOG`
  (`roleContextResolver.ts:99`): слои инструкций с явным источником
  (`originRef`), режимами и признаком «только чтение».

## Конфигурация

| Переменная | Где | Смысл |
|---|---|---|
| `TASKFLOW_ROLES_DIR` | `roleHome.ts:17` | где лежат `AGENTS.md`/`ROLE.md` ролей; по умолчанию `~/taskflow/roles` |
| `RAGFLOW_API`, `RAGFLOW_TOKEN`, `RAGFLOW_TASKFLOW_DATASET` | `knowledgeSync.ts:27-29` | вторичный индекс заметок; без них поиск по RAGFlow молчит |
| `TASKFLOW_KB_SYNC_DIR` | `knowledgeSync.ts:157` | состояние синхронизации заметок с RAGFlow |
| `KB_SEARCH_PROBE_QUERY`, `KB_SEARCH_PROBE_DOC` | `kbSearchWatcher.ts:28-31` | эталон пробного запроса сторожа |
| `KB_SEARCH_WATCHER_DISABLED=1` | `kbSearchWatcher.ts` | выключатель сторожа |

## Ограничения и известные дефекты

1. **Шум в запросе.** Описания всех операций уходят в каждый запрос, а роль
   регулярно пользуется 11–17 операциями из 30 (`roleToolScope.ts:1-6`).
   Ядро и загрузчик снимают часть этого, но не всё.
2. **Поиск по знаниям не ограничен проектом.** `taskflow_kb_search` ищет по всем
   заметкам TaskFlow всех проектов, включая закрытые
   (`server/src/runtime/instructionDefaults.ts:568`; вызов — `inProcessRun.ts:806`).
   Это осознанное решение, а не дефект, но его надо знать при проектировании
   прав: ограничения по проекту в механизме нет.
3. **Запись в чужую заметку не ограничена ролью.** `taskflow_doc_write` с `id`
   дописывает текст в существующую заметку (`inProcessRun.ts:782`:
   `cur.markdown.trimEnd() + "\n\n" + p.markdown`) и правит её через
   `PATCH /api/notes/:id` (`server/src/routes/notes.ts:209`), который проверяет
   только аутентификацию — ни роли, ни папки, ни признака канона. Канон при
   этом не стирается, но и не отличим от дописанного. Тот же инструмент может
   создать заметку прямо в подпапке Library (`library_subfolder`).
4. **Пометка «мусор» доступна всем ролям.** `taskflow_kb_categorize`
   (`inProcessRun.ts:814`) не входит ни в `ONLY`, ни в `DENY`
   (`roleToolScope.ts:8,43`) и пишет прямо в `user_notes` (`inProcessRun.ts:845-849`).
   Ветка «мусор» ставит `kb_category = NULL, kb_temp_category = 'мусор'` —
   заметка выпадает из ролевого среза, а текст, автор и дата не меняются.
   Следа правки не остаётся.
5. **Роль не видит канон владельца по умолчанию.** Ролевой срез
   (`collectRoleSlice`, `server/src/runtime/roleSlice.ts:44-52`) выбирает
   заметки с условием `updated_by = ?` — то есть только записанные самой
   ролью. Канон владельца в срез не попадает; роль узнаёт о нём лишь через
   явный `taskflow_kb_search`. В чате среза нет вовсе — он подставляется
   только в карточном пути.
6. **Сторож поиска сторожит не тот путь.** См. раздел «Расхождения» ниже.
7. **`taskflow_docs` видит только папку документации одного проекта.**
   Заметки Library и папок задач через него недоступны — их видно только
   через `taskflow_kb_search` и `taskflow_library`.

## Расхождения, найденные при проверке

> Раздел помечен статусом `outdated` относительно кода. Это пример того, как
> должна выглядеть проверка: утверждение из документа сверяется с кодом и
> фиксируется расхождение, а не молча исправляется.

**Утверждение документа:** `docs/watchers.md`, раздел 6 «Поиск по базе знаний
(RAGFlow)» — «Прибор: `GET /api/knowledge/search` … и `taskflow_kb_search` —
«гейт незнания» ролей».

**Что в коде:** сторож `kbSearchWatcher` (`kbSearchWatcher.ts:37`) делает пробный
запрос только к RAGFlow (`/api/v1/retrieval`). Роль с 13.10.2026 ходит в другой
путь: коммит `5c3734ec` «fix(kb-search): поиск по базе знаний идёт по заметкам
TaskFlow, а не во внешний сервис» заменил вызов
`GET /api/knowledge/search` на прямой поиск `searchNotes` по таблице `user_notes`
(`inProcessRun.ts:806`, `server/src/lib/noteSearch.ts:42`).

**Почему это не поправлено:** коммит 13.10.2026 менял три файла
(`server/src/lib/noteSearch.ts`, `server/src/runtime/inProcessRun.ts`,
`server/test/noteSearch.test.ts`) — `docs/watchers.md` в него не вошёл.

**Последствие:** путь, которым реально пользуются роли, пробой не проверяется.
Сторож по-прежнему видит только исправность RAGFlow. Если сломается
`searchNotes` (или его индекс), роли получат пустую выдачу — ровно тот сценарий,
ради которого сторож и заводился 21.10.2026 (`docs/watchers.md`, раздел 6,
«Инциденты»).

**Что предлагается:** не отменять сторож, а добавить ему вторую пробу — на
внутренний путь поиска, по образцу уже описанному в `docs/watchers.md`
(«Как добавить сторожа»): пробный ход с известным ответом, тревога не чаще
раза в сутки, запись в `docs/watchers.md`, тест «сторож молчит, когда всё хорошо».

## Способы проверки

**Целевые тесты** (изолированная БД, потолок `--maxWorkers=4`):

```sh
cd server
npx vitest run test/roleToolCatalog.test.ts test/roleToolScope.test.ts \
  test/nativeToolLoading.test.ts test/nativeToolSchemas.test.ts \
  test/toolRequestStore.test.ts --maxWorkers=4
```

Факт от 29.10.2026: **5 файлов, 34 теста, все зелёные** (Node v22.23.1,
коммит `9594291d`). Полный набор на .110 не гонять — там живут API и роли.

**Живая проверка:** штатные адреса `/api/role-tool-audit/summary` и
`/api/role-tool-audit/export` (сервер на .110, `localhost:3001`). Разбор за
28.10.2026: `docs/2026-10-28-role-tool-audit.md`, сырые отказы —
`docs/2026-10-28-role-tool-audit-records.csv`.

**Что документ НЕ доказывает.** Он описывает серверный механизм по исходникам и
тестам. Он не доказывает, что каждая роль в бою пользуется ядром так, как
предполагает `_CORE_OPERATIONS`; для этого нужен разбор живого аудита по ролям.
Он также не утверждает, что внешний CLI-runtime получает тот же набор
инструментов: `installNativeToolSchemas` (`roleToolCatalog.ts:198`) уходит из
сессии без собственного транспорта — у внешнего рантайма свой набор.

## Источники

Все пути — относительно репозитория `New-Todoist`, проверено на коммите
`9594291d` (ветка `main`, .110).

| Что | Где | Проверено |
|---|---|---|
| Сбор каталога, ядро, обёртка вызова, отказ SDK | `server/src/runtime/roleToolCatalog.ts` | прочитан целиком; тесты `roleToolCatalog.test.ts` (9) |
| Права по ролям | `server/src/lib/roleToolScope.ts` | прочитан целиком; тесты `roleToolScope.test.ts` (4) |
| Единый шлюз `taskflow` (discover/describe/invoke) | `server/src/runtime/universalTaskflow.ts:278-290,821,883-885` | прочитан; тексты отказов — источник подсказок роли |
| Что уходит в запрос к модели | `server/src/runtime/PiRuntimeAdapter.ts:1579-1580` | прочитан |
| Загрузчик по требованию | `server/src/runtime/nativeToolLoader.ts` | прочитан; тесты `nativeToolLoading.test.ts` (10) |
| Схемы инструментов | `server/src/runtime/roleToolCatalog.ts:177,198` | тесты `nativeToolSchemas.test.ts` (7) |
| Идемпотентность записи | `server/src/runtime/toolRequestStore.ts` | тесты `toolRequestStore.test.ts` (4) |
| Стоп после трёх неверных вызовов | `server/src/runtime/errorLoopStop.ts:15,46` | прочитан |
| Аудит вызовов | `server/src/runtime/toolAuditStore.ts:129` | прочитан; тесты `roleToolAudit.test.ts` |
| Поиск по заметкам | `server/src/lib/noteSearch.ts:20,42` | прочитан; тесты `noteSearch.test.ts` |
| Операции документов | `server/src/runtime/inProcessRun.ts:756,766,770,804,814` | прочитаны; живая БД прочитана в режиме `mode=ro` |
| Права на запись заметки | `server/src/routes/notes.ts:209` | прочитан |
| Разметка знаний | `server/src/lib/kbCategories.ts:13-29` | прочитан |
| Ролевой срез знаний | `server/src/runtime/roleSlice.ts:44-52` | прочитан |
| Права на подтверждение (прецедент) | `server/src/routes/agent-rules.ts:60-64`, `server/src/runtime/chatTools.ts:113,134` | прочитаны |
| Слои инструкций роли | `server/src/lib/roleContextResolver.ts:99,218,237` | прочитан |
| Синхронизация с RAGFlow | `server/src/lib/knowledgeSync.ts:237,359` | прочитан; живое состояние `~/.local/state/taskflow-docs-sync` |
| Сторож поиска | `server/src/lib/kbSearchWatcher.ts:37,127` | прочитан; `docs/watchers.md` §6 |
| История перевода поиска | коммит `5c3734ec` от 13.10.2026 | `git log -S`, `git show` |

## Связанные записи

- `docs/2026-10-28-role-tool-audit.md` — разбор отказов ролевых вызовов за день.
- `docs/2026-10-29-owner-decisions.md` — договорённости с владельцем (в т.ч. по
  модели субагента и по правам на вызов роли).
- `docs/watchers.md` — реестр сторожей и правило «как добавить сторожа».
- `docs/2026-10-29-living-knowledge-audit.md` — аудит базы знаний и предложение.
