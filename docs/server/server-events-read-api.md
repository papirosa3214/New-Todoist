# API чтения и выгрузки серверного журнала событий

Дата: 10.10.2026. Автор: Разработчик (шаг 3 карточки e87cd93f).

Источник записей — общий серверный журнал `server_events` (миграция
128, шаг 2). Данные уже прошли редактуру секретов при записи
(`redactServerEventData` в `server/src/lib/serverEvents.ts`), поэтому
повторная редактура при чтении не нужна. Курсорная пагинация по
`(created_at, id)` — у SQLite `created_at` хранится в формате
`datetime('now')` с секундной точностью, поэтому добавлен тай-брейкер
по `id`.

## Назначение

Владелец видит, что произошло на сервере за период или вокруг
конкретной задачи/операции. Один файл выгрузки содержит события,
счётчики и снимок настроек — этого хватает для разбора сбоя без
ручного сбора логов.

## Эндпоинты

Все — только владелец (`authOrApiToken + isOwner(req.userId)`).

- `GET /api/admin/server-events`
- `GET /api/admin/server-events/stats`
- `GET /api/admin/server-events/:id`
- `GET /api/admin/server-events/operation/:operationId`
- `GET /api/admin/server-events/export`

### Список с фильтрами

`GET /api/admin/server-events`

Query-параметры:

| Параметр | Тип | Описание |
| --- | --- | --- |
| `since` | ISO | нижняя граница `created_at` |
| `until` | ISO | верхняя граница `created_at` |
| `scope` | csv | `lifecycle`, `queue`, `role_run`, `mcp`, `enricher`, `http_error`, `system` |
| `kind` | string | `LIKE prefix%` по умолчанию |
| `kindExact=1` | flag | точное равенство вместо LIKE |
| `task_id` | id | привязка к задаче |
| `subtask_id` | id | привязка к подзадаче |
| `operation_id` | id | привязка к операции |
| `actor_id` | id | привязка к пользователю/агенту |
| `outcome` | enum | `ok`/`err`/`timeout`/`skipped`/`cancelled` |
| `message` | substring | `LIKE '%...%'` по полю message |
| `limit` | 1..1000 | размер страницы (по умолчанию 200) |
| `cursor` | `<ts>\|<id>` | курсор для следующей страницы |
| `order` | `asc`/`desc` | направление сортировки (по умолчанию `desc`) |

Ответ: `{ events: ServerEventRow[], nextCursor: string|null, totalEstimate: number|null }`.

`totalEstimate` намеренно приблизительный: считаем фактический размер
страницы, точный `COUNT(*)` для растущей таблицы дорогой. Для «сколько
за час» есть отдельный `/stats`.

### Сводка

`GET /api/admin/server-events/stats` — те же фильтры. Возвращает
`{ total, byScope: [{scope,count}], byOutcome: [{outcome,count}],
byKind: [{scope,kind,count}] (top-25), byKindOverflow: number }`. Полезно
для дашборда «что упало за последние сутки» без прокрутки тысяч строк.

### Одна запись

`GET /api/admin/server-events/:id` — `ServerEventRow` или `404`. `id` имеет
формат `sev_<uuid>`. После ротации запись может исчезнуть — это не
ошибка вызывающего кода, а нормальная работа.

### Цепочка операции

`GET /api/admin/server-events/operation/:operationId` —
`{ events: ServerEventRow[], truncated: boolean }`. Сортировка по
`created_at ASC`, защитный лимит `MAX_OPERATION_EVENTS = 500` на случай,
если кто-то случайно начал писать `operation_id` без группировки:
`truncated: true` означает, что цепочка длиннее.

### Выгрузка файла

`GET /api/admin/server-events/export` — `Content-Disposition: attachment`,
имя `server-events-<ISO>.json|ndjson|json.gz`.

Параметр `format`:

- `json` (по умолчанию) — один JSON-документ, в котором:
  `{ format_version: 1, generated_at, server: {node, commit}, filters,
  counts: {total, byScope, byOutcome}, settings, events: [...] }`.
- `ndjson` — события по одной на строку, без обёртки. Удобно для
  `jq`/grep в консоли.
- `gzip` — тот же JSON, сжатый `gzip`.

Лимит по количеству событий в экспорте — `SERVER_EVENTS_EXPORT_MAX_EVENTS`
= 5000. Если нужно больше — сужать фильтры.

## Файлы реализации

- `server/src/lib/serverEventsRead.ts` — чтение/выгрузка (библиотека).
  Содержит все SQL-запросы и сериализацию; не зависит от Fastify.
- `server/src/routes/serverEvents.ts` — Fastify-роуты, owner-guard,
  парсинг query-параметров с понятными 400 на невалидные значения.
- `server/test/serverEventsRead.test.ts` — 14 юнит-тестов на
  фильтры/курсор/сводку/NDJSON/чтение по id/цепочку/редакцию секретов.
- `server/test/serverEventsApi.test.ts` — 15 интеграционных тестов
  через `buildApp + app.inject` на права доступа и форматы экспорта.

## Права и секреты

- Доступ только у владельца (`isOwner(req.userId)`). Агент и
  оркестратор получают 403. Без токена — 401.
- Записи в `server_events` уже отредактированы: именованные ключи
  (`token`, `api_key`, `password`, ...) заменены на `***`, JWT и
  Bearer-токены в любых полях — на `[redacted-jwt]` / `Bearer ***`. Эта
  фильтрация делается в `redactServerEventData` на запись, и чтение
  просто отдаёт то, что в БД. Тест `секреты не утекают при чтении`
  проверяет это явно.

## Ограничения

- Курсор привязан к `(created_at, id)`: при одинаковой секундной метке
  порядок между строками в одной секунде определяется UUID, что
  теоретически может приводить к повтору/пропуску при пограничных
  выборках. На практике это редкий случай (page size << количество
  записей в секунду) и тестами покрыт как «нет повторов при
  последовательных запросах».
- Два разных лимита, которые легко спутать:
  * `SERVER_EVENTS_EXPORT_MAX_EVENTS` (ниже в файле) — верхняя
    граница числа событий в одной выгрузке; это размер скачиваемого
    файла, а не лимит таблицы. Если фильтр вернул больше — выгрузка
    обрежет хвост и предупредит владельца; для большого периода лучше
    несколько экспортов по подпериоду.
  * Срок хранения (`DEFAULT_SERVER_EVENTS_RETENTION_DAYS`, по
    умолчанию 180 дней, переопределяется
    `TASKFLOW_SERVER_EVENTS_RETENTION_DAYS`) — это другая ось:
    «насколько глубоко в прошлое можно заглянуть». Периодически
    (дефолт 1 час, интервал — `TASKFLOW_SERVER_EVENTS_ROTATION_INTERVAL_MS`)
    запускается `pruneServerEvents` из `serverEvents.ts` и удаляет
    строки старше порога. На тестовой копии ротация работает; на
    тестовом прогоне отключается флагом
    `TASKFLOW_SERVER_EVENTS_ROTATION=off`.
- Журнал по-прежнему не привязан к `X-Request-ID` на постоянной основе:
  события `http_error.route_error` несут `request_id` в `data_json`,
  но индекса по нему нет. Если разбор потребует «все события одного
  запроса», индекс добавит отдельный шаг.

## Связанные шаги

- API чтения — `367bb019` (этот документ).
- Ротация и ограничение хранения — отдельный коммит на той же ветке
  (`feat(server): ротация и лимит хранения для server_events`); см.
  `pruneServerEvents`/`startServerEventsRetention` в
  `server/src/lib/serverEvents.ts` и подключение в `server/src/index.ts`.