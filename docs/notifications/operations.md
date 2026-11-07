# Operations — запуск, диагностика, мониторинг

## Запущенные службы

| Служба | Что делает | Как управлять |
|---|---|---|
| `notifications-api.service` | HTTP API 0.0.0.0:5198 | `systemctl --user status notifications-api` |
| `taskflow-server.service` | Сервер TaskFlow + **содержит** watchers inboxTriage/InboxResults | `systemctl --user status taskflow-server` |

Watchers **не существуют отдельно** — они часть `taskflow-server.service`,
запускаются при boot через `startInboxTriageWatcher()` и
`startInboxResultsWriter()` в `server/src/index.ts`.

## Логи

| Что | Где |
|---|---|
| TaskFlow server stdout/stderr | `/home/maksim/Проекты/New-Todoist/server/dev-server.log` (ротация включена) |
| notifications-api | `journalctl --user -u notifications-api` |
| rendezvous (если запускался руками) | stdout процесса |
| Файлы сводок (для просмотра в браузере) | `~/Проекты/taskflow-уведомления/inbox/YYYY-MM-DD/` |

### Быстрый grep по последним ошибкам watchers

```bash
grep -E "inbox-triage|results-writer|triage-watcher" \
  /home/maksim/Проекты/New-Todoist/server/dev-server.log | tail -50
```

### Уровни логов

Watcher'ы пишут в stdout сервера. Текущие события:

```
[inbox-triage] polling /home/.../inbox (every 1000 ms)        ← boot
[inbox-triage] scan error: ENOENT                              ← переходный
[results-writer] watching tasks (N known). poll=3000ms        ← boot
[results-writer] запись блока в /.../file.md не удалась: ...   ← ошибка записи
[results-writer] ошибка на /.../ticket.json: ...               ← обработка тикета
```

## Типичные проверки

### Свежесть сводок (за последний час)

```bash
find ~/Проекты/taskflow-уведомления/inbox/2026-*/ \
  -name "*.md" -newer /tmp/check_marker -mmin -60 \
  2>/dev/null | wc -l
```

(если 0 — значит ни один эмиттер ничего не слал, что может быть нормой)

### Активность watchers

```bash
grep "inbox-triage.*polling\|results-writer.*watching" \
  /home/maksim/Проекты/New-Todoist/server/dev-server.log | tail -2
```

(должны быть оба сообщения — boot-логи при старте/перезапуске)

### Свежесть файлов сводок

```bash
# Свежесть последнего файла
ls -lt ~/Проекты/taskflow-уведомления/inbox/2026-*/HHMMSS-*.md 2>/dev/null | head -3
```

## Ручной рестарт

### Перезапуск HTTP API (не нужен при изменениях в файлах)

```bash
systemctl --user restart notifications-api
```

### Перезапуск watchers

НЕ НУЖЕН отдельно — TaskFlow запускается через `tsx watch` который
автоматически перезагружает код при изменении. Если watcher перестал
работать (например, в логах ERRORы):

```bash
# Мягкий рестарт (TaskFlow через tsx watch):
systemctl --user restart taskflow-server

# Принудительный рестарт:
pkill -f "tsx.*src/index.ts"
systemctl --user start taskflow-server
```

## Диагностика "не приходят уведомления"

Шаг 1: уведомление должно было дойти в `inbox/YYYY-MM-DD/*.md`.
Не дошло — проблема в `alert_send` или `rendezvous`. Проверяем:

```bash
# Прямо из shell — должно появиться файл в inbox/<сегодня>/:
python3 -c "
import sys
sys.path.insert(0, '/home/maksim/infra-ops')
import alert_send
alert_send.send('test', 'info', 'Диагностика', 'шаблон 1\nсжатие памяти: ОК')
"

# Проверка появился ли файл:
ls -lt ~/Проекты/taskflow-уведомления/inbox/2026-*/HHMMSS-test.md | head -1
```

Шаг 2: появился .md, но не появился ticket в `_diagnostic/` — проблема в
маркерах. Читаем `rendezvous.py:TRIAGE_MARKERS` и добавляем свой.

Шаг 3: появился ticket, но нет карточки в TaskFlow. Смотрим:

```bash
# Выше/текущая сессия?
grep -c "inbox-triage" /home/maksim/Проекты/New-Todoist/server/dev-server.log

# Если 0 — TaskFlow перезагружается / watcher отключён
# Если много, но карточки всё равно нет — смотрим ошибки:
grep -A1 "inbox-triage.*ошибка\|results-writer.*ошибка" \
  /home/maksim/Проекты/New-Todoist/server/dev-server.log
```

Шаг 4: карточка есть, но .md не обновляется блоком результата. Смотрим
логи результатов:

```bash
grep "results-writer" /home/maksim/Проекты/New-Todoist/server/dev-server.log | tail -10
```

Если "0 known" — watcher не нашёл свои карточки (description не
содержит маркера). Если есть ошибки — приложить к багу.

Шаг 5: всё работает в логах, но приложение не показывает. Проверяем
notifications-api:

```bash
systemctl --user status notifications-api
curl -s http://localhost:5198/ | head -10
```

## Резервный ручной создатель карточки

Если всё совсем мёртвое и нужен ticket СЕЙЧАС — через прямой sqlite:

```bash
TASK_ID=$(uuidgen)
TICKET_REL="inbox/$(date +%Y-%m-%d)/_diagnostic/manual.json"
sqlite3 /home/maksim/Проекты/New-Todoist/server/taskflow.db <<EOF
INSERT INTO tasks (id, title, description, priority, creator_id, status, agent_state)
VALUES ('$TASK_ID', '[Диагностика] Ручное создание', 'Создано ручным режимом $TICKET_REL', 2, 'u1', 'active', 'todo');
INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)
VALUES ('$(uuidgen)', 'u1', 'manual_card', '$TASK_ID', 'Создано вручную', 'u1');
EOF
```

(НЕ рекомендуется — лучше починить watchers. Это для критического
инцидента.)

## Контроль молчаливого отказа

Должно быть добавлено в следующей итерации:
- см. `lifecycle.md#гарантии` — контрольный cron в `autonomy-report.py`

На 27.09.2026 пока не реализован.

## Что НЕ нужно делать руками

- ❌ Создавать .md файлы вручную (rendezvous делает это сам; ручные файлы
  считаются "не обработано" и могут попасть в неожиданные места)
- ❌ Создавать ticket в `_diagnostic/` вручную (только через rendezvous; иначе
  нет поля `status=pending` и watcher не подхватит, либо подхватит но без
  `dry_run=false` и не создаст карточку)
- ❌ Модифицировать .md пока watcher ещё не "поставил блок Карточка диагностики"
  (после написания этого блока writer будет дописывать дальше — пусть он не
  потеряет синхронизацию с полем `ts` и т.п.)
