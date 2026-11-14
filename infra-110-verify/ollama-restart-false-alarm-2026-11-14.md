# Trevoga monitor-110: «Ollama — УПАЛ» 14.11.2026 12:11:45 — ложная, это плановый рестарт

Карточка: `efc5bd56-b007-48f3-8830-6889efb353bd`.
Разбор целиком: note://d0c14b00-450b-434a-898b-73291686983a

## Итог

Ложная тревога. `ollama.service` не падала: юнит штатно остановили и подняли в ту же
секунду (12:11:45 `Stopping` → `Started`), через 61 секунду сторож сам написал
«восстановлен» (12:12:46). Служба работает, эмбеддинги отдают вектор 1024.

## Доказательства

- Журнал пользовательских юнитов, окно 12:09–12:14:
  `12:11:45 Stopping ollama.service` → `Stopped` → `Consumed 15h 43min 49s CPU time`
  → `Starting` → `Started` в ту же секунду. Нет `Main process exited`, нет
  `Failed with result`, `NRestarts=0` — то есть это не падение и не рестарт по кругу.
- Уведомления: `inbox/2026-11-14/121145-monitor-110.md` (УПАЛ) и
  `121246-monitor-110.md` (восстановлен).
- Рядом шла настройка Ollama: в 12:13:16 `systemctl daemon-reload` и остановка полос
  `ollama-embed@2..4`, в 12:13:26 — ещё один рестарт; он уже от агента инфрапанели
  (действие `service.restart` в 12:13:27, инцидент `INC-2026-11-14-032`
  «Ollama: порт 11434 закрыт, хотя сервис запущен», закрыт как «сервис поднят»).
- Живое состояние: `ollama.service` active since 12:13:26, `NRestarts=0`; слушают
  11434 (публичный), 11436 (журнал запросов), 11441 (полоса эмбеддингов),
  11500 (прокладка гашения размышлений); `POST /api/embed` моделью `bge-m3-embed`
  вернул 200 и вектор длиной 1024; `ollama-request-watch` и `ollama-shim` активны.
- Сторож `bge-gpu-watch` в тот же тик: `{"problems": [], "inconclusive": [],
  "loads_5m": 0, "loaded": false}`.

## Причина и повторяемость

`~/service-monitor/check.sh` тикает раз в минуту и снимает `systemctl --user is-active`
одним замером. Любой рестарт, попавший в щель между замерами, даёт пару
«УПАЛ»/«восстановлен» без поломки. По Ollama таких пар уже пять: 12.10, 21.10, 25.10,
05.11, 14.11.2026; по TaskFlow-серверу за 13.10–13.11 было 27.

## Готовая правка и что мешает

Правка сторожа лежит с 13.11.2026: `/home/maksim/infra-ops/patches/monitor-110-deploy-restart-20261113`
(`SETTLE_SECONDS`, по умолчанию 20 с; поднялся сам — тревоги нет, событие уходит в
`suppressed.log`). Применимость к текущему `check.sh` перепроверена 14.11:
`patch.py` отработал без конфликта, `bash -n` на результате чист, 37 изменённых строк.
Накатить роль не может: `touch` в `/home/maksim/service-monitor` → «Отказано в доступе»
(роль `tfrole`, группа `maksim` недоступна). Нужен запуск владельцем по README патча.

## Отдельно замечено, не чинил

Drop-in `ollama.service.d/request-logging.conf` задаёт `OLLAMA_HOST=127.0.0.1:11436`,
а юнит — `0.0.0.0:11434`; итоговое окружение процесса — `127.0.0.1:11436`, но 11434
всё равно слушается и отвечает 200. Расхождение стоит привести в порядок отдельной задачей.

## Чем проверялось

```
# журнал (у tfrole нет прав на journalctl напрямую — только через taskflow_inspect)
journalctl --user --since "2026-11-14 12:09" --until "2026-11-14 12:14" --no-pager | grep -E "Stopping|Stopped|Started|Consumed|Failed|Main process"
# применимость правки без записи в папку сторожа
python3 ~/infra-ops/patches/monitor-110-deploy-restart-20261113/patch.py \
  --check-sh /home/maksim/service-monitor/check.sh --out /tmp/check.sh.new && bash -n /tmp/check.sh.new
# живая проба эмбеддингов
curl -s -X POST http://127.0.0.1:11434/api/embed -d '{"model":"bge-m3-embed","input":"проверка"}'
```
