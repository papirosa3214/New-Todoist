# Умные напоминания о просроченных задачах — техническое решение

Карточка: `615095f4-73ad-463d-9e7a-45cf25a4016d`. Шаг архитектуры, revision 1.
Дата: 2026-10-04. Сдаёт: Архитектор. Получает: Разработчик (slot: executor).

## 0. Контекст и границы

Что уже есть и работает — НЕ ломаем, а надстраиваем слой:

- `tasks.due_date` (TEXT, формат `YYYY-MM-DD` локального дня, без часа/пояса).
- `tasks.priority` (1..4, 1 — высший).
- `tasks.assignee_id`, `tasks.creator_id`, `tasks.status` (`active`/`completed`).
- `notifications(id, user_id, type, task_id, text, actor_id, read, created_at)` — общая шина уведомлений.
- `ws.broadcast(userId, { type: "notification:new", notificationId, taskId })` — пуш в открытые сокеты.
- `server/src/runtime/scheduler.ts` — node-side scheduler, тикает раз в N минут, ветки: пересборка ролей, dead, запуск по `run_at`, повторяющиеся.
- `apns.queueLiveActivityPush(task)` — APNs для островка Live Activity на iPhone (свёрнутое приложение).
- `lib/secretaryTaskSummary.ts` — группа `overdue` уже определена как `active && due_date < today`.

Границы MVP:
- Только владелец получает напоминания о просроченных (он же чаще всего и `creator`, и `assignee`). Назначенные агенты получают свои уведомления через существующую ветку `assigned` — это не наш круг.
- Канал доставки — `notifications` (in-app, видимый колокольчик) + `apns` (островок), если у пользователя привязан iPhone. Web-push и email вне MVP (см. риски).
- "Умность" = правила эскалации по приоритету + дедуп по (task, step) на сутки, а не ML. ML — отдельная карточка, если понадобится.

## 1. Модель данных (новая)

Два новых понятия: `escalation_rule` (настройка «как напоминать») и `escalation_event` (факт «вот это напоминание уже отправляли, не повторять»).

### 1.1 Таблица `escalation_rules`

По одной строке на пользователя. По умолчанию — одна запись с дефолтным набором шагов, создаётся миграцией при первом чтении.

```sql
CREATE TABLE escalation_rules (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- ВКЛ/ВЫКЛ весь механизм целиком. Дефолт включён.
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Окно тишины: не беспокоить с HH:MM до HH:MM (локального времени владельца).
  quiet_from TEXT NOT NULL DEFAULT '22:00',
  quiet_to   TEXT NOT NULL DEFAULT '08:00',
  -- Дни недели 1..7 (Пн..Вс), запятыми. Дефолт 1-7.
  weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7',
  -- Шаги эскалации в JSON. Массив объектов {after_hours, priority_max, channels:[…]}.
  -- after_hours — через сколько часов ПОСЛЕ due_date; priority_max — 1..4, до какого приоритета
  -- включительно действует шаг (1 = самый срочный, 4 = самый фоновый).
  steps_json TEXT NOT NULL DEFAULT '[
    {"after_hours": 1,  "priority_max": 1, "channels": ["inapp","apns"]},
    {"after_hours": 4,  "priority_max": 2, "channels": ["inapp","apns"]},
    {"after_hours": 24, "priority_max": 3, "channels": ["inapp"]},
    {"after_hours": 72, "priority_max": 4, "channels": ["inapp"]}
  ]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Почему шаги в JSON, а не в таблице: правил всегда один набор на пользователя, читается целиком, миграция под них не нужна при правке UX, форма правит «своими» шагами без миграции БД.

### 1.2 Таблица `escalation_events`

Дедуп: чтобы на одну задачу не сыпалось одно и то же напоминание на каждом тике планировщика.

```sql
CREATE TABLE escalation_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Идентификатор шага: "p<priority>_h<after_hours>", напр. "p1_h1", "p2_h4".
  -- Тот же формат, что у `notifications.type = "escalation_p<priority>_h<after_hours>"`,
  -- чтобы фронт мог группировать уведомление и журнал по одному ключу.
  -- Один и тот же (task, step) за сутки — только одно уведомление.
  step_key TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  notification_id TEXT REFERENCES notifications(id) ON DELETE SET NULL
  -- Чтобы можно было отозвать при ручной отметке «прочитано» задачи
  -- (если понадобится в UI позже).
);
-- Индекс под выборку «что сегодня уже слали»
CREATE INDEX idx_escalation_events_task ON escalation_events(task_id);
-- Дедуп за сутки: SQLite не поддерживает UNIQUE на generated column, но
-- поддерживает уникальный индекс по выражению (с 3.31, в нашей версии есть).
-- Гарантирует: один (task_id, step_key) на date(sent_at) — не более одной строки.
CREATE UNIQUE INDEX uq_escalation_event_day
  ON escalation_events(task_id, step_key, date(sent_at));
```

Дедуп через UNIQUE по дате — самый дешёвый. На повторе INSERT игнорируется (см. 3.3).

### 1.3 Миграция

Добавить запись в `server/src/migrations.ts` рядом с существующими `04x`/`05x`. Id — следующий свободный (на момент 2026-10-04 последний — `060`, следующий `061_escalation_rules`). Проверить актуальный максимум в файле перед коммитом миграции. Миграция добавляет обе таблицы и `CREATE UNIQUE INDEX … ON escalation_events(task_id, step_key, date(sent_at))` (generated-column UNIQUE в SQLite нельзя — обычный unique index по выражению можно с SQLite 3.31+).

## 2. API (новые эндпоинты)

Все под `authOrApiToken`, мутации — `service user only` (как `POST /api/notifications`).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/escalation/rules` | Текущие правила владельца. Если записи нет — лениво создать с дефолтом и вернуть. |
| PUT | `/api/escalation/rules` | Поменять `enabled`, `quiet_from`, `quiet_to`, `weekdays`, `steps_json`. Валидация: `steps_json` парсится и проверяется по схеме (см. §3.2). |
| GET | `/api/escalation/preview` | Подсчитать, сколько напоминаний прилетит за горизонт (по умолчанию 7 дней) при текущих правилах. Для экрана настроек, без сайд-эффектов. |
| GET | `/api/escalation/recent?days=7` | Журнал: какие шаги по каким задачам уже отправлены. Полезно в UI, чтобы было видно «об этом вы уже знаете». |

Дополнительно: `GET /api/notifications` уже возвращает `notifications`; ничего не меняем. Новый фильтр `type IN ('escalation_step1', …, 'escalation_stepN')` фронт уже умеет делать на клиенте по `type`.

## 3. Серверная логика

### 3.1 Точка запуска

Расширить `runtime/scheduler.ts` веткой `notifyOverdue(api, now)`:

- Уже знает `db`, `api` (HTTP-вызов как service user), `log`, есть `now`. Тикает раз в 5 минут — для напоминаний этого хватит.
- Не плодим параллельный cron, не плодим отдельный процесс.

### 3.2 Поток обработки

1. `rules = getOrCreateRules(ownerId)` — один SELECT, при отсутствии — INSERT с дефолтом.
2. Если `rules.enabled == 0` — выход.
3. `now` (UTC) переводим в локальное время владельца (у нас пока нет его `tz` в `users` — допущение: TZ сервера, см. риск R-1). Проверяем `quiet_from..quiet_to` и `weekdays` — если попали в окно тишины, выходим.
4. Берём одним запросом все `tasks` владельца, у которых `status='active'`, `due_date` непустой, `creator_id = ownerId` (см. границы: «о просроченных СВОИХ»).
5. Для каждой задачи считаем `hours_overdue = (nowDateUTC - due_date)*24 + delta`. Сравниваем с `rules.steps_json` (отсортированным по `after_hours` ASC):
   - `if hours_overdue >= step.after_hours AND task.priority <= step.priority_max` — это триггер.
6. Для каждого триггера — атомарный `INSERT OR IGNORE INTO escalation_events …` (гасится UNIQUE-индексом `uq_escalation_event_day`). Если `changes==0` — уже слали сегодня, пропускаем.
7. Если вставлено — `POST /api/notifications` от service user:
   - `type = "escalation_p<priority>_h<after_hours>"` (например `escalation_p1_h1`),
   - `text` — короткий, формат: «⏰ Просрочено: <title> · было <due_date> · приоритет P<priority>»,
   - `task_id` — id задачи.
8. Параллельно — `queueLiveActivityPush(task)` если в шаге есть `channels: ["apns"]` и пользователь онлайн-офлайн (островок прилетит и так, проверить наличие привязки APNs в `apns.ts`).

### 3.3 Дедуп

`INSERT OR IGNORE INTO escalation_events …` с уникальным индексом по `(task_id, step_key, date(sent_at))` — это и есть защита от двойной отправки на повторном тике. `sqlite3` + better-sqlite3 поддерживают unique-index по выражению с версии 3.31, проверить `PRAGMA user_version`/`SELECT sqlite_version()` в первой миграции не нужно — это уже baseline.

### 3.4 Производительность

- Запрос за задачами владельца — индекс `idx_tasks_creator` уже есть (миграция 002).
- Кандидатов на просрочку в худшем случае сотни — обработка линейная, без JOIN, О(N) по задачам владельца.
- `escalation_events` чистим по TTL раз в сутки: `DELETE WHERE sent_at < datetime('now', '-30 days')` отдельной веткой в этом же scheduler.

## 4. Клиентский экран (UI, что увидит владелец)

Контракт передаётся дизайнеру/фронту. Не диктую пиксели.

- Экран «Настройки уведомлений» (новый, в существующем «Настройки»): тумблер «Напоминания о просроченных», окно тишины, дни недели, список шагов с гэпами и приоритетами. `GET/PUT /api/escalation/rules`.
- Подсказка «Сейчас прилетит N уведомлений за 7 дней» — `GET /api/escalation/preview`.
- На карточке просроченной задачи — бейдж `⏰ напомнили · 1ч · 14:32` (последний шаг). `GET /api/escalation/recent?days=7` + фильтр по task_id.
- В существующий список `notifications` — фильтр по типу `escalation_*` (фронт уже умеет фильтровать по `type`).

## 5. Контракты данных (для исполнителя и QA)

```ts
// EscalationRule
type EscalationRule = {
  enabled: boolean;
  quiet_from: string;   // "HH:MM"
  quiet_to: string;     // "HH:MM"
  weekdays: number[];   // [1..7], Пн=1
  steps: Array<{
    after_hours: number;     // ≥ 0, целое
    priority_max: 1|2|3|4;   // 1 — самый срочный
    channels: Array<"inapp"|"apns">;
  }>;
};

// EscalationEvent
type EscalationEvent = {
  id: string;
  task_id: string;
  step_key: string;          // "p<priority>_h<after_hours>", напр. "p1_h1", "p2_h4"
  sent_at: string;           // ISO
  notification_id: string | null;
};
```

Валидация `steps` на стороне сервера при PUT:
- `after_hours` целое ≥ 0, шаги отсортированы по возрастанию.
- `priority_max` ∈ {1,2,3,4}, по убыванию приоритета шагов не требуется (можно «громче на 4ч, тише на 24ч»).
- `channels` ⊂ {"inapp", "apns"}.
- Хотя бы один шаг с `after_hours >= 1` и `priority_max == 1` — иначе самые срочные никогда не триггернутся (защита от факапа настройки).

## 6. Отказные сценарии

| Сценарий | Поведение |
|---|---|
| Пользователь создал задачу без `due_date` | Не трогаем — нет «просрочки». |
| `due_date` в будущем | Не трогаем. |
| `priority` пустое (= NULL) | Трактовать как 4 (низкий), чтобы не получить ложную срочность. |
| Задача в `quiet_from..quiet_to` | Пропустить, отправить сразу после `quiet_to`. |
| Миграция ещё не отработала (сервер свежий) | `getOrCreateRules` создаёт дефолт. Без правил — никаких эскалаций. |
| APNs недоступен / островок не привязан | `queueLiveActivityPush` уже умеет молча падать (см. apns.ts), полагаемся. |
| Задача завершена между тиком и INSERT'ом события | INSERT всё равно создаст уведомление; отзываем post-hoc по `task.status` в UI (если попадёт на экран — пометка «уже сделано»). Альтернатива: SELECT status='active' в WHERE scheduler'а — дешевле. |
| Два тика подряд за одну и ту же секунду | UNIQUE-индекс на `escalation_events(task_id, step_key, date(sent_at))` гасит дубль. |
| Владелец сменил TZ — пересчитываем `quiet_from/to` как есть, в локальном времени сервера. | См. R-1. |

## 7. Границы и НЕ-цели MVP

- НЕ делаем web-push и email (другая карточка, см. R-3).
- НЕ делаем ML/персонализацию гэпов (правила — таблица, как у Todoist/Things).
- НЕ делаем напоминания заранее («через 1 час до срока») — это другая семантика (pre-due), другая карточка.
- НЕ дублируем «assigned» уведомления для агентов. Только владелец про СВОИ просроченные.
- НЕ трогаем существующий `notifications` и `ws.broadcast` — пишем через них.

## 8. Риски

- **R-1. TZ владельца** в `users` не хранится. Допущение MVP: TZ = TZ сервера. Если у владельца поездки — окно тишины поплывёт. Смягчение: позже добавить `users.tz` миграцией; пока в UI правил выводим «по серверному времени» (явно).
- **R-2. Шум.** Если у владельца 200 просроченных с приоритетом 1 и шаг 1ч — за тик прилетит 200 пушей. Смягчение: дефолтный набор шагов подобран так, что на приоритете 1 «громкий» канал (apns) — только на 1ч, дальше только in-app. Плюс существующий колокольчик не дёргается «прочитал — не прочитал» по эскалациям без явного read-а, чтобы не было чувства «надо закрыть».
- **R-3. Каналы.** web-push и email не подключены — это не блокер, но в дороге/десктопе без iPhone напоминания увидятся только при открытии приложения. Заводим отдельную карточку после MVP.
- **R-4. Дедуп по дате, а не по тику.** На стыке полуночи при 23-часовой просрочке шаг «24ч» может уйти в 00:05, а не в 23:00 предыдущего дня. Это нормально: правила — «начиная с N часов после срока», а не «ровно в N часов».
- **R-5. Миграция и существующая БД.** У кого-то уже есть записи в `notifications` с типом `task_dead` и подобным — наш новый тип `escalation_*` их не задевает. Дефолтная вставка `escalation_rules` идемпотентна.
- **R-6. Гонка scheduler ↔ ручной `state` задачи.** Если владелец прямо в момент тика отметил задачу выполненной — наш SELECT уже мог её взять, INSERT события и уведомления пройдёт. Смягчение: перепроверка `status='active'` прямо перед `INSERT INTO notifications` (дёшево).
- **R-7. Производительность при росте.** На 5k задачах владельца — 5k строк в выборке за тик. Сейчас `idx_tasks_creator` есть, фильтр простой. При 50k+ — добавить композитный индекс `(creator_id, status, due_date)` миграцией, но не сейчас.

## 9. План внедрения (для исполнителя)

1. Миграция `061_escalation_rules`: добавить обе таблицы, индексы, дефолтные шаги.
2. `server/src/routes/escalation.ts`: GET/PUT `/api/escalation/rules`, GET `/api/escalation/preview`, GET `/api/escalation/recent`. Зарегистрировать в `index.ts` рядом с `registerNotificationRoutes`.
3. `server/src/runtime/scheduler.ts`: добавить ветку `notifyOverdue` и вызвать её в общем тике. Защитный SELECT `status='active'` перед INSERT.
4. Утилита `lib/escalationEvaluator.ts` (чистая функция `selectSteps(rule, task, now)`) — чтобы покрыть юнит-тестами без поднятия HTTP.
5. Тесты в `tests/`: правила + дедуп + окно тишины + отключённый флаг. На каждый — ассерт в стиле существующих `tests/`.
6. Документация: эта заметка — единственный источник по решению; при изменениях контракта — PR с правкой сюда, не в `AGENT-WORK-SCOPES.md`.

## 10. Проверка приёмки (как QA это будет мерить)

- Создать 3 задачи с `due_date` в прошлом: P1 (1ч назад), P2 (3ч), P3 (25ч).
- Дёрнуть `notifyOverdue` руками (или подождать 5 минут).
- В `notifications` владельца: 3 записи с типами `escalation_p1_h1`, `escalation_p2_h4`, `escalation_p3_h24`. В `escalation_events` — 3 строки.
- Второй тик в ту же дату — ноль новых записей.
- Завершить задачу P1 вручную → третий тик не присылает новое.
- `PUT /api/escalation/rules` с `enabled: false` → четвёртый тик — ноль.
- Окно тишины: правило `quiet_from=00:00 quiet_to=23:59` → ноль за тик.
- `GET /api/escalation/preview` — возвращает непустой массив.
- Миграция вверх/вниз — без потерь существующих `notifications` (smoke).

## 11. Открытые хвосты (для следующих карточек)

- `users.tz` и пересчёт тишины.
- Web-push и email как каналы в `channels[]`.
- «Pre-due» напоминания (за 1ч/день до срока) — отдельная семантика.
- ML/адаптивные гэпы на основе истории «открыл после N часов просрочки».
- Очистка `escalation_events` уже включена в scheduler (TTL 30 дней), но `GET /api/escalation/recent` показывает только свежие — задокументировать лимит явно в UI.
