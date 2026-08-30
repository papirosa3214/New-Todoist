---
name: taskflow-agent
description: Работай с доской TaskFlow под своей учёткой через 21 нативный tool-вызов taskflow_*. Загружай этот скилл, когда в каталоге видны любые из taskflow_status / taskflow_my_tasks / taskflow_task / taskflow_claim / taskflow_heartbeat / taskflow_state / taskflow_subtask_work / taskflow_subtask_done / taskflow_subtask_add / taskflow_comment / taskflow_rules / taskflow_agents / taskflow_projects / taskflow_project_tasks / taskflow_create_task / taskflow_create_project / taskflow_suggest_subtasks / taskflow_structure_dictation / taskflow_docs / taskflow_doc_read / taskflow_doc_write, либо когда задача звучит как «посмотри мои задачи», «возьми в работу», «сдай на review», «оставь комментарий», «заведи задачу», «разбери проект», «прочитай документацию» и речь про TaskFlow (НЕ про MCP-сервер Python — он остаётся отдельным процессом на .110).
---

# Работа с TaskFlow из DSH через нативные tools

Этот скилл описывает, как пользоваться плагином `taskflow-bridge` (pluginId `tfwb-1`), который регистрирует те же 21 метод, что и MCP-сервер `server/scripts/mcp_server.py`, но ходит к Fastify напрямую по REST, без отдельного процесса.

## Твоя учётка

- **name:** DeepSeek-Agent
- **id:** `b85212d6-abab-4afb-a4c6-0d379b6537a4`
- **vault-ключ:** `TASKFLOW_DEEPSEEK_TOKEN`
- **НЕ используй** `TASKFLOW_AGENT_TOKEN` (это `Claude_Bot`, чужая учётка) и `TASKFLOW_HERMES_TOKEN` (это `Hermes`).

## Какие tools доступны

| Tool | Что делает | HTTP |
|---|---|---|
| `taskflow_status` | Живость сервера, кто на связи, что в работе / брошено / на review / blocked | GET `/api/agents` + `/api/tasks` |
| `taskflow_my_tasks` | Мои задачи (по `assignee_id == me`). Фильтр `state`, флаг `include_completed` | GET `/api/auth/me` + `/api/tasks` |
| `taskflow_task` | Карточка задачи с лентой | GET `/api/tasks/:id` |
| `taskflow_claim` | Взять задачу в работу (аренда 15 мин) | POST `/api/tasks/:id/claim` |
| `taskflow_heartbeat` | Продлить аренду | POST `/api/tasks/:id/heartbeat` |
| `taskflow_state` | `review` / `blocked` / `in_progress` (comment обязателен для review/blocked) | POST `/api/tasks/:id/state` |
| `taskflow_subtask_work` | Шаг: `in_progress` / `blocked` (result обязателен) / `null` (отпустить). `review` на шаге запрещён | POST `/api/subtasks/:id/work` |
| `taskflow_subtask_done` | Закрыть шаг (или снять отметку, `done=false`). `result` обязателен при `done=true` | **PATCH** `/api/subtasks/:id` |
| `taskflow_subtask_add` | Добавить шаг; `after_id` — встанет сразу за указанным | POST `/api/tasks/:taskId/subtasks` |
| `taskflow_comment` | Комментарий в ленту; `files` — пути, заливаются и прикрепляются | POST `/api/tasks/:id/attachments` + `/comments` |
| `taskflow_rules` | Правила ведения учёта (как требует сервер) | GET `/api/agent/rules` |
| `taskflow_agents` | Кто в команде и кто на связи | GET `/api/agents` |
| `taskflow_projects` | Проекты и их id | GET `/api/projects` |
| `taskflow_project_tasks` | Задачи проекта (по сроку). `project` либо `project_id` | GET `/api/projects` (lookup) + `/api/tasks` (filter) |
| `taskflow_create_task` | Завести задачу; `subtasks` опционально | POST `/api/tasks` |
| `taskflow_create_project` | Завести проект; `with_docs=true` по умолчанию | POST `/api/projects` |
| `taskflow_suggest_subtasks` | AI-разбивка на подзадачи. `id` существующей задачи ЛИБО `title` черновика. Ничего не сохраняет | POST `/api/tasks/:id/suggest-subtasks` или `/api/ai/suggest-subtasks` |
| `taskflow_structure_dictation` | AI-разбор сырого текста в задачу. Ничего не сохраняет | POST `/api/ai/structure-task` |
| `taskflow_docs` | Папка и список заметок проекта | GET `/api/projects/:id/docs` |
| `taskflow_doc_read` | Прочитать заметку целиком (markdown) | GET `/api/notes/:id?format=markdown` |
| `taskflow_doc_write` | Создать/дополнить/перезаписать заметку. `markdown` обязателен, `mode=append` по умолчанию | POST `/api/notes` или PATCH `/api/notes/:id` |

> **Не путай:** `taskflow_subtask_done` — это **PATCH** на `/api/subtasks/:id`, а не POST. Схема MCP-сервера использует тот же эндпоинт, имя `done` — обманчиво.

## Базовый цикл работы

1. **Проверь живость** — `taskflow_status`. Если служба не на дежурстве — пиши в `STATUS.md` и не начинай.
2. **Посмотри свои задачи** — `taskflow_my_tasks(state="free")` (или `in_progress`, `review`, `blocked`).
3. **Выбери задачу**, прочитай карточку — `taskflow_task(id)`.
4. **Возьми в работу** — `taskflow_claim(id)`. Дальше у тебя 15 минут.
5. **Начал шаг** — `taskflow_subtask_work(id, state="in_progress")`. Без этого лента выглядит как тишина.
6. **Закрыл шаг** — `taskflow_subtask_done(id, done=true, result="что сделал — одно-два предложения")`. `result` обязателен.
7. **Продлевай аренду** — `taskflow_heartbeat(id)` хотя бы раз в 5 минут.
8. **Все шаги закрыты** — ОДИН раз `taskflow_state(id, state="review", comment="что сделано")`. Закрывает задачу владелец, не ты.
9. **Упёрся по-настоящему** — `taskflow_state(id, state="blocked", comment="что нужно от владельца")`.

## Правила, которые сервер реально проверяет

| Правило | Что будет, если нарушить |
|---|---|
| `result` обязателен в `taskflow_subtask_done` (если у шага его ещё нет) | 400, шаг не закроется |
| `review` запрещён на отдельном шаге | 400, приёмка шагов отменена |
| `comment` обязателен для `taskflow_state` с `review` или `blocked` | 400 |
| Переход `review → in_progress` запрещён | 400, агент не может забрать сданную работу |
| Молчание > 20 минут → предупреждение; > 45 минут → авто-`blocked` | Другой агент или владелец перехватит |

## Если плагин не подключён

В каталоге нет `taskflow_*` — значит, плагин `tfwb-1` не запущен в этой сессии. Не пытайся вызывать — хост вернёт «tool not found». Скажи владельцу: «подними taskflow-bridge, pluginId `tfwb-1`, последний package» — этого достаточно.

Если хочется работать с TaskFlow без плагина — есть запасной путь через `bash` + `curl` с тем же токеном `TASKFLOW_DEEPSEEK_TOKEN`, эндпоинты в таблице выше. Это медленнее и шумнее, но контракт тот же.

## Чего плагин НЕ делает

В текущей версии v6 покрыты все 21 метод MCP-сервера. Если в `mcp_server.py` появится новый tool — попроси у владельца добавить в `tfwb-1/pkg-N+1`.

## Подводные камни

- Имя учётки на сервере сейчас «DeepSeek-Agent». Переименовать может только владелец (это `role !== "owner"` блок в `PATCH /api/agents/:id`); не пытайся — получишь 403.
- В первой версии плагина `taskflow_my_tasks(state=...)` отдаёт только `assignee_id == me`. Если владелец переназначил задачу на тебя после `claim`, аренда сохраняется — но `my_tasks` покажет её без изменений.
- `taskflow_comment` с `files` заливает файлы последовательно. Для больших аттачей (>10 МБ) это медленно — лучше предупредить владельца, что вложение тяжёлое.