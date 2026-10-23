# Доработка 1 — повторная живая проверка после ревью критика

Карточка 38ca01ac-c71d-45d0-bd91-5bacb82101d3, шаг builder_fix_8f38bbe2.
Дата прогона: 23.10.2026. Ширина экрана 420, настоящий клик мышью (`page.mouse.click`).

## Что проверялось

1. Клик мышью по дню в календаре срока выбирает дату (было: «Не установлен»).
2. `/upcoming` и `/today` на ширине 420 открываются без экрана ошибки.

## Где

| Файл | Что |
|---|---|
| `live-chromium.json` + `live-chromium-*.png` | живой сервер https://192.168.1.110:5180, Chromium |
| `live-webkit.json` + `live-webkit-*.png` | живой сервер, WebKit |
| `copy-chromium.json`, `copy-webkit.json` + кадры | копия приложения (WEB http://127.0.0.1:4104, API 4103, состояние `~/.local/state/taskflow-qa/ab712354`) |
| `prefix-chromium.json` + `prefix-chromium-due.png` | контроль чувствительности: веб-клиент на коде ДО правки (main 6c3a6011) — клик мышью дату не выбирает, тест падает |

## Итог

- Живой :5180: Chromium — пройдено, WebKit — пройдено.
- Копия: Chromium — пройдено, WebKit — пройдено.
- Код до правки: клик мышью по дню НЕ выбирает дату (тест ловит дефект).

Скрипт прогона: `qa-live-check.mjs` в корне ветки (node qa-live-check.mjs --base <адрес> --engine chromium|webkit).
