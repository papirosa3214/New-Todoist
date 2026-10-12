# Сторож wake-канала вебхуков удалён — 12.10.2026

## Работа

Поручение владельца: «такой сторож тогда не нужен, чтобы он что-то там
проверял». Заодно выяснилось, что именно этот сторож наследил на доске 46 задач
«wake watcher probe».

## Результат

Сторожа нет в коде, накопленные probe-задачи вычищены из БД, индикация вебхуков
перенесена в приложение (см. `Sources/Features/Settings/ServerStatusSection.swift`
в репозитории iOS-клиента, документ `docs/2026-10-12-webhook-status-row.md`).

## Что сделано

- Удалён `server/src/lib/webhookWakeWatcher.ts` и его тест
  `server/test/webhookWakeWatcher.test.ts`.
- Из `server/src/index.ts` убран импорт и вызов `startWebhookWakeWatcher()`
  (старт на каждом старте сервера + раз в 30 минут).
- `docs/watchers.md`: раздел «4. Wake-канал вебхуков» переписан — сторож
  снят, причина его появления и чем он заменён остались зафиксированы.
- Из `taskflow.db` удалены 46 задач `probe-probe-webhook-wake-%` и 46
  синтетических событий `detail LIKE 'synthetic event from webhookWakeWatcher%'`,
  одной транзакцией. Перед удалением БД скопирована в
  `/tmp/taskflow.db.bak-before-probe-cleanup`.

## Почему мусор копился

`checkWebhookWakeInstrument` в `finally` чистит подписку, очередь wake и
синтетическое событие, но **не удаляет саму probe-задачу** — `taskId` после
`INSERT` больше нигде не используется. Сторож запускался при старте сервера и
раз в 30 минут, поэтому каждая его проба оставляла карточку навсегда. На доске
было видно 12, в БД нашлось 46 — часть была уже не в статусе «активна».

## Проверки

- `npx tsc --noEmit` — exit 0, типовых ошибок нет после удаления файла и вызова.
- `SELECT count(*) FROM tasks WHERE id LIKE 'probe-probe-webhook-wake-%'` — 0.
- Доска TaskFlow: задач «wake watcher probe» не осталось.

## Ограничения

- ⚠️ **ВЫКЛАДКА НЕ СДЕЛАНА.** `server/dist/index.js` собран 12.10 в 07:38,
  живой сервер работает на старой сборке, где сторож ещё есть. Пока не будет
  пересборки `dist` и рестарта, новые probe-задачи продолжат появляться.
- Пересборка выкатит на сервер и чужие незакоммиченные правки другого агента
  (16 изменённых файлов в `git status`, включая `runtime.ts`,
  `PiRuntimeAdapter.ts`, `providerProbe.ts`, `role-routing.yaml`), плюс
  невыложенный fallback Секретаря. Решение — за владельцем.

## Материалы

- `docs/2026-10-12-drop-webhook-wake-watcher.md`
- `docs/watchers.md` раздел 4
