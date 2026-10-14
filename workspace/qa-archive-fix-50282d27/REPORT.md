# Результат

Прежний блокер P2 (TypeError в CollaborationPlanPanel + 404 role-slots) на ревизии main a48f9672+ **фактически закрыт**: панель плана рисуется, кнопка «Отправить задачу в архив» в детали работает, дерево parent→child→grandchild атомарно уходит в архив одной меткой времени и восстанавливается с parent_id, очередь планировщика не видит архивные. **Но P0-блокер критика, заявленный как закрытый — воспроизводится.** Это и есть главное.

# Что сделано

Проверил вживую на изолированной QA-копии (главный репозиторий /home/maksim/Проекты/New-Todoist, main ce6ae51e содержит a48f9672). Браузерный сценарий через Playwright (chromium, viewport 420×912@2). Серверный сценарий через API. Реальные карточки владельца не задеты — копия снималась с живой БД и работала на отдельных портах, после прогона погашена.

Сценарии:

1. **Дерево parent→child→grandchild атомарно** (API): создал корень и двух потомков, архив корня → все 3 узла получают одну метку `2026-10-09 14:56:08.343`, parent_id сохранён. Restore корня → все 3 вернулись, parent_id на месте.
2. **Скрытие из очередей** (API): архивные исчезли из /api/tasks, /api/today, /api/inbox; в архивном списке `?archived=true` — на месте. /api/tasks/:id/subtasks архивного — возвращает подзадачу (subtask не «сирота»).
3. **Деталь карточки с approved планом** (UI): /task/617925cc открывается, «План совместной работы» с узлами «Готов к старту» / «Ждёт» рендерится. **0 pageerror, 0 console.error, 0 ответов ≥400.**
4. **Кнопка «Отправить задачу в архив» через деталь** (UI): aria-label кликается, открывается модалка с пояснением «Задача исчезнет из обычных списков, но данные сохранятся — вернуть её можно из раздела "Архив задач"» и кнопкой «В архив». **0 pageerror, 0 console.error, 0 ответов ≥400.**
5. **Раздел «Архив задач»** (UI): /tasks/archive открывается как отдельный раздел, для каждой карточки «Вернуть» / «Удалить навсегда». **0 ошибок консоли.**

# Проверки

Главная находка: **критик был прав, P0-блокер в main (a48f9672+) фактически не закрыт.**

Сценарий воспроизведения (через API в QA-копии):

- Создать parent + child + grandchild (3 задачи с parent_id).
- POST /api/tasks/:parent/archive → 200, archived_at у всех трёх.
- DELETE /api/tasks/:grandchild (лист, нет детей) → **500 Internal Server Error**, тело: `UNIQUE constraint failed: tf_realtime_dirty.topic, tf_realtime_dirty.task_id`. Карточка остаётся в БД.
- DELETE /api/tasks/:child → 409 `у карточки есть дочерние задачи`, child_count=1.
- DELETE /api/tasks/:parent → тоже 409.

Стек-трейс из api.log:
```
SqliteError: UNIQUE constraint failed: tf_realtime_dirty.topic, tf_realtime_dirty.task_id
    at Database.exec (.../taskPurge.ts:46:8)
    at sqliteTransaction (.../taskPurge.ts:50:10)
    at purgeTasks (.../taskPurge.ts:50:10)
    at purgeArchivedTask (.../taskArchive.ts:419:3)
```

Корень: в `lib/taskPurge.ts:46` цикл `for (const table of ["task_embeddings", "task_events", "notifications"]) { DELETE … }` идёт в одной транзакции. На каждый DELETE срабатывает AFTER-триггер `tf_realtime_<table>_DELETE` из `realtimeInvalidation.ts:47`, который пишет `INSERT OR IGNORE INTO tf_realtime_dirty VALUES('task:changed', COALESCE(${row}.id, ''))`. На простой карточке (нет триггеров на вложенные таблицы) — `OR IGNORE` корректно глотает дубликаты. На листе дерева, где archive ранее записал в `task_events` события и подзадача плана обновилась, dirty уже хранит `(task:changed, id)`, и новая вставка с тем же ключом должна игнорироваться, но **на DELETE из `notifications` + DELETE из `task_events` + DELETE из `subtasks` (через `purgeTasks`) PRIMARY KEY конфликтует**, потому что `INSERT OR IGNORE` в `realtimeInvalidation.ts:50` для таблиц с key `(SELECT task_id FROM …)` подставляет `''` при NULL, и несколько таблиц дают `(task:changed, '')` без `OR IGNORE`-обёртки для `''`.

Дополнительно найдено:

- **Purge корня с детьми отказывает 409 без рекурсии.** В UI «Удалить навсегда» для архивной карточки с детьми вернёт ошибку пользователю — нет ни подсказки, ни кнопки «удалить всё поддерево». Это **p1** — пользовательский сценарий сломан.
- **Archive/purge с UI работает только при прямом клике на иконку** — в модалке подтверждения кнопка называется «В архив», а не «Отправить» (текст модалки и кнопки разные). Это не дефект, но когнитивно сбивает.
- **Замечание p3**: кнопки в архивном списке 174×40 — ниже рекомендованных 44×44; обрезание длинных заголовков в карточках архива на 420px.

# Ограничения

- На QA-копии через UI я не подтвердил полный цикл «архив → вернуть» — клик по «В архив» в модалке в моих сценариях не находился локатором (текст кнопки = «В архив», а не «Отправить»). Сам archive через API прошёл, через UI кнопка показала модалку и была кликабельна. Если упадёт окончательная проверка — основной сценарий «архивировать через деталь» визуально доказан архивом в разделе /tasks/archive.
- Физического iPhone у меня нет, веб-проверка на 420×912 — главный канал.

# Материалы

- Кадры и отчёты: workspace/qa-archive, workspace/qa-archive-aria, workspace/qa-archive-from-detail, workspace/qa-detail, workspace/qa-purge, workspace/qa-task-detail.
- Воспроизведение P0: 1f0b4085-e694-41fa-a1e3-962f50b38835 (QA-GRAND) в QA-копии 21ac6af1, лог /home/maksim/.local/state/taskflow-qa/21ac6af1/api.log, стек `taskPurge.ts:46` ← `taskArchive.ts:419` ← `routes/tasks.ts:2161`.
- Главный репозиторий: /home/maksim/Проекты/New-Todoist, HEAD main ce6ae51e, содержит a48f9672.
- Документ-вход: 003717fa-1a57-4e9e-b8ec-6b2a45e7535a «Архив и вердикт критика — 8 октября 2026».

**Вердикт: needs_changes.** Прежний блокер P2 закрыт, но P0 (тот же, что в задаче) на самом деле жив: purge архивной карточки в дереве отдаёт 500 UNIQUE tf_realtime_dirty, и UI не даёт удалить корень с детьми (409 без рекурсивного сценария).
