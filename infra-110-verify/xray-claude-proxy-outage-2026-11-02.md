# xray-claude: ролевые прокси 10811/10813 рвали TLS (02.11.2026)

**Машина:** .110 (maksim-MS-7D27)
**Карточка:** f044ef1a-4054-482f-8c93-4ef20eb33b7f, шаг work_1 (Инженер .110)
**Симптом:** `curl -x http://127.0.0.1:10811 https://linear.app` → `000`, «Recv failure» сразу после `CONNECT 200`. То же на 10813, 10812, 10818 (ролевые входы). `curl --noproxy '*' https://linear.app` → 200: сеть и машина живы.

## Причина (подтверждена замерами)

1. **Мёртвый outbound.** `restore-happ` в `~/.config/xray-claude/config.json` → SOCKS `127.0.0.1:10808`. Слушателя на 10808 нет (старый прокси happ удалён; VPN теперь на 1080/10820). Probe-вход 10904 → 000.
2. **Балансировщик без живых выходов.** `healthy-egress` имеет `selector: ["restore-happ"]`. Последнее правило routing (`balancerTag: healthy-egress`, catch-all) уводит ВЕСЬ трафик входов 10811/10813/10818 в мёртвый outbound — отсюда мгновенный обрыв TLS после успешного CONNECT (xray отвечает 200 на CONNECT до dial'а апстрима).
3. **Живой выход был вне балансировщика.** `restore-it` (205.237.110.251:443, VLESS/TLS) — probe 10901 → 200 на linear.app, api.anthropic.com → 401 (соединение установлено). В selector не входил.
4. **Сторож помочь не мог.** `xray-target-guard` (раз в 5 мин, под maksim) в `~/.config/xray-guard.json` знает для инстанса `claude` только probe `restore-happ:10904` → «all_fail» → override не выставляется (`~/.config/xray-guard.state.json`, 02.11 03:37).

## Лечение (без правки конфига, роль работает под `tfrole`)

```bash
/opt/happ/bin/core/xray api bo -s 127.0.0.1:10909 -b healthy-egress restore-it
/opt/happ/bin/core/xray api bi -s 127.0.0.1:10909 healthy-egress   # в "Selecting Override" должен быть restore-it
```

Перезапуск xray сбрасывает override → поставлен сторож `xray-claude-restore-it.sh` (cron пользователя `tfrole`, раз в минуту): если `restore-happ` мёртв, а `restore-it` жив, override возвращается сам. Установленная копия: `/home/tfrole/infra/xray-claude-restore-it.sh`, лог `/home/tfrole/infra/xray-claude-restore-it.log`.

## Проверки (после переключения)

- 10811 → 200, 10813 → 200 (критерий приёмки), 10812 → 200, 10818 → 200, SOCKS 10819 → 200.
- `api.linear.app/graphql` через 10813 → 400 (запрос дошёл до API, нужен корректный body), opencode.ai через 10813 → 200, api.telegram.org через 10811 → 302.

## Постоянная правка (нужны права `maksim`)

1. `~/.config/xray-claude/config.json`: адрес outbound `restore-happ` → `127.0.0.1:1080` (проверен, отдаёт 200) либо добавить `restore-it` в `selector` балансировщика `healthy-egress`.
2. `~/.config/xray-guard.json`: инстансу `claude` добавить probe `restore-it: 10901`.
3. Перезапустить `xray-claude.service` (под maksim).

## Смежное (вне шага work_1)

Тот же мёртвый `10808` в `~/.config/xray-bots/config.json` (инстанс bots, балансировщик `ru`, probe `ru-happ:10914` → 000) — лечится так же.

## Грабли

- `CONNECT 200` от xray не значит, что апстрим жив: CONNECT отдаётся до dial'а, TLS рвётся следом.
- Балансировщик с одним селектором — тихий отказ всей ролевой сети: catch-all правило уводит всё в один outbound.
- `xray api bi` на этом xray показывает «Selects» пустым — смотреть надо на «Selecting Override».
