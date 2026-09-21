# Хэндофф — researcher (остаток), 21.09.2026

Отдельно от инфраструктурного хэндоффа: этот кусок — про роль `researcher` в TaskFlow.

## СТАТУС: конвейер сделан (21.09.2026, opencode)

Серверный конвейер исследования реализован и прогнан E2E. Дизайн —
`docs/superpowers/specs/2026-09-21-research-pipeline-design.md`.

- **Поле `needs_research`** (миграция `052_needs_research`) + галочка в карточке
  (веб `TaskDetailScreen`, iOS `TaskFormScreen`), бейдж в списках.
- **Запуск**: `POST /api/tasks/:id/research` (только владелец, задача помечена).
- **Конвейер**: `server/scripts/research_pipeline.py` — план → сбор (web_search /
  web_get / ocr / youtube / docs / kb) → проверка → синтез → `taskflow_report`.
  Шаги и повторы в коде; потолки `MAX_ROUNDS=3`, `MAX_SOURCES=10`. Модель — локальная
  Ollama; выход наружу через xray `127.0.0.1:10811`.
- **Проверено**: `test/researchFlag.test.ts` 5/5; E2E на `.110` (три карточки) —
  отчёты собраны, источников до 10.
- **Модели**: план и проверка — облачная `MiniMax-M3` (та же, что у роли: имя из
  `role-routing.yaml`, запись из стора Pi, ключ из `~/.pi/agent/auth.json`,
  `api.minimax.io/anthropic`), синтез — локальная `qwen3.6-27b`. Откат на
  локальную при недоступности облачной; имя модели видно в ленте задачи.

## Что ещё осталось

1. **Автозапуск по флагу** — сейчас только вручную кнопкой/эндпоинтом.
2. **Лимит источников** — 10; меняется переменными `RESEARCH_MAX_SOURCES` /
   `RESEARCH_MAX_ROUNDS`.
3. **E2E свободного захода агента** с новыми инструментами (не серверным конвейером,
   а живьём ролью `researcher`) — по-прежнему не делали.

Готовые инструменты роли (31 в allowlist): `taskflow_web_get`, `taskflow_web_search`
(Tavily→Brave), `taskflow_ocr`, `taskflow_youtube` (`player_client=web,mweb`), `taskflow_report`.
Прокси для них — `HTTPS_PROXY=http://127.0.0.1:10811` в профиле роли (и теперь — по
умолчанию в серверном конвейере).
