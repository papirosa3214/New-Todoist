# Канал тревог .110: почему молчал и что сделано (13.11.2026)

Карточка: `00fd313b-738f-40cc-9fee-915e4aba81de`, тревога infra-vpn-watch от 04:10.

## Что не работало

Тревоги .110 не доходили до Telegram. В журнале посредника
`~/.claude/alerts/relay-undelivered.log` — сплошные строки
`"status": "lost", "route": "proxy", "error": "нет ответа, curl вернул код 28"`:
619 неудачных отправок 11.11, 535 — 12.11, 88 — 13.11.

## Причина

Цепочка доставки: `скрипт → n8n → посредник tg-relay (:8099) → SOCKS xray-bots (192.168.1.110:10810) → api.telegram.org`.

xray-bots после перезапуска остался без override балансировщика `ru`, и наименьшая задержка
наблюдателя выбрала единственный сервер, который он тогда проверял, — `ru-nl`
(vless `ne2.yandex-maps-api.com:2055`). Этот сервер Telegram не пускает: TCP-соединение
проходит, а TLS-хендшейк рвётся. Остальные выходы в конфиге живые:
`ru-1` (`ru-api.cat-cat-cat.pro:8443`), `ru-2` (`5.230.135.136:443`), `ru-3` (`205.237.110.251:443`) —
через них Telegram отвечает.

Сторож выходов `xray-target-guard` этого не исправлял: в его карте
`~/.config/xray-guard.json` для xray-bots был ровно один тестовый вход — `probe-ru-nl` (10915).
Проверив только мёртвый сервер, он ставил `all_fail` и не переключался, хотя переключать было на что.

Второй пункт той же тревоги — «drop-in ссылается на http://127.0.0.1:10818, а xray-claude на
http://127.0.0.1:10813 — поправить» — оказался ложным. У xray-claude два входа: `10813`
(http-docker, для контейнеров) и `10818` (roles-http, для ролей). Drop-in
`taskflow-server.service.d/99-linear-xray.conf` ссылается на рабочий 10818; проверка в
`infra-vpn-watch.py` сравнивала номера портов вместо результата.

## Что сделано

1. Включён override балансировщика xray-bots на живой выход:
   `xray api bo --server=127.0.0.1:10919 -b ru ru-3`.
2. Канал проверен сквозной отправкой через боевой посредник:
   `POST http://127.0.0.1:8099/send {"text": ...}` → `ok:true`, message_id 5204, 5206, 5210.
3. В `~/infra-ops/infra-vpn-watch.py` сравнение портов заменено проверкой по существу
   (`_dropin_proxy_works`): при расхождении адресов проверяется, пускает ли drop-in'овский
   прокси в Linear и Telegram. Ветка `fix/vpn-watch-dropin-false-alarm`, коммит b6dfd62.
4. Подготовлена постоянная починка карты сторожа:
   `~/infra-ops/patches/xray-bots-guard-fix-20261113/fix.sh` (+ README.md) — добавляет входы
   `ru-1/ru-2/ru-3` в карту и прогоняет сторож, чтобы он сам выбирал живой выход.

## Что осталось владельцу

- `bash ~/infra-ops/patches/xray-bots-guard-fix-20261113/fix.sh` — от пользователя maksim,
  идемпотентно. Без этого следующий перезапуск xray-bots снова уведёт выход на `ru-nl`.
- Слить ветку `fix/vpn-watch-dropin-false-alarm` в main репозитория `~/infra-ops`:
  у сеанса роли нет ключа к gitea/github, пуш не прошёл.

## Как проверять дальше

- `curl -s -m 35 -X POST http://127.0.0.1:8099/send -H 'Content-Type: application/json' -d '{"text":"проверка"}'` → `ok:true`.
- `/opt/happ/bin/core/xray api bi --server=127.0.0.1:10919 ru` — в override живой тег.
- `tail -3 ~/.claude/alerts/relay-undelivered.log` — новых `lost` нет.
- Запасную дорогу (`~/kb/notify_monitor_bot.sh`, прокси 10816/10811) доказательством здоровья
  основного канала не считать: она работает независимо.
