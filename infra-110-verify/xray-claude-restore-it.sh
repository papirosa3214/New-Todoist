#!/bin/sh
# Сторож выхода xray-claude (Инженер .110, .110).
# Проблема: outbound restore-happ смотрит на несуществующий SOCKS 127.0.0.1:10808,
# балансировщик healthy-egress выбирает только его — прокси 10811/10813/10818 рвут TLS.
# Лечение (без правки конфига maksim): override балансировщика на живой outbound restore-it
# через API xray (127.0.0.1:10909). Override живёт до перезапуска xray — сторож возвращает его.
LOG=/home/tfrole/infra/xray-claude-restore-it.log
XRAY=/opt/happ/bin/core/xray
API=127.0.0.1:10909
BAL=healthy-egress

say() { echo "$(date '+%F %T') $*" >>"$LOG"; }

code() { curl -sS -m 8 -x "http://127.0.0.1:$1" -o /dev/null -w '%{http_code}' https://linear.app 2>/dev/null; }

say "проверка: happ=$(code 10904) it=$(code 10901)"
happ=$(code 10904)   # restore-happ
it=$(code 10901)     # restore-it

if [ "$happ" = "200" ]; then
  # основной выход снова живой (happ-туннель подняли) — не вмешиваемся
  exit 0
fi
if [ "$it" != "200" ]; then
  say "оба выхода мертвы (happ=$happ it=$it) — переключать не на что"
  exit 1
fi
cur=$($XRAY api bi -s "$API" "$BAL" 2>/dev/null | sed -n 's/.*restore-\([a-z0-9-]*\).*/restore-\1/p' | head -1)
if [ "$cur" = "restore-it" ]; then
  exit 0
fi
if $XRAY api bo -s "$API" -b "$BAL" restore-it >/dev/null 2>&1; then
  say "переключил балансировщик $BAL на restore-it (было: ${cur:-пусто})"
else
  say "не смог переключить $BAL на restore-it"
  exit 1
fi
