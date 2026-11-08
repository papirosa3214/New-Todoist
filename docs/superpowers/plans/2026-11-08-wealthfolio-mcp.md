# Wealthfolio MCP для Помощника владельца — план

> **For agentic workers:** исполнять по шагам, каждый шаг с проверкой.

**Goal:** роль `secretary` получает 65 инструментов MCP-сервера Wealthfolio по требованию; в iOS-приложении появляется карточка «Wealthfolio» рядом с Things 3.

**Architecture:** новый модуль `server/src/runtime/wealthfolioMcp.ts` по образцу `infraPanelMcp.ts` (StreamableHTTP на `http://127.0.0.1:8095/mcp`, токен из хранилища), третий член в `connectRoleMcp`, префикс `wealthfolio_` в `ON_DEMAND_PREFIXES` — инструменты грузятся через `taskflow_tools`. Статус отдаёт `GET /api/integrations/wealthfolio`, карточку рисует `IntegrationsScreen.swift`.

**Tech Stack:** Node 22, TypeScript, vitest, `@modelcontextprotocol/sdk` 1.31.0 (`StreamableHTTPClientTransport`), SwiftUI, ASP.NET-нет — сервер Express-подобный на TS.

**Spec:** `docs/2026-11-08-wealthfolio-mcp-integration.md`

## Global Constraints
- Доступ только роли `secretary`; остальные роли не видят ни одного инструмента.
- Токен и адрес не в коде: адрес из `TASKFLOW_WEALTHFOLIO_MCP_URL` (по умолчанию `http://127.0.0.1:8095/mcp`), токен из `~/.claude` (ключ `wealthfolio_mcp_token`) через `vault-run.py`.
- Сбой подключения не ломает ход роли: логируется одной строкой, роль продолжает без инструментов.
- Токен и его значение не попадают в логи и в ответы API.
- Стиль: как в `infraPanelMcp.ts` и `composioPolicy.ts`; комментарии по-русски, объясняют «почему».

## Задача 1. Доступ по loopback
- [ ] В `~/wealthfolio/docker-compose.yml` добавить `127.0.0.1:8095` в `WF_MCP_ALLOWED_HOSTS`, пересоздать контейнер.
- [ ] Проверка: `curl -H "Host: 127.0.0.1:8095" http://127.0.0.1:8095/mcp` без токена → 401 (не 403).

## Задача 2. Модуль `wealthfolioMcp.ts`
- [ ] Тест `server/src/runtime/wealthfolioMcp.test.ts`: (а) роль не `secretary` → пустой набор и `close` без ошибок; (б) имена начинаются с `wealthfolio_`; (в) ошибка транспорта → пустой набор, без исключения наружу.
- [ ] Прогнать тест — падает (модуля нет).
- [ ] Реализовать `connectWealthfolio(role)`: `Client` + `StreamableHTTPClientTransport`, токен через `vault-run.py`/`vault-get.py` с кэшем, таймаут подключения 20 с, вызова 120 с, `Type.Unsafe(t.inputSchema)` как в `infraPanelMcp.ts`, `details.source = "wealthfolio"`.
- [ ] Тест проходит.
- [ ] Подключить в `server/src/runtime/graftMcp.ts:184` (`connectRoleMcp`) третьим членом с `.catch(...)`, как соседи.
- [ ] `npx tsc --noEmit` в `server` — чисто.

## Задача 3. Инструменты по требованию
- [ ] В `server/src/runtime/roleToolCatalog.ts:70` добавить `"wealthfolio_"` в `ON_DEMAND_PREFIXES`.
- [ ] Тест: `isOnDemandOperation`/`staysActive` не экспортированы — проверить через существующий тест каталога, если он есть; иначе unit на локальную копию правила не писать, а проверить живьём в задаче 6 (в запросе не должно быть 65 схем).
- [ ] `npx tsc --noEmit` — чисто.

## Задача 4. Статус-эндпоинт
- [ ] `GET /api/integrations/wealthfolio` в `server/src/routes/integrations.ts`: `{connected, url, toolCount, error}`, живой пинг через `connectWealthfolio`, кэш 60 с, без токена в ответе.
- [ ] Тест на форму ответа и на кэш.
- [ ] Проверка: `curl -b <cookie> http://127.0.0.1:3001/api/integrations/wealthfolio` → `connected: true`, `toolCount: 65`.

## Задача 5. Карточка в iOS
- [ ] `ExternalAppAccessStore` (`Sources/Features/Settings/ExternalAppAccessSection.swift`): поля `wealthfolioStatus`, `wealthfolioDetail`, `wealthfolioToolCount`, загрузка из нового эндпоинта.
- [ ] Карточка в `Sources/Features/Settings/IntegrationsScreen.swift` рядом с Things 3 (образец строк 509–520), раскрытие — список возможностей из серверного каталога роли.
- [ ] Сборка: `xcodebuild -scheme TaskFlow -destination 'generic/platform=iOS Simulator' build` — без ошибок.

## Задача 6. Выкладка и живой смок
- [ ] `npm run build` в `~/Проекты/New-Todoist/server`, `systemctl --user restart taskflow-server`, дождаться 3001.
- [ ] Скрипт-смок: `connectWealthfolio("secretary")` → `listTools` = 65, вызов `get_accounts` возвращает данные; `connectWealthfolio("infra_engineer")` → 0.
- [ ] В Wealthfolio `GET /api/v1/agent-access/audit` содержит вызов `get_accounts` этим токеном.
- [ ] Перезапуск контейнера Wealthfolio → эндпоинт статуса отдаёт `connected: false` с причиной, сервер не падает.
