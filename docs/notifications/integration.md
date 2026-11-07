# Integration — как подключить нового эмиттера за 5 минут

## Если у вас уже есть Python-скрипт, шлющий через старый alert_send (n8n)

Ничего не меняется — `alert_send.send(source, level, title, text)` уже ходит
в rendezvous (канал 1 = файл). Появится файл, polling watcher подхватит.

```python
# в вашем existing коде
from alert_send import send
send("my-source", "warning", "Тема уведомления", lines)
```

## Если вы пишете нового эмиттера с нуля

1. **Использовать `alert_send` (рекомендуется)** — унифицированный маршрут:
   ```python
   from alert_send import send
   send("my-source", "warning", "Тема уведомления",
        "Строка 1\nСтрока 2\n🚨 Канал-то сломался")
   ```

2. **Если не хотите через alert_send** (например, шелл-скрипт):
   ```bash
   printf 'сжатие памяти: 4 прогонов ...\n🚨 канал-то сломался ...\n' | \
     tee /tmp/svodka.txt | \
     env -i \
       HOME=/home/maksim \
       TASKFLOW_NOTIF_ROOT=/home/maksim/Проекты/taskflow-уведомления \
       python3 /home/maksim/infra-ops/rendezvous.py \
         --source "my-source" \
         --level "warning" \
         --title "Тема уведомления" \
         --text "$(cat /tmp/svodka.txt)"
   rm /tmp/svodka.txt
   ```

3. **Из файла** (если сводка большая):
   ```bash
   python3 /home/maksim/infra-ops/rendezvous.py \
     --source "my-source" \
     --level "warning" \
     --title "Тема уведомления" \
     --text-file /path/to/big-svodka.md
   ```

## Если вы хотите слать HTTP-запросом без Python-обёртки

`rendezvous.py` экспортирует CLI. Можно вызвать из любого языка:

```bash
SVO=$(cat my_text.txt)
python3 /home/maksim/infra-ops/rendezvous.py \
  --source "my-source" \
  --level "info" \
  --title "My title" \
  --text "$SVO"
```

(CLI морду видим выше — `--source/--level/--title/--text/--text-file`)

## Поведение rendezvous.write() / send()

| Шаг | Что |
|---|---|
| 1 | Принимает text |
| 2 | Делит строки на «штатные»/«с тревогой» по маркерам (см. file-format.md) |
| 3 | Создаёт файл `inbox/YYYY-MM-DD/HHMMSS-<source>.md` (атомарно через .tmp+rename) |
| 4 | Если есть тревога — пишет ticket `inbox/.../_diagnostic/<HHMMSS>-<source>.json` со `status="pending"` |
| 5 | Возвращает путь до файла и какие маркеры нашлись |
| 6 | Возвращает объект `{path, has_triage, triage_lines, diagnostic_card}` |

## Соглашения по именам `source`

`source` это уникальная метка эмиттера. Не используйте пробелы, только
`[a-z0-9-]`.

Примеры существующих:
- `autonomy-110`
- `kb-add`
- `runaway-110`
- `monitor-110`

## Dry-run

Для локальной проверки формата:
```bash
DRY_RUN_TRIAGE=1 python3 /home/maksim/infra-ops/rendezvous.py \
  --source "test" --level "info" --title "Тест" \
  --text "Строка 1\n🚨 канал сломался\n"
```

`DRY_RUN_TRIAGE=1`:
- файл уведомления создаётся (для проверки форматирования)
- ticket создаётся (для проверки маркеров)
- но `inboxTriageWatcher` при следующем тике подхватит — `dry_run: true` в JSON
  означает "только переименовать, INSERT в БД не делать"

## Тестирование канала

```bash
python3 -c "
import sys
sys.path.insert(0, '/home/maksim/infra-ops')
import alert_send
result = alert_send.send('test-channel', 'info', 'Тестовый сценарий',
                         'сжатие памяти: 4 прогонов\n🚨 канал-то сломался')
print('send:', result)
"
```

Проверка:
- появился файл в `inbox/<YYYY-MM-DD>/HHMMSS-test-channel.md`
- появился `inbox/.../_diagnostic/HHMMSS-test-channel.json`
- через ~1 сек inboxTriageWatcher создал карточку в БД TaskFlow
- уведомление появилось у Maksim'а в БД `notifications`

## Маркеры тревог (если нужно добавить новый)

1. Договориться с Maksim — какой текст означает тревогу
2. Добавить в `rendezvous.py:TRIAGE_MARKERS`
3. Добавить в KB docs/notifications/file-format.md
4. (опц.) Добавить эмиттелю — может ли быть ложное срабатывание?

## Слать на iOS-приложение (приложение уже умеет)

iOS-приложение вызывает `GET /notifications/inbox?date=YYYY-MM-DD`
на `http://192.168.1.110:5198`. Оно получает свежие уведомления
автоматически.

## Что **НЕЛЬЗЯ** делать эмиттеру

- ❌ Вызывать прямой HTTP к TaskFlow `/api/tasks` (правило 27.09.2026)
- ❌ Вызывать `hermes` CLI или любой MCP из своего кода
- ❌ Писать в `_results/` — это другая часть (для close-event)
- ❌ Использовать другой шаблон сводки — формат зафиксирован
