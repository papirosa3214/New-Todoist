# Внешние агенты по ACP — 26.10.2026

Шаг 1 плана «сторонние агенты через ACP, iPhone как приёмник». Образец — Traycer: один хост, свой адаптер на каждого агента, агенты, которые умеют ACP, подключаются по ACP.

## Что сделано

- `server/src/runtime/acpAgentSession.ts` — сессия внешнего агента по ACP на официальном SDK `@agentclientprotocol/sdk` 2.0.2 (v1, stdio). Поверхность та же, что у Claude Code и Pi (`subscribe/prompt/steer/abort/dispose/state.messages`), поэтому чат, шаги плана, живой ход и сторож тишины работают без переделок.
  - Один процесс и одна ACP-сессия на разговор. Инструкция TaskFlow уходит в первом сообщении: системного промпта в ACP нет.
  - События ACP переводятся в события Pi: мысль, текст, начало и конец инструмента.
  - Разрешения выдаются сразу, как `bypassPermissions` у Claude Code: в фоне спросить некого.
  - Уточнение посреди хода (`steer`) уходит следующим ходом той же сессии: в ACP нет ввода посреди хода.
  - `abort` отправляет `session/cancel`.
  - Расход хода не показывается: ACP v1 отдаёт только заполнение контекста, а токены и цену не отдаёт.
  - MCP-серверы передаются при создании сессии (`mcpServers`). Использование MCP — шаг 2.
- `server/src/runtime/externalAgentSession.ts` — выбор адаптера по каталогу: Claude Code — `stream-json` (по подписке), остальные — ACP.
- `server/src/lib/externalAgents.ts` — Gemini CLI (`--acp`) и Hermes (`acp`) получили адаптер, добавлен OpenCode (`acp`). Codex остаётся без адаптера.
- `server/scripts/acp-probe.mjs` — проба агента: `node scripts/acp-probe.mjs hermes acp`.

## Проверено

| Что | Итог |
|---|---|
| `test/acpAgentSession.test.ts` на поддельном ACP-агенте | 5/5 |
| Живой Hermes через `createExternalAgentSession` | ответ «4», затем «12»: контекст держится |
| Проба Hermes | протокол 1, `end_turn`, мысли и текст |
| Проба Gemini CLI | **не залогинен**: «Failed to authenticate with user code» |
| Проба OpenCode | протокол работает, но модель по умолчанию из `~/.config/opencode/opencode.json` (`ollama/qwen2.5-14b-credit-risk`) отсутствует в Ollama |

## Что дальше

- Шаг 2: агент работает с доской через MCP `taskflow`, а не текстовым блоком `taskflow-actions`.
- Gemini — вход владельцем (`gemini`, вход Google). OpenCode — выбрать существующую модель в его конфиге.
- Участники появятся в «Команде» после «Найти агентов» (`syncExternalAgents`).

## Шаг 2: один набор действий через MCP (26.10.2026)

Было: сервер разрешал внешнему агенту около 90 операций, но отдавал их только текстом. Агент писал блок `taskflow-actions`, сервер его разбирал. Параллельно у Claude Code был свой глобальный MCP `taskflow` из 35 инструментов: без ответа в теме, без чата, без плана.

Стало:
- `server/src/runtime/runToolRegistry.ts` — реестр «запуск → разрешённые операции → участник».
- `server/src/routes/run-tools.ts` — `GET /api/runs/:runId/tools` и `POST /api/runs/:runId/tools/:name`, только по пропуску участника своего запуска (чужой запуск — 404).
- `server/scripts/run-mcp-bridge.mjs` — stdio MCP-сервер `taskflow_run`, пересылает `tools/list` и `tools/call` на сервер. Именно stdio: Hermes не умеет MCP по HTTP.
- `externalAgentSession.ts` регистрирует операции запуска и подключает мост: ACP-агентам — в `session/new`, Claude Code — через `--mcp-config`. При `dispose` регистрация снимается.
- Разбор `taskflow-actions` удалён. Инструкция агенту — без `CLAUDE.md` и без «если подключён свой MCP».

Проверено: `runTools.test.ts` 2/2 (маршрут, чужой запуск, stdio-мост). Вживую на отдельном экземпляре сервера: **Hermes и Claude Code сами вызвали `taskflow_subtask_done` через `taskflow_run`**, сервер получил аргументы. Полный прогон — без новых падений относительно main: тест про Chromium падает из-за окружения временной копии, `chats-common-lifecycle` плавает и на main.
