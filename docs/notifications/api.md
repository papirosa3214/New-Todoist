# API — Контракт HTTP для iOS-приложения

**URL:** `http://192.168.1.110:5198`

**Сервис:** `~/.config/systemd/user/notifications-api.service`

**Авторизация:** нет (LAN).
**Формат:** JSON (request/response), UTF-8.
**Версия:** 1.0

## Эндпоинты

### GET /

Справка.

**Ответ 200:**
```json
{
  "service": "TaskFlow Notifications API",
  "version": "1.0",
  "endpoints": [
    "GET /notifications/inbox?date=YYYY-MM-DD",
    "GET /notifications/by-source?source=NAME&hours=24",
    "GET /notifications/triage?date=YYYY-MM-DD",
    "GET /notifications/raw?path=/abs/path.md"
  ],
  "inbox_root": "/home/maksim/Проекты/taskflow-уведомления"
}
```

### GET /notifications/inbox

Список карточек-тикетов за день (по умолчанию — за все имеющиеся дни).

**Query:**
- `date` (опц.) — `YYYY-MM-DD`, default `all`

**Ответ 200:**
```json
{
  "date": "2026-09-27",
  "count": 2,
  "items": [
    {
      "id": "inbox/2026-09-27/015101-autonomy-110",
      "path": "/home/maksim/Проекты/taskflow-уведомления/inbox/2026-09-27/015101-autonomy-110.md",
      "title": "Автономность .110 — сводка за сутки",
      "ts": "2026-09-27T01:51:01",
      "source": "autonomy-110",
      "level": "error",
      "has_triage": true,
      "snippet": "## Сводка ...",
      "links": []
    }
  ]
}
```

### GET /notifications/by-source

Карточки одного эмиттера за последние N часов.

**Query:**
- `source` (обяз.) — имя эмиттера (например `autonomy-110`, `kb-add`)
- `hours` (опц.) — целое 1..720, default 24

**Ответ 200:** аналогично `/notifications/inbox`, поле `date` заменено на путь-маркер.

### GET /notifications/triage

Только карточки с тревогой.

**Query:**
- `date` (опц.) — `YYYY-MM-DD`, default `all`

**Ответ 200:** формат как `/notifications/inbox`, `items` фильтруется по `has_triage: true`.

### GET /notifications/raw

Полный текст одного .md файла (для рендера полной карточки-тикета).

**Query:**
- `path` (обяз.) — абсолютный путь до .md файла

**Ответ 200:** `text/plain` — полный markdown с метаданными, телом сводки и блоками «По результатам диагностики» / «Итог по устранению», если они дописаны.

**Ответ 403:** path выходит за пределы `~/Проекты/taskflow-уведомления/`.
**Ответ 404:** файл не существует или не .md.

## Поведение метаданных файла

Парсер читает первые строки .md файла после заголовка `# <title>`:

```markdown
# <TITLE>

- **когда:** 2026-09-27T01:11:33      ← парсится → ts
- **от кого:** autonomy-110          ← парсится → source
- **уровень:** error                  ← парсится → level
- **тревога:** да                     ← парсится → has_triage = (yes if "да")
- **приёмка:** rendezvous.py v1       ← (метаданные для diagnostics)

## Сводка (для отображения в приложении)

```                              ← snippet обрезается на 500 символов

... содержимое сводки ...

```
```

Связи `tf://task/<uuid>` внутри текста попадают в поле `links[]`.

## Пример вызова (curl)

```bash
curl 'http://192.168.1.110:5198/notifications/inbox?date=2026-09-27' | jq .
```

```bash
curl 'http://192.168.1.110:5198/notifications/triage?date=2026-09-27' | jq '.items[] | {id, title, level}'
```

```bash
curl 'http://192.168.1.110:5198/notifications/raw?path=/home/maksim/Проекты/taskflow-уведомления/inbox/2026-09-27/015101-autonomy-110.md'
```

## Что версия API не гарантирует

- **Стабильный id уведомления:** id = относительный путь, может переименоваться при перемещении
- **Атомарность:** API читает диск при каждом запросе, без кеша. Если файл перепишется между двумя вызовами, ответ может измениться. Это by-design — пользовательский опыт строится на свежих данных.
- **Rate limit:** нет. Внутри LAN держит ~100 req/s.
- **Тrace ID:** нет. Если что-то сломается — смотри `journalctl --user -u notifications-api`.

## Эволюция

Если нужен новый endpoint или меняется формат — пиши в [history.md](history.md)
с пометкой о несовместимости, и обнови этот файл.
