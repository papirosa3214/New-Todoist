# Linear: отправка статусов не проходит (403) — разбор и проверка

Дата: 14.10.2026. Карточка: «Linear: отправка статусов не проходит».
Правка в коде: `f954c585` (`server/src/runtime/linearWrite.ts`).

## Симптом

Карточка от `notifyLinearSyncStale` (`src/lib/linearSync.ts`): статусы не уходят
в Linear дольше 30 минут, последняя ошибка — «Linear отклонил запрос (403)».
Очередь `linear_sync_queue` копилась, каждое задание повторялось раз в минуту:
к моменту разбора 300, 201 и 130 попыток, самое раннее задание — с 08.10.
Карточки TaskFlow при этом работают, юниты зелёные: ломается только дорожка записи.

## Причина

Linear отвечает 403 «Linear is not available in Russia» на запросы, идущие
напрямую с российского адреса. Проверено вживую с .110:

- без прокси — и выдача OAuth-токена, и GraphQL-запись дают этот отказ;
- через `http://127.0.0.1:10813` (xray-claude, drop-in
  `taskflow-server.service.d/99-linear-xray.conf`) — токен выдаётся, ответ 200.

Сервер ходит в Linear через прокси по переменным окружения
(`HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`, оба в drop-in), но перехват глобального
fetch агентным SDK перебивает `NODE_USE_ENV_PROXY`, и запрос уходил напрямую.
Второй след: в сообщение об ошибке попадал только код 403, без текста отказа —
из-за этого неделю нельзя было отличить гео-блок от прав доступа.

## Что сделано

`f954c585`: в `runtime/linearWrite.ts` диспетчер `EnvHttpProxyAgent` создаётся
из переменных окружения и передаётся явно в каждый запрос (тот же приём, что
в `routes/widgets.ts`), а в текст ошибки добавляется причина отказа.

Выкладка на .110: сервер работает из `dist`, поэтому после вливания нужна
сборка `tsc -p tsconfig.json` и перезапуск `taskflow-server`
(`taskflow-deploy-idle.service` делает это в простое). После перезапуска очередь
ушла в первый же проход.

Читающий путь Linear (`runtime/linearTransport.ts` → Composio) от локального
прокси не зависит и не ломался.

## Проверка

```
sqlite3 -readonly taskflow.db \
  "SELECT status, attempts, last_error FROM linear_sync_queue; \
   SELECT last_success_at, sent_total, failed_total, last_error FROM linear_sync_state;"
```

Ожидаемо: очередь пуста, `failed_total = 0`, `last_error` пуст, `last_success_at`
обновляется раз в минуту. В Linear привязанный тикет получает нужное состояние,
а его метка `updatedAt` совпадает с моментом отправки (проверено на MAK-95:
16:36:21 МСК).

Живая проверка дорожки без вывода токена:

```
env -u HTTPS_PROXY -u https_proxy -u NODE_USE_ENV_PROXY ... \
  vault-run.py --secret LINEAR_CLIENT_ID=... --secret LINEAR_CLIENT_SECRET=... \
  -- node scripts/linear_oauth.mjs          # → 403 «not available in Russia»

HTTPS_PROXY=http://127.0.0.1:10813 NODE_USE_ENV_PROXY=1 ... тот же вызов   # → токен
```

## Грабли и смежное

- `NODE_USE_ENV_PROXY=1` в окружении юнита не гарантия: глобальный перехват
  fetch в процессе сервера его перебивает. Для внешних API прокси надо передавать
  в самом запросе.
- `linear_sync_state.last_success_at` и метки очереди пишутся в **UTC**
  (`nowIso = toISOString`). Любая проверка «свежести» обязана сравнивать с UTC,
  иначе выходит +3 часа.
- Сторож `~/infra-ops/infra-vpn-watch.py`: 13.10 23:37 и 14.10 13:44 прислал
  «прокси мёртв», хотя xray-claude не перезапускался с 13.10 19:50 — одна проба
  выходного IP не уложилась в 5 секунд под нагрузкой. Правки `d2a73a7`
  (одна неудача — ещё одна попытка) и `8960ea0` (включена проверка «синхронизация
  Linear не проходит N мин», молчит при выключенной отправке и незапущенном
  сервере; исправлен UTC/local) — репозиторий `~/infra-ops`, ветка main.

## Кому и что делать при повторе

Инженер .110. Порядок: `systemctl --user show taskflow-server -p MainPID`, затем
`tr '\0' '\n' < /proc/<PID>/environ | grep -i proxy`; `ss -ltn | grep 10813`;
очередь и ошибки — в `linear_sync_queue` / `linear_sync_state`; сторож —
`systemctl --user start infra-vpn-watch.service`. Если 403 вернулся, сначала
проверить, не уехал ли выходной адрес xray под гео-блок.