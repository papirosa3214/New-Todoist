# Архитектурное решение — Этап B: версионированный manifest правил и acknowledge

Карточка: `51763de5-0a6d-4ce0-91b1-fd5d5c7a2364`.
Шаг архитектора: `158919af-1c2a-482f-956d-02ff7281c513`.
Вход: `feature_spec` аналитика в БЗ (`45d948af-1e4d-4dae-9a55-5d799aab359f`).

## Контекст

Сейчас общие правила работы агентов (типа MAK-120 «Правило выхода из зацикливания», политика параллельного разбиения) живут в `AGENTS.md` каждой роли (эффект только после перезапуска процесса) и в свободных чат-сообщениях без явной версии и без подтверждения применения. Агент при старте шага не знает о появлении или изменении правила. Этап B закрывает обрыв «общие объявления и подтверждение правил» (раздел 1.2 плана `ca1ff10c-b881-4a4d-b8f2-835df94ff3ca`): правила становятся версионированными записями в БД, агенты обязаны их подтверждать при старте шага, иначе работа считается не начатой по полной версии правил. Дефект «объявление в общий канал без ссылки» закрывается обязательным `rule_ref`.

## Варианты, по которым решал архитектор

### Хранение подтверждений (открытый вопрос Q2)

- **А. Отдельная таблица `rule_acknowledgements(role, rule_id, version, session_id, acknowledged_at)`** с уникальным ключом и индексом по `role`.
  Плюсы: восстанавливается после рестарта сервера, дешёвый индекс для snapshot, идемпотентность на уровне БД. Минусы: ещё одна миграция в этом же изменении.
- **Б. Только строка `kind='rule_acknowledged'` в `chat_messages`.**
  Плюсы: меньше миграций. Минусы: дорогой SELECT на каждый snapshot, плохая идемпотентность, сложно восстановить «кто подтвердил что».
- **В. Локальный файл рядом со снимком слота (`slotWorkSnapshot`).**
  Плюсы: просто реализуется. Минусы: теряется при переустановке и рестарте — нарушает контракт воспроизводимости правила.

**Решение: вариант А.** Совместим с NFR «надёжность» и NFR «наблюдаемость», явный уникальный ключ, индекс по `(role, status)` остаётся дешёвым.

### Частота обновления блока `rules.pending_acknowledgement` (Q3)

- **α. Только при старте шага.** Существующий `instruction_snapshot` сам формирует блок.
  Плюсы: минимум изменений в runtime, нет push-механизма, согласуется с жизненным циклом шага.
  Минусы: агент в work-режиме узнает о новом правиле только при следующем старте.
- **β. Плюс push-обновление при получении `rule_published` через `slot_topic_inbox`.** Сервер инициирует пересборку snapshot.
  Плюсы: видно сразу в work-режиме. Минусы: дублирование состояния, выходит за scope этапа B.

**Решение: вариант α.** Push — отдельный этап, если появится запрос.

### Прохождение `rule_acknowledged` через `chat_message_queue` (Q7)

**Решение: да.** Ключ идемпотентности — `('rule_ack', role, rule_id, version, session_id)`. Симметрично существующему `chat_send` с `Idempotency-Key`, закрывает дубли при сетевом ретрае.

### Канал публикации `rule_published` (Q8)

**Решение: `channel='agents'`.** Введение отдельного `channel='rules'` потребует изменения `taskflow_chat_read` и UI, что выходит за scope. Атрибуция достаточна через `rule_ref`; фильтрация только правил — задача этапа E.

### Точечный `role_scope` — массив или маска (Q1, для владельца)

Рекомендация архитектора: начинаем с `string[]`. Маска «кроме owner» — отдельная задача, если появится запрос. Покрывает 95% кейсов без нового валидатора.

### Сид из `AGENTS.md` в миграции (Q4, для владельца)

Рекомендация архитектора: не включать. Существующие «жёсткие» правила уже идут через `AGENT_RULES` блок snapshot. Новый механизм — для объявлений, опубликованных явно. Иначе будут дублироваться; миграция существующих правил — отдельная задача с разметкой, какой текст — публикация, а какой — комментарий роли.

### Статус `retracted` (Q5, для владельца)

Рекомендация: не делать в рамках этапа B. Это полный отзыв правила, требует отдельного UX и валидации в snapshot. Сильно увеличит объём миграции.

### Срок хранения `superseded` (Q6, для владельца)

Рекомендация: навсегда. Удаление/архивация — отдельная операция владельца. При ≤ 50 активных правилах и версиях ≤ 10 объём таблицы пренебрежимо мал.

Если владелец не согласен — пересмотр архитектуры на следующем цикле.

## Полное решение

### Таблицы

```sql
-- манифест версионированных правил
CREATE TABLE agent_rules_manifests (
  rule_id         TEXT        NOT NULL,
  version         INTEGER     NOT NULL,
  content_markdown TEXT        NOT NULL,
  published_at    TIMESTAMP   NOT NULL DEFAULT now(),
  published_by    TEXT        NOT NULL,
  role_scope      TEXT        NOT NULL DEFAULT '*',  -- '*' или CSV ключей ролей
  status          TEXT        NOT NULL DEFAULT 'active'  -- 'active' | 'superseded'
    CHECK (status IN ('active', 'superseded')),
  superseded_by_version INTEGER,
  PRIMARY KEY (rule_id, version)
);
CREATE INDEX idx_agent_rules_manifests_status
  ON agent_rules_manifests (rule_id, status);

-- подтверждения версий ролями
CREATE TABLE rule_acknowledgements (
  role             TEXT        NOT NULL,
  rule_id          TEXT        NOT NULL,
  version          INTEGER     NOT NULL,
  session_id       TEXT        NOT NULL,
  acknowledged_at  TIMESTAMP   NOT NULL DEFAULT now(),
  PRIMARY KEY (role, rule_id, version)
);
CREATE INDEX idx_rule_acknowledgements_role
  ON rule_acknowledgements (role);
```

### Инструменты

- **`taskflow_rule_publish(rule_id, version, content, role_scope?)`**:
  - Валидация: `rule_id` соответствует маске `[a-z][a-z0-9_.-]{2,63}`; `version` ≥ 1; `content` — непустой Markdown; `role_scope` — массив ключей ролей или `'*'`.
  - Идемпотентен по `(rule_id, version)` через уникальный ключ: повторный вызов с теми же аргументами возвращает `{ok: true, existed: true}` без побочных эффектов.
  - При успехе: создать/обновить запись в `agent_rules_manifests`; если для `rule_id` уже есть `active`-запись, перевести её в `superseded` и проставить `superseded_by_version = version`; записать `chat_messages` строку `kind='rule_published'` с `rule_ref = '<rule_id>@v<version>'` через существующую `chat_message_queue`; опубликовать адресатам по `role_scope` через `slot_topic_inbox`; записать событие `task_events kind='rule_superseded'` со ссылками `old=<rule_id>@v<n>`, `new=<rule_id>@v<n+1>`, `role_scope`.
  - Доступ: только владелец (`role_owner`) и агенты с явной делегацией (отдельный список — вне этого этапа). Иначе — `403`.

- **`taskflow_rule_acknowledge(rule_id, version)`**:
  - Идемпотентен по `(role, rule_id, version)` через уникальный ключ: повторный вызов возвращает `{ok: true, acknowledged_at: <тот же timestamp>}` без новой строки.
  - При успехе: upsert в `rule_acknowledgements`; затем записать `chat_messages` строку `kind='rule_acknowledged'` с `rule_ref = '<rule_id>@v<version>'` через `chat_message_queue` с `Idempotency-Key = ('rule_ack', role, rule_id, version, session_id)`.
  - Возвращает `200 {ok: true, acknowledged_at}` или `409 {error: 'rule_version_superseded', current_version}` если версия уже не `active`.

### Защита `rule_ref` (закрытие AC-3)

В существующем `taskflow_chat_send` (`chatTools.ts:13-104`) добавляется валидация: если сообщение помечено как объявление правила (`kind='rule'` или явный префикс), то без `rule_ref` возвращается `400 {error: 'rule_publication_requires_rule_ref'}`. Свободные сообщения владельца без признака правила продолжают проходить без изменений.

### Блок `rules.pending_acknowledgement` в `instruction_snapshot`

Регистрируется через `registerInstructionBlock` в `server/src/lib/roleContextResolver.ts:225-300`, вставляется в порядок слоёв сразу после блока `rules`. Запрос:

```sql
SELECT m.rule_id, m.version, substring(m.content_markdown, 1, 200) AS preview
FROM agent_rules_manifests m
WHERE m.status = 'active'
  AND (m.role_scope = '*' OR :role = ANY(string_to_array(m.role_scope, ',')))
  AND NOT EXISTS (
    SELECT 1 FROM rule_acknowledgements a
    WHERE a.role = :role AND a.rule_id = m.rule_id AND a.version = m.version
  );
```

Блок имеет признак `required_for_step_start: true`. Пока блок не пуст, агент обязан либо вызвать `taskflow_rule_acknowledge` по каждой записи, либо явно мотивировать отказ через `taskflow_comment` с пометкой «нужна помощь владельца». Поведение существующих блоков snapshot не меняется.

### Событие `task_events kind='rule_superseded'`

Пишется при успешной публикации новой версии, когда для `rule_id` уже была `active`-запись. Поля: `old=<rule_id>@v<n>`, `new=<rule_id>@v<n+1>`, `role_scope`, `superseded_at`. Запись через существующий механизм `task_events`.

## Последствия

### Положительные

- Правила становятся воспроизводимыми артефактами БД с явными версиями. Откат правила = публикация предыдущей версии.
- Дефект «объявление в общий канал без ссылки» закрывается обязательным `rule_ref` на серверном пути.
- Готовая опора для UI-бейджа этапа E (через тот же `/api/agent/rules`).
- Идемпотентность `publish`/`acknowledge` симметрична существующему `chat_message_queue` — меньше сюрпризов при ретраях.

### Компромиссы

- Две таблицы (манифест + подтверждения) вместо одной — нужен контроль индексов. Запрос на snapshot ≤ 5 мс дополнительного времени при ≤ 50 активных правилах.
- «Применил, а не прочитал» остаётся косвенной гарантией через строку подтверждения. Глубокая семантика применения — отдельная задача.
- Валидация `rule_ref` действует только на новые публикации. Старые сообщения без `rule_ref` не переклассифицируются задним числом.

## Rollout

1. **Миграция БД**: создать `agent_rules_manifests` и `rule_acknowledgements` с индексами в одной обратимой миграции (UP/DOWN).
2. **Инструменты**: добавить `taskflow_rule_publish` и `taskflow_rule_acknowledge` в `chatTools.ts`, регистрация через общий реестр `inProcessRun`. Идемпотентность через уникальные ключи.
3. **Блок в snapshot**: в `roleContextResolver.ts` зарегистрировать блок `rules.pending_acknowledgement` через `registerInstructionBlock` после слоя `rules`. Запрос — по индексу, EXISTS по подтверждениям.
4. **Защита `rule_ref`**: в `chat_send` добавить валидацию `rule_publication_requires_rule_ref` для сообщений с признаком правила. Свободные сообщения владельца не трогаем.
5. **Событие `rule_superseded`**: при успешной публикации новой версии писать событие в `task_events` через существующий механизм.
6. **Документ-спецификация** в БЗ проекта (`TaskFlow — NewTodoist`): схема таблиц, контракт двух инструментов, формат блока snapshot. Это вход для QA.
7. **Ветка и проверка**: разработка в `roles/51763de5-…`, проверка AC-1…AC-6 на QA-копии, ревью, перенос в `main` (после положительной проверки), выкладка на `192.168.1.110`.

Ответственный за интеграцию (по полю карточки): архитектор.

## Rollback

1. Снять регистрацию `taskflow_rule_publish` и `taskflow_rule_acknowledge` из реестра инструментов.
2. Откатить изменения `roleContextResolver.ts` и `inProcessRun.ts:1191` — старый snapshot без блока `rules.pending_acknowledgement` остаётся работоспособным (обратная совместимость).
3. Выполнить DOWN-миграцию: `DROP TABLE agent_rules_manifests`, `rule_acknowledgements`.
4. Снять валидацию `rule_publication_requires_rule_ref` в `chat_send`.

Внешний эффект после rollback: ни одно правило не действует через новый механизм; существующие жёсткие правила продолжают идти через `AGENT_RULES`. Старые клиенты не читают новый блок и работают без изменений.

## Контрактные точки в коде

- `server/src/agentState.ts` — текущий блок `rules`.
- `server/src/lib/roleContextResolver.ts:111-118, 225-300` — слой `rules` и `registerInstructionBlock`/`composeLayer`.
- `server/src/runtime/inProcessRun.ts:1191` — формирование `instruction_snapshot`.
- `server/src/runtime/chatTools.ts:13-104` — `chat_send` и `slot_topic_inbox`.

## Открытые вопросы для владельца

| Вопрос | Рекомендация архитектора |
| --- | --- |
| Q1 — массив или маска в `role_scope` | Массив `string[]`. Маска — отдельная задача. |
| Q4 — сид из `AGENTS.md` | Не включать. Существующие правила идут через `AGENT_RULES`. |
| Q5 — статус `retracted` | Не делать в рамках этапа B. |
| Q6 — срок хранения `superseded` | Навсегда. Удаление — отдельная задача. |

Если владелец изменяет рекомендации — следующий цикл.
