# Реестр будильника/диспетчеризации TaskFlow

Карточка 5f292e87 (MVP надёжной доставки поручений). Режим — только наблюдение: описывает существующие потоки, ничего не меняет в trigger.py/systemd/раннерах/правах ролей.

## 1. Источник → триггер → адресат

| Источник | Триггер (файл:строка) | Адресат | Данные | Исход | Ошибка |
|----------|----------------------|---------|--------|-------|--------|
| `agent_inbox` (новая таблица) | `/api/agent-inbox/enqueue` (chat.ts) | `to_user_id` из message | `body_text, task_id, task_version, kind, event_type` | `routed_to` (catalog) | 401 unauthorized / 400 bad body |
| `agent_inbox` mark-status | `/api/agent-inbox/:id/mark` (agent-inbox.ts) | сам исполнитель | `status, blocked_reason` | `status, logEvent('inbox_status')` | 404 not found / 409 переход назад |
| Chat message (assignment) | `chat.ts` INSERT в `chat_messages` | `to_user_id` (явный) или catalog fallback в orchestrator | `body_text, task_id, kind` | `agent_inbox` row + `logEvent('inbox_received')` | обычные ошибки HTTP |
| Review→in_progress (return) | `agentState.ts` (старая логика) | `assignee_id` (исходный) | task_id | inbox row + `logEvent` | Review 404, конфликт lease |
| Assignment (новая задача) | `tasks.ts` POST /api/tasks | `assignee_id` | `task_id, task_version` | inbox row event_type='assignment' | 403, 409 |

## 2. События и статусы

```
sending → sent (по умолчанию при INSERT)
        ↓
receiving → received (агент прочёл)
        ↓
acting → acting (агент взял)
        ↓
done | blocked (результат или стоп-фактор)
```

Переходы только вперёд (`mark_status` блокирует обратный путь).

## 3. Защита от устаревших событий

`/api/agent-inbox/:id/mark` перед переводом в `done`/`acting`:
- Берёт `tasks.current_revision` по `task_id`.
- Если `task_version` в inbox < `current_revision` → ставит `blocked`, пишет `inbox_stale` в журнал.
- Возвращает `dropped: true` в ответе.

## 4. Дедупликация

`UNIQUE (chat_message_id)` на `agent_inbox`. Повторная вставка по тому же `chat_message_id` → `IntegrityError`, `enqueue` глотает и возвращает `{dedup: true}`. Прочие `IntegrityError` (FOREIGN KEY) — НЕ глотаются, пробрасываются вызывающему коду.

## 5. Маршрутизация (catalog → addressee)

В `agent-inbox.ts` `routeAddressee()`:
- Явный `to_user_id` (от sender) → приоритет.
- Иначе → первый профиль в `team_catalog.json` с title, содержащим «оркестратор» (L4 fallback).
- В ответ `enqueue` возвращает `routed_to: {id, title}` + `basis: explicit_addressee | fallback_orchestrator | self`.

## 6. Что НЕ в этом реестре

- `trigger.py` (`board_scan_loop`, `heartbeat_loop`, `wake_resident`) — лежит в отдельной задаче. **Не правим** в этой карточке (Reviewer явно запретил).
- `agent_inbox` → в `claim`/`run_external` триггера — отдельная задача (Reviewer разрешил «точечно подключить», но пока не сделано).
- `chat.ts` INSERT в `chat_messages` уже зовёт `agent_inbox.enqueue` (правка внесена). Дальше — триггер.

**Why:** владелец хочет видеть, какие сигналы идут в триггер и какие обратно, без чтения trigger.py.
**How to apply:** при добавлении нового сигнала — строка в §1. При изменении flow — обновить §2.