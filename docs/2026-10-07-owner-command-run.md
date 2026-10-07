# Маршрут `POST /api/owner-command/run`

Карточка `d9dee6f8` (MAK-82 / v3 «Реализация: маршрут владельца на .110 +
тесты»). Серверный маршрут, через который кнопка ▶ в чате владельца
выполняет «безопасные» системные команды на .110. Только владелец
трекера; белый список из четырёх действий выполняется без подтверждения,
вне списка — только с `confirm=true` в теле.

## Назначение

Дать владельцу возможность из чата делать системные операции над своей
же машиной — без того, чтобы самому лезть в консоль или передавать
команду агенту. Команда уходит HTTP, выполняется под владельцем, попадает
в журнал `owner_command_log`.

## Контракт API

`POST /api/owner-command/run`

### Заголовки

- `Authorization: Bearer <JWT владельца или api_token>` — обычный
  контракт `authOrApiToken`. Без токена — 401, не владельцу — 403.

### Тело запроса

```json
{
  "action":  "service.restart",
  "command": "systemctl --user restart taskflow-server.service",
  "confirm": false,
  "params":  { "service": "taskflow-server.service" }
}
```

Поля:

- `action` (обязательно) — имя действия из белого списка
  (`service.restart`, `service.status`, `journal.tail`, `db.snapshot`)
  или произвольное (требует `confirm=true`).
- `command` (обязательно) — для белого списка это текст команды для
  журнала (роут сам строит аргументы из `params`). Для произвольного
  действия — это команда, которая реально будет выполнена: бинарь и
  аргументы через пробел, без shell-фич (split по пробелам).
- `confirm` (по умолчанию `false`) — `true` обязательно для действий
  вне белого списка. Без него запрос отвергается с 400, и в журнал
  пишется `outcome=rejected`.
- `params` — параметры для белого списка:
  - `service.restart` / `service.status` — `{ "service": "<unit>" }`,
    имя должно быть в `OWNER_COMMAND_SERVICE_WHITELIST`
    (по умолчанию `taskflow-server.service`);
  - `journal.tail` — `{ "service": "<unit>", "lines": 1..1000 }`,
    дефолт 100;
  - `db.snapshot` — пусто.

### Ответы

- **200** — действие выполнено (`outcome=ok`). Тело:
  ```json
  {
    "ok": true,
    "outcome": "ok",
    "exitCode": 0,
    "stdout": "active",
    "stderr": "",
    "durationMs": 5,
    "backup":  { "path": "backups/db-...sqlite3" } | null,
    "requestId": "<uuid>"
  }
  ```
  Поле `backup` заполняется для `db.snapshot` и для будущих действий,
  которые пишут в БД (см. `BACKUP_REQUIRED`).
- **400** — нет `action`/`command` в теле; нет `confirm=true` для
  не-белого действия; `params.service` не из белого списка сервисов;
  неизвестное действие без `confirm=true`.
- **401** — нет токена.
- **403** — токен есть, но вызывающий не владелец.
- **500** — ошибка exec/бэкапа; в журнал пишется `outcome=error`
  (или `backup_failed`, если не удалось снять снимок перед записью).
- **504** — тайм-аут. По умолчанию 30 c, перекрывается ENV
  `OWNER_COMMAND_TIMEOUT_MS`. После тайм-аута exec убивается
  (SIGTERM, через 5 c SIGKILL), в журнал — `outcome=timeout` со
  stdout/stderr до момента убийства.

## Журнал `owner_command_log`

Отдельная таблица с миграцией `117_owner_command_log`. Поля:

- `id` (uuid), `request_id` (uuid, UNIQUE),
- `who` (FK users, кто звал),
- `action`, `command`, `params` (JSON), `confirm` (0/1),
- `started_at`, `finished_at` (UTC), `duration_ms`,
- `exit_code`, `outcome ∈ {ok, rejected, timeout, error, backup_failed}`,
- `stdout`, `stderr` (TEXT, лимит 64 KiB, обрезка хвостом),
- `backup_path`, `error`.

`rejected` пишется ДО exec (не выполнилось), `backup_failed` — когда
снимок БД не удался перед записью, `error` — exec не стартовал или
упал в `error` событии, `timeout` — exec убит по тайм-ауту,
`ok` — exec завершился сам (включая ненулевой exit code; код лежит
в `exit_code`).

## Сценарии

1. **service.restart** (без подтверждения):
   ```http
   POST /api/owner-command/run
   { "action":"service.restart", "command":"systemctl --user restart taskflow-server.service",
     "params":{ "service":"taskflow-server.service" } }
   ```
   → `file=systemctl, args=["--user","restart","taskflow-server.service"]`,
   spawn → exec.

2. **db.snapshot** (без подтверждения):
   ```http
   POST /api/owner-command/run
   { "action":"db.snapshot", "command":"db.snapshot", "params":{} }
   ```
   → `snapshotDb()` через `better-sqlite3.backup()`. Файл под
   `backups/db-<UTC>.sqlite3`, перекрывается ENV
   `OWNER_COMMAND_BACKUP_DIR`.

3. **Вне белого списка без confirm** → 400, `rejected` в журнале.

4. **Вне белого списка с confirm=true** → `command` парсится в
   бинарь + args, выполняется. Любая команда, включая `sh`/`bash`
   — решает владелец; `confirm=true` означает «я понимаю, что делаю».

5. **Тайм-аут** → SIGTERM через `OWNER_COMMAND_TIMEOUT_MS`
   (дефолт 30 000 мс), затем SIGKILL через 5 000 мс.

6. **Автобэкап** перед записью в БД: список `BACKUP_REQUIRED` пуст,
   потому что белый список не пишет. Действия, которые начнут писать
   в БД, заносятся туда отдельной задачей — архитектура к этому
   готова (функция `snapshotDb` уже доступна, проверка идёт в хендлере).

## Границы

- Только серверная часть. UI кнопки ▶ в iOS/web — в родительской
  карточке «Кнопка ▶ на командах в чате с ролями».
- Белый список ровно из четырёх действий; расширение — отдельной
  задачей.
- Автобэкап не делается ни для одного текущего действия (нечего
  защищать — белый список не пишет).
- Реальный exec **замокан** в тестах через PATH-подмену `sh`,
  `systemctl`, `journalctl`, `sqlite3` (см.
  `server/test/ownerCommands.test.ts`). На проде PATH системный.