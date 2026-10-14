# ollama-shim упал и поднят (2026-10-12)

**Карточка:** 02e903cb-dd1f-4192-a0fa-4a51829283ba
**Сервис:** `ollama-shim.service` (user), прокладка `127.0.0.1:11500 → 127.0.0.1:11434`.
**Скрипт:** `/home/maksim/infra-ops/ollama_nothink_shim.py`.

## Что случилось

В 23:49:50 сервис остановился. Журнал systemd показывает чистый выход:

- `code=killed, signal=TERM`
- `Result=success`, `ExitType=main`
- `Restart=on-failure` НЕ сработал, потому что systemd классифицировал TERM как штатное завершение.

Видимой причины в журнале нет: ни OOM, ни `systemctl stop`, ни явный таймер не зафиксированы. За 9 секунд до этого деактивировался `session-697371.scope` — прямой связи не вижу, но похоже на пользовательский systemd-cleanup, который прибил user-юнит.

Сервис до этого отработал 15 дней без перезапуска (`ExecMainStartTimestamp=2026-09-27 18:44:30`).

## Что сделано

- `systemctl --user restart ollama-shim.service` в 23:51:10.
- Проверено: `is-active` → `active`, `ss -ltn` показывает `:11500` (PID 524700).
- `/api/tags` и `/v1/models` через прокладку отвечают как у прямого :11434.
- Chat/completions через :11500 вернул `server busy, maximum pending requests exceeded` — это ollama перегружена (тот же ответ приходит и на :11434), не дефект прокладки.

## Что НЕ сделано и почему

- `Restart=` не менял. Сейчас `on-failure`; если сервис снова кто-то/что-то чисто остановит, автоподъёма не будет. Изменение требует решения владельца:
  - `Restart=always` — простой и грубый, маскирует ручные остановки.
  - Добавить таймер/healthcheck на :11500 — точечно ловит тихий отказ без правки самого юнита.
  - Оставить как есть и реагировать на алерт monitor-110.
- Причина TERM не установлена. Если повторится — собрать `journalctl --user -u ollama-shim.service -n 500` за момент падения и `loginctl list-sessions`, чтобы найти источник.

## Связанное

- Паспорт: `/home/maksim/infra-ops/notification_passports.json`, ключ `ollama-shim.service`.
- Состояние монитора: `/home/maksim/service-monitor/state` (обновляется раз в минуту).
- Урок из скрипта: при чистом TERM systemd не поднимает user-сервисы, даже если `Restart=on-failure`. Для тихих отказов нужен внешний сторож.