# Lifecycle — полный цикл жизни одного уведомления

## Состояния файла уведомления

```
inbox/YYYY-MM-DD/HHMMSS-<source>.md состояния:

  [нет файла]                      → эмиттер не слал ещё
  [создан rendezvous]              → есть .md, возможно есть ticket в _diagnostic/
  [заполнен watcher'ом Phase 4]   → .md содержит блок "По результатам диагностики"
  [завершён writer'ом Phase 4]     → .md содержит блок "Итог по устранению"
```

Состояния **тикета** в `_diagnostic/`:

```
  <HHMMSS>-<src>.json со status="pending"        → ещё не обработан
  <HHMMSS>-<src>.json.processed.<ts>            → обработан, INSERT сделан
```

Задача в TaskFlow БД:

```
  [tasks] в state=todo                          → никто не взял
  [tasks] в state=in_progress                  → исполнитель работает
  [tasks] в state=review                       → сделано, отдан на приёмку
  [tasks] в state=closed (= completed)         → Maksim принял
```

Дочерняя карточка на устранение — то же самое (собственный цикл).

## Полный цикл (идеальный сценарий)

```
1. 2026-09-27T03:00     kb-add шлёт alert_send.send("kb-add", "warning",
                          "База знаний обновлена", lines)

2. ...                  rendezvous.write() анализирует, находит маркер тревоги
                          → пишет .md (формат см. file-format.md)
                          → пишет ticket в inbox/.../_diagnostic/<HHMMSS>-kb-add.json
                          со status="pending"

3. ...через ≤1 сек...    inboxTriageWatcher (polling 1с, в TaskFlow-сервере)
                          → видит новый ticket
                          → INSERT INTO tasks (creator=u1, priority=2, agent_state='todo')
                          → INSERT INTO notifications (owner'a)
                          → rename ticket → <HHMMSS>-kb-add.json.processed.<ts>

4. ...                  Исполнитель видит уведомление в приложении
                          (через notifications-api GET /notifications/triage)
                          → берёт карточку диагностики в работу
                          → claim → state in_progress
                          → делает диагностику, оставляет комментарий
                          → state=review
                          (закрывает шаги subtask'ов — если есть)

5. ...через ≤3 сек...    inboxResultsWriter (polling 3с)
                          → видит state_changed → review для нашей карточки
                          (парсит description — там "Авто-создано inbox-triage-watcher из <...>")
                          → читает последний комментарий
                          → если "подтвердилось" → INSERT INTO tasks (parent=...)
                            с title="Устранение: ..."
                          → appendBlock() в .md файл:
                            ## По результатам диагностики
                            Подтвердилось: <комментарий>
                            По подтверждённым проблемам создана карточка
                            на устранение: [ссылка tf://task/...]
                          → HTML-комментарий marker
                            <!-- results-writer: <task_id> diag-review -->

6. ...                  Исполнитель берёт карточку "Устранение: ..."
                          → делает работу
                          → оставляет комментарий с решением
                          → state=review

7. ...через ≤3 сек...    inboxResultsWriter
                          → видит state_changed → review для "Устранение: ..."
                          → парсит последний комментарий
                          → если (решено|исправлено|✅) → строка "(исправлено)" — неактивная
                          → если (нет доступ|нет прав|provisioning)
                              → "(не исправлено: нет доступов у исполнителя)" — активная
                          → иначе
                              → "(не исправлено, нужно ваше решение...)" — активная
                          → appendBlock() с новым marker.

8. ...                  Maksim видит в приложении (Phase 5 UI):
                          → тап на "(не исправлено: ...)" → модальное окно
                          → выбирает/правит вариант
                          → submit → POST /api/tasks/<fix-id>/comments
                          → TaskFlow переводит в in_progress автоматически
                          (через существующий dispatch protocol)
```

## Запасные пути

### Эмиттер не нужен (свободные text без маркера тревоги)

```
1. ... rendezvous пишет .md без _diagnostic/* — просто сводка
2. Приложение показывает как "всё ОК"
3. Никакая карточка не создаётся
```

### Карточка закрыта без подтверждения (false positive)

```
4. Исполнитель пишет в комментарий "проблема не подтвердилась"
   → state=review
5. inboxResultsWriter → "не подтвердилось" → appendBlock:
   ## По результатам диагностики
   Проблема не подтвердилась.
6. Карточка закрыта как completed, без создания дочерней.
```

### Rendezvous упал / файл не долетел

```
- Всегда есть retry на стороне rendezvous (он сам себя не считает
  обработанным пока не запишет файл)
- Канал 1 = файл. Даже если n8n лёг, файл всё равно лежит в inbox/
- Приложение читает файл напрямую через /notifications/raw
```

### InboxTriageWatcher не подхватил ticket

```
- ticket останется в _diagnostic/<file>.json без суффикса .processed
- На следующем тике polling'а он будет подхвачен снова
- (если watcher отвалится, тикет будет ждать следующего запуска процесса)
```

### InboxResultsWriter отстаёт

```
- state_changed событие остаётся в task_events
- Writer берёт события из окна WINDOW_MIN (default 10 мин)
- За пределами окна — событие считается устаревшим.
  (Это by-design — старые события не должны повторно дописывать
  результаты).
- Если нужен "расширенный" lookup окна — поднять переменную
  RESULTS_WRITER_WINDOW_MIN.
```

## Гарантии

| Что | Гарантировано | Как обеспечивается |
|---|---|---|
| Сводка дойдёт в inbox/ | ✅ даже если n8n + telegram лёг | rendezvous пишет в файл до всех внешних каналов |
| Карточка создастся | ✅ даже если приложение офф | polling watcher работает в долгоживущем TaskFlow-сервере |
| Блок результата допишется в .md | ✅ даже если Maksim не открыл приложение | polling writer тоже работает в TaskFlow-сервере |
| Приложение прочитает свежий .md | ✅ в течение 5 сек после polling writer | GET /notifications/raw сразу возвращает |
| Telegram-подтверждение "получено" | ⚠️ best-effort | через xray-secretary-voice, без гарантии |

## Принцип "не молчим если сломались"

Если watcher или writer упали — приложение заметит это потому что файлы
перестанут обновляться. Контрольный cron проверяет свежесть файлов:

```bash
# TODO: добавить в autonomy-report.py проверку свежести
inbox/latest=$(ls -t ~/Проекты/taskflow-уведомления/inbox/2026-*/HHMMSS-*.md 2>/dev/null | head -1)
if [[ $(find $inbox/latest -mmin -30 2>/dev/null) == "" ]]; then
   echo "ОШИБКА: последний файл сводки старше 30 мин"
fi
```

(Это будет добавлено в следующей итерации.)
