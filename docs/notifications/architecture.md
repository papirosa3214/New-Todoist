# Architecture — Notifications Backend

## Состав системы

| Слой | Где | Код | Что делает |
|---|---|---|---|
| Эмиттеры | `~/infra-ops/*.py`, `~/kb/*.py`, `~/.config/cron/*` | `alert_send.send()` | Пишут уведомления через общий API |
| Приёмник | `~/infra-ops/rendezvous.py` | модуль | Получает уведомление, форматирует, пишет .md в inbox/, при тревоге — пишет ticket в `_diagnostic/` |
| Канал 1 rendezvous | `~/infra-ops/alert_send.py:send()` | отдаёт в rendezvous через `rendezvous.write()` | всегда доходит, не зависит от внешних сервисов |
| File watcher | `~/Проекты/New-Todoist/server/src/lib/inboxTriageWatcher.ts` | polling 1с | Читает новые tickets в `_diagnostic/`, INSERT INTO tasks прямо в БД TaskFlow |
| Results writer | `~/Проекты/New-Todoist/server/src/lib/inboxResultsWriter.ts` | polling 3с | Читает новые `task_events` (state_changed в review) для наших карточек, дописывает блоки в .md файл, создаёт дочерние карточки на устранение |
| HTTP API | `~/infra-ops/notifications_api.py` | uvicorn 0.0.0.0:5198 | Только чтение .md файлов и метаданных для iOS-приложения |
| Telegram-резерв | `~/kb/notify_monitor_bot.sh` | systemd integration | 1 короткая строка "сводка доставлена" через xray-secretary-voice |
| База знаний | `~/kb/kb_add.py` | скрипт | Документация заливается в RAGFlow для семантического поиска |

## Поток данных — от эмиттера до приложения

1. **Эмиттер** (например `autonomy-report.py` после утреннего прогона):
   ```python
   import alert_send
   alert_send.send("autonomy-110", "error", "Автономность .110 — сводка за сутки",
                   text="\n".join(lines))
   ```

2. **`alert_send.send()`** (канал 1 = rendezvous, всегда доходит):
   ```python
   rendezvous.write(source, level, title, text)  # → пишет .md
   # также (best-effort) → n8n → tg-relay → Telegram
   # also: notify_monitor_bot.sh → Telegram через xray-secretary-voice
   ```

3. **`rendezvous.write()`**:
   - парсит text на «Работают в штатном» / «Не отработали» по маркерам
   - форматирует в формат сводки (см. file-format.md)
   - пишет `~/Проекты/taskflow-уведомления/inbox/YYYY-MM-DD/HHMMSS-<source>.md`
   - если есть тревога → пишет `inbox/YYYY-MM-DD/_diagnostic/HHMMSS-<source>.json` со `status=pending`

4. **`inboxTriageWatcher.ts`** (внутри TaskFlow, polling 1с):
   - видит новый `_diagnostic/<HHMMSS>-<source>.json`
   - парсит JSON ticket
   - **INSERT INTO tasks** с creator_id=u1 (Максим), priority=2, agent_state='todo'
   - добавляет уведомление в notifications
   - rename `<file>.json.processed.<ts>` (идемпотентность)

5. **Исполнитель/агент** берёт карточку в работу, делает диагностику, оставляет
   комментарий, переводит в `state=review`

6. **`inboxResultsWriter.ts`** (polling 3с, polling task_events):
   - видит `kind=state_changed, to_value=review` для карточки с маркером
     "Авто-создано inbox-triage-watcher из ..."
   - если `title` начинается с `[Диагностика]`:
     - парсит последний комментарий исполнителя
     - если есть подтверждение → INSERT INTO tasks (дочерняя, "Устранение: ...")
     - дописывает блок «По результатам диагностики» в .md файл
   - если `title` начинается с "Устранение:":
     - дописывает блок «Итог по устранению» с одним из вариантов:
       `(исправлено)` / `(не исправлено: нет доступов)` / `(не исправлено, нужно решение)`

7. **notifications-api** (`0.0.0.0:5198`) — обслуживает чтение для iOS-приложения.
   См. [api.md](api.md).

8. **iOS-приложение** (на Маке, делается исполнителем):
   - раздел "Обзор → Уведомления", два подраздела
     - "Завершённые задачи" — обычные задачи TaskFlow
     - "Сторонние сервисы" — карточки-тикеты из этого контура
   - читает JSON с 5198, рисует карточки, при тапе на `tf://task/<uuid>`
     открывает соответствующую задачу в TaskFlow
   - при клике на `(не исправлено: ...)` — модальный диалог с 4 вариантами,
     submit = POST `/api/tasks/:id/comments`

## Конкурентность

- `inboxTriageWatcher` сделан single-thread через set+busy — никаких гонок
- `inboxResultsWriter` polling, не inotify — перезапуск watcher'а на tick
  безопасен благодаря **идемпотентности на двух уровнях**:
  - файловый marker `<!-- results-writer: <task_id> ... -->` в `.md`
  - **idempotent INSERT** в БД для дочерних карточек устранения
    (SELECT перед INSERT по `(parent_id, title)`) — фикс после теста
    с тремя рестартами подряд см.
    [урок 2026-09-27-polling-idempotency-restart.md](../../../../kb/lessons/2026-09-27-polling-idempotency-restart.md)
- `notifications-api` стартует как uvicorn single-worker — поддерживает
  лучше 100 req/s (хватает для приложения)

## Идемпотентность

- Ticket: обработанный файл переименовывается в `.processed.<ms>` — повторный
  проход не подхватит.
- Карточка диагностики: writer создаёт дочернюю карточку "Устранение:" ОДИН
  раз. Повторный запуск через `discoverTrackedFromDb` сохраняет маркер.
- Блоки в .md: идемпотентный marker `<!-- results-writer: <task_id> diag-review -->`
  — при наличии блок не дописывается.

## Что НЕ входит в этот контур

- ❌ Обработка комментариев Maksim'а (приложение делает это само через TaskFlow API)
- ❌ Создание самих задач-устранений с участием пользователя (только авто-создание по результату диагностики)
- ❌ Push-уведомления о срочных тревогах (отдельный канал, не реализован)
- ❌ iOS UI (делается на Маке)
