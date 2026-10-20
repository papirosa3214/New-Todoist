# Единый JSON-протокол ролей: что осталось (20.10.2026)

Сделано 17–19.10: финальный ответ роли в чате — JSON v1 (`roleContractV1.ts`), сервер валидирует и нормализует (`chat_messages.role_envelope_json`), промпты 10 ролей обновлены. Не закрыто: MiniMax без structured output (держится промптом + нормализацией), живая проверка всех 10 ролей не завершена (`LOCK-ALL-ROLES-JSON-OUTPUT` IN_PROGRESS).

Где роли ещё пишут/читают markdown:

| # | Где | Сейчас |
|---|---|---|
| 1 | Сдача шага `taskflow_subtask_done` | `result` + `report_markdown` текстом |
| 2 | Постановка карточки (description) | Markdown с 4 разделами |
| 3 | `taskflow_report` | markdown → HTML/PDF |
| 4 | Комментарии к карточкам | свободный текст |
| 5 | `taskflow_doc_write` | markdown |
| 6 | Инструкции ролей, `agentRules` | markdown-промпты |

Заметки/дневник (`notes.ts`, Obsidian) остаются markdown — зона владельца.

Предложение: роли пишут и получают только JSON по одной схеме; в markdown его рендерит интерфейс при показе владельцу.

## Решение владельца (20.10.2026)

- Переводятся все места, где роли пишут: описание карточки (только `brief`, убрать `description`-markdown и правку в `task-brief.json`), сдача шага (`result`/`report_markdown`), отчёт, комментарии, документы проекта.
- Показ владельцу — только нашим рендером JSON → читаемый вид: телефон (iOS-клиент) обязательно, веб-десктоп и будущее десктоп-приложение тоже.
- Markdown остаётся только в заметках/дневнике владельца.
- Документы проекта роли тоже пишут в JSON; владелец видит их нашим рендером и при необходимости **экспортирует в Markdown** (кнопка экспорта — часть работы). Markdown — только формат выгрузки для владельца, не формат хранения.

## Разбор 20.10.2026: Todoist, виджеты, команда с Play

**Сделано:** короткий вызов `{operation, arguments}` (`1a6069d5`, `5b0d0541`), остановка после 3 ошибок подряд (`15b837c8`), 20 действий Things — отдельные операции (`f5203b4e`). Выложено в 18:03 до Things; Things ещё не выложен.

**Todoist** — через Composio: три мета-инструмента `COMPOSIO_SEARCH_TOOLS` → `COMPOSIO_GET_TOOL_SCHEMAS` → `COMPOSIO_MULTI_EXECUTE_TOOL` (`PiRuntimeAdapter.ts:1319`). Вызов в четыре уровня: `{operation:"mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", arguments:{tools:[{tool_slug:"TODOIST_CREATE_TASK", arguments:{…}}]}}` — та же болезнь, что была у Things. Лечение то же: развернуть разрешённые действия Todoist в отдельные операции `todoist_*`.

**Виджеты** — два пути: (1) типизированные блоки JSON v1 в `output` (`table`, `progress`, `chart`, `diagram`, `status`, `list`, `report`; `roleContractV1.ts:62`); (2) старые ```widget-блоки с JSON внутри markdown-текста (чат и описание карточки, `widgetNormalize.ts`). Второй путь — markdown, по решению владельца уходит.

**Команда с Play** — есть только в iOS: `BashCommandBlock.swift` рисуется из ```bash в markdown-ответе (`RoleReplyMarkdown.swift:177`), кнопка «Запустить на .110». В вебе такого нет. В JSON v1 типа блока «команда» нет — значит в JSON-ответе кнопка держится только на markdown внутри text-блока. Нужен тип блока `command` в v1 + рендер в iOS и вебе.

## Один источник инструкций роли (20.10.2026, решение владельца: «один источник и только JSON»)

Сейчас промпт роли в заходе = первое непустое из: (1) `role_context_overrides` слой `role.prompt` (редактор в приложении, RoleContextSheet), (2) `roles.prompt` в БД, (3) `server/scripts/role-prompts/<роль>.md`; плюс (4) `~/taskflow/roles/<роль>/AGENTS.md` подмешивается загрузчиком ресурсов. Находки: у analyst и secretary действует override (правка `roles.prompt` не доходит); у code_orchestrator в override нет JSON-контракта; контракт дублируется промптом и AGENTS.md.

План:
1. Каждой роли — её `AGENTS.md` (текст из действующего override → иначе БД → иначе role-prompts), только своё: задачи, стиль, границы.
2. Общее (JSON v1, список блоков, вызов taskflow) сервер генерирует из схемы валидатора и вставляет сам.
3. Сервер в заходе и чате читает только `AGENTS.md` + общий блок.
4. Редактор инструкций пишет в `AGENTS.md` (git-коммит), не в БД.
5. `roles.prompt`, override `role.prompt`, `scripts/role-prompts/` — убрать после переноса. Копии: `~/.local/state/taskflow-role-prompts-backup-20261020`.
Отдельно: `role.json` (модель, инструменты, интеграции) — следующим шагом.
