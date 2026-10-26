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
