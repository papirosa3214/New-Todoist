# Техническое решение: Пульт управления сервером (MAK-95)

Карточка: 581957c9-ade2-40ec-bab5-17a70cfbb184 · Linear MAK-95
Дата: 2026-10-08 · Роль: Архитектор
Связь: related MAK-98 → MAK-95

## Что увидел живой код

Сервер уже разбрасывает «параметры реакций» в `process.env.*` по 10+ местам,
в каждом — своя константа с хардкодом по умолчанию:

- `runtime/stalledStepWatcher.ts` — `TASKFLOW_STALL_AFTER_MIN` (10).
- `runtime/providerProbe.ts` — `PROVIDER_PROBE_INTERVAL_MS` (5 мин).
- `runtime/scheduler.ts` — `SCHEDULER_INTERVAL_MS` (5 мин), `RETRY_DELAY_MIN` (5).
- `lib/linearAutoImport.ts` — `LINEAR_AUTOIMPORT_INTERVAL_MS` (5 мин),
  `LINEAR_AUTOIMPORT_STALE_MS` (30 мин).
- `lib/linearSync.ts` — расписание и `LINEAR_SYNC_DISABLED`.
- `runtime/inProcessRun.ts` — `TASKFLOW_SLOT_STOP_SUMMARY_MS` (30 с),
  `TASKFLOW_SLOT_STOP_SUMMARY`.
- `index.ts` — флаги `INBOX_TRIAGE_DISABLED`, `TASKFLOW_AUTO_PREPARATION`,
  `LINEAR_AUTOIMPORT_DISABLED`, `LINEAR_SYNC_DISABLED`,
  `ORCHESTRATOR_WEBHOOK_DISABLED`.
- `routes/activity.ts` — `ACTIVITY_OBSERVER_ENABLED`, `ACTIVITY_OBSERVER_MODEL`.
- `routes/agent-service.ts` — состояние «Системы» (через `agent-state.ts`).
- `routes/task-intake.ts` — режим приёма (`users.task_intake_mode`) и
  `reviewer_first_default`. Это уже редактируется из SettingsScreen → Сервер.

Поведение `GET /api/server-status` уже отдаёт uptime, commit, db_bytes,
ollama, состояние «Системы». В вебе `ServerSection` (SettingsScreen.tsx:261)
рисует: Сервер, LLM, Пинг, Версия, Система, Автоодобрение задачи,
Авторевьюер, Расписание, Задачи. Это «диагностика + 3 тумблера».

Лимиты сообщений/вызовов роли (например, `MAX_RESTARTS_PER_WINDOW`,
`RETRY_LIMIT`, лимит длины сообщения) и таймауты моделей (TTFB по моделям)
— либо хардкод, либо env, нигде не редактируются.

**Чего сейчас нет и что требует** вкладка MAK-95:
1. **Единого реестра параметров** с группами (тишина/запуск/расписания/
   автоимпорт/запись в Linear/таймауты/лимиты/режим приёма). Владелец
   меняет значение, не зная имени переменной окружения.
2. **Чтения с дефолтом**, если ключ в БД отсутствует — параметр берётся
   из текущего хардкода в коде (источник правды по умолчанию).
4. **API для владельца**: `GET /api/admin/server-settings` (группы) и
   `PUT /api/admin/server-settings/:key` (изменить).
5. **Применения без перезапуска** — модули, читавшие `process.env.X`,
   переходят на общий реестр с in-memory подпиской; при `PUT` новое
   значение подхватывается без перезапуска процесса.
6. **Журнала изменений**: кто, когда, прежнее и новое значение, причина
   (опционально).
7. **Раздела «Сервер» в вебе** с группами (как требует критерий приёмки).

## Решение

Один **реестр серверных параметров** (`server_settings` в SQLite + in-memory
кэш + событие-рассылка), вместо россыпи `process.env.*` констант. Владелец
меняет значение через PUT, обновление мгновенно подхватывается всеми
читателями через `getSetting(key)`.

### Структура записи

```ts
type ServerSetting = {
  key: string;          // "stall_after_min"
  label: string;                    // "Тишина перед автоперезапуском"
  group: "тишина" | "перезапуски" | "расписания" | "снимки"
       | "автоимпорт" | "linear" | "таймауты" | "лимиты"
       | "режим_приёма";
  kind: "duration_min" | "duration_sec" | "interval_ms"
       | "int_b" | "bool" | "enum";
  default: number | boolean | string; // текущий хардкод из кода
  min?: number; max?: number;
  options?: readonly string[];      // для enum
  applies_to: string[];     // какие модули читают (комменты)
};
```

### API

- `GET  /api/admin/server-settings` → `{ settings: ServerSetting[],
  values: Record<key, value>, updated_at: Record<key, iso> }`.
  Только владелец (`requireOwner`).
- `PUT  /api/admin/server-settings/:key` → `{ value }`. Только владелец.
  Валидация по `kind/min/max/options`. Запись в `server_settings`,
  append в `server_settings_log` (actor, before, after, reason, ts).
- `POST /api/admin/server-settings/:key/reset` → сброс кода на default
  из реестра.

### Хранение

`server_settings` — `(key TEXT PRIMARY KEY, value TEXT NOT NULL,
updated_at TEXT NOT NULL, updated_by TEXT)`. Значения сериализуются как
JSON-строка (числа/булевы/перечисления). `server_settings_log` —
история с `actor_id`, `key`, `old_value`, `new_value`, `reason`,
`created_at`. Права — владелец; чтение самого реестра — открыто
(используется модулями).

### Чтение с дефолтом

```ts
// server/src/lib/serverSettings.ts
import settings, { DEFAULTS } from "./serverSettingsRegistry.js";

export function getSetting<K extends keyof typeof DEFAULTS>(
  key: K,
): (typeof DEFAULTS)[K] {
  const v = settings.cache.get(key);
  if (v === undefined) return DEFAULTS[key]; // значение по умолчанию
  return v as (typeof DEFAULTS)[K];
}
```

`serverSettingsRegistry.ts` экспортирует константу `DEFAULTS` —
единственный источник правды по умолчанию. Все модули, читавшие
`process.env.X || <число>`, заменяются на `getSetting("stall_after_min")`.

### Применение без перезапуска

`getSetting()` берёт из `cache: Map<string, unknown>`. На `PUT`
cache обновляется, и `bus.emit('settings:changed', { key, value })`.
Подписчики (там, где требуется пересоздать таймер — например,
`providerProbe`) перезапускают свой `setInterval` с новым интервалом.
Для большинства параметров достаточно пере-чтения при следующем тике.

Сейчас в `providerProbe.ts` уже создан интервал на старте сервера.
Добавляется: при смене `provider_probe_interval_ms` остановить
старый интервал, поставить новый. Аналогично для
`stalledStepWatcher.ts` (порог перечитывается на каждом проходе —
достаточно `getSetting`).

### Группы параметров

| Группа | Ключи (пример) |
|---|---|
| Тишина | `stall_after_min` (10), `provider_probe_interval_ms` (5 мин) |
| Перезапуски | `slot_stop_summary_ms` (30 с), `max_restarts_per_window` (2) |
| Расписания | `scheduler_interval_ms` (5 мин), `retry_delay_min` (5), `retry_limit` (3) |
| Снимки | `snapshot_interval_min` (—) |
| Автоимпорт | `linear_autoimport_interval_ms` (5 мин), `linear_autoimport_stale_ms` (30 мин), `linear_autoimport_enabled` (true) |
| Запись в Linear | `linear_sync_enabled` (true), `linear_sync_interval_min` (1) |
| Таймауты | `embedding_timeout_ms`, `model_ttfb_timeout_ms` |
| Лимиты | `max_messages_per_run`, `max_role_calls_per_run` |
| Режим приёма | `task_intake_mode` (manual/automatic), `reviewer_first_default` (true) |

Каждая группа рисуется отдельным `FieldGroup` в `ServerSection`.

### Веб: раздел «Сервер»

`src/screens/SettingsScreen.tsx` → `ServerSection` (существующая, точка
входа есть). Под уже отрисованной группой статуса — секции по группам
реестра. Для каждого ключа — свой компонент поля по `kind`:

- `bool` → `ToggleRow`.
- `duration_min` / `duration_sec` / `interval_ms` → числовое поле с
  суффиксом «мин» / «сек» / «мс», валидация по `min/max`.
- `int_b` → числовое поле.
- `enum` → сегмент-контрол с `options`.

Кнопка «Сбросить» рядом с полем — `POST /reset`.

### Экран iOS делается отдельно — этого шага не касается. Граница
зафиксирована в задаче (TaskFlow: 424de175).

## План реализации (для builder)

1. **Миграция БД**: таблицы `server_settings` и `server_settings_log`
   в новой миграции. Seed: пусто (значения берутся из `DEFAULTS`).
2. **`server/src/lib/serverSettingsRegistry.ts`** — `DEFAULTS` (типизированный
   объект), `ServerSetting[]` (метаданные для UI).
3. **`server/src/lib/serverSettings.ts`** — `getSetting`, `setSetting`
   (только для владельца, через ручку), `onChange(callback)` для
   подписчиков.
4. **`server/src/routes/admin-server-settings.ts`** — GET, PUT, POST
   /reset. Подключить в `index.ts` под `authOrApiToken + requireOwner`.
5. **Заменить `process.env.X` чтения** на `getSetting(...)` в:
   - `runtime/stalledStepWatcher.ts`
   - `runtime/providerProbe.ts` (с пересозданием интервала по событию)
   - `runtime/scheduler.ts` (RETRY_LIMIT, RETRY_DELAY_MIN, интервал)
   - `lib/linearAutoImport.ts` (с пересозданием интервала)
   - `lib/linearSync.ts`
   - `runtime/inProcessRun.ts` (slot_stop_summary)
   - `routes/activity.ts` (ACTIVITY_OBSERVER_*)
   - `index.ts` (`INBOX_TRIAGE_DISABLED`, `LINEAR_*_DISABLED`,
     `ORCHESTRATOR_WEBHOOK_DISABLED`, `TASKFLOW_AUTO_PREPARATION` —
     через реестр; для «выключателей» — отдельный ключ `bool`)
   - `routes/agent-service.ts` (через существующий канал «Система»
     из `user_defaults` или вынести в реестр — выбирает реализация)
   - `routes/task-intake.ts` (`task_intake_mode`, `reviewer_first_default` —
     уже есть; переводим на единый путь `getSetting`)
6. **Веб — `src/screens/SettingsScreen.tsx`** → `ServerSection`:
   под существующим блоком статуса добавить секции реестра. Хук
   `useServerSettings()` → GET; `useUpdateServerSetting()` → PUT.
7. **Тесты** — критерии приёмки:
   - чтение с дефолтом (ключ в БД пуст → возвращается значение
     из `DEFAULTS`; для каждой строки реестра);
   - границы (PUT значения вне min/max → 400);
   - права (не владелец PUT → 403);
   - применение без перезапуска (после PUT `stall_after_min` =
     2, новые срабатывания сторожа идут с 2 мин);
   - журнал (PUT пишется в `server_settings_log` с actor/before/after);
   - веб показывает группы (визуальная проверка в SettingsScreen).

## Чего не делаем в этой карточке

- Экран iOS (отдельная карточка).
- Унификация модели прав ролей (тоже отдельная карточка).
- Полная очистка `process.env.*` — оставляем env как переопределение
  стартового значения при подъёме, чтобы владелец мог по-прежнему
  править server/.env для неперекрываемых секретов/моделей.

## Риски

1. **Подписчики долгоживущих таймеров**. `providerProbe` и
   `linearAutoImport` держат `setInterval` на старте. При смене
   интервала нужно корректно остановить старый и поставить новый;
   без этого будет дрейф (два интервала одновременно). Решение:
   подписка `onChange("provider_probe_interval_ms", () => {...})`
   на старте модуля. Покрывается юнит-тестом: PUT → ждать 1.5
   интервала → проверить число вызовов.
2. **Однотабличный журнал разрастётся**. `server_settings_log` —
   append-only; ожидаемый объём — десятки записей в месяц. Если
   понадобится чистка — добавить ротацию позже (не блокер для MAK-95).
3. **Конфликт с `task_intake_mode`**. Сейчас режим приёма читается
   из `users.task_intake_mode`, а не из реестра. Решается на шаге
   реализации: перенести ключ в реестр, миграция значений из users.
4. **Конфликт с `agent-service` (Система)**. Это «состояние» сервиса
   (вкл/выкл), а не «параметр реакции». Оставляем как есть; в реестр
   добавляем только параметры поведения (например, флаг `system_enabled`
   = зеркало текущего состояния, чтобы владелец видел его в общем
   списке). Решает реализация.

## Сдача этого шага

Документ фиксирует: модель данных, API, чтение с дефолтом, механизм
подписки, разделение групп, границы работ. builder получает полный
контракт — что и где менять. QA получит список критериев и мест,
где проверять. Этот шаг сдан без необходимости правки кода сервера.