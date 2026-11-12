# Wealthfolio MCP для Помощника владельца

Дата: 08.11.2026. Решение владельца: подключить напрямую (не через шлюз мака), запись в «Интеграциях» рядом с Things 3.

## Цель
Помощник владельца (`secretary` / `u-secretary`) видит и меняет данные финансового трекера: счета, позиции, расходы, бюджеты, категории, и записывает операции. В приложении TaskFlow рядом с Things 3 есть карточка «Wealthfolio» со статусом.

## Не входит
- Реестр MCP-серверов с редактированием адреса и токена из UI.
- Доступ для других ролей.
- Выход в интернет: соединение только по loopback на .110.

## Как устроено сейчас (проверено)
- `server/src/runtime/graftMcp.ts:184` — `connectRoleMcp(role, cwd)`, единственная точка сборки внешних MCP на роль: `connectInfraPanel` (только `infra_engineer`) + `connectGraft`. Вызывается из `inProcessRun.ts:1565`, `PiRuntimeAdapter.ts:1591`, `taskDiscussionSession.ts:106`, `secretaryVoiceTools.ts:129`, `slotConversation.ts`.
- `server/src/runtime/infraPanelMcp.ts` — образец: 20 с на подключение, префикс `mcp__infra__`, сбой одного сервера не лишает роль другого.
- `server/src/runtime/nativeToolLoader.ts` — загрузчик по требованию: инструмент `taskflow_tools`, `createToolLoader({operations, onActivated})`; в каждый запрос уходит только ядро.
- `server/src/runtime/roleToolCatalog.ts:70` — `ON_DEMAND_PREFIXES = ["todoist_", "mcp__composio__", "things_"]`; `staysActive = CORE_OPERATIONS.has(name) || !isOnDemandOperation(name)` (строка 73). То есть по требованию грузится ровно то, чей префикс в списке, остальное висит в каждом запросе.
- Wealthfolio MCP: `http://127.0.0.1:8095/mcp` на том же .110 (контейнер публикует `127.0.0.1:8095`), сервер TaskFlow — node v22 из `~/Проекты/New-Todoist/server` на порту 3001 на хосте, до loopback достаёт. Инструментов 65 (get_accounts, get_holdings, search_activities, record_activity, commit_activity_draft, get_spending_report, commit_categorization_rule, …).
- Токен: хранилище `~/.claude`, ключ `wealthfolio_mcp_token` (13 скоупов, включая запись). Образец чтения секрета из vault — `server/src/runtime/composioPolicy.ts:37-56` (`TASKFLOW_COMPOSIO_VAULT_RUN` + `vault-run.py`).
- TLS не нужен: по loopback открытый HTTP. Проверено, что Node на .110 mkcert-CA не знает (`fetch("https://finance.lan/api/v1/auth/status")` → `fetch failed`), поэтому HTTPS-путь потребовал бы отдельной возни с сертификатом.
- Хост-заголовок: у контейнера `WF_MCP_ALLOWED_HOSTS="finance.lan,192.168.1.110:8443"`; нужно добавить `127.0.0.1:8095`, иначе сервер ответит `403 Forbidden: Host header is not allowed`.

## Решение
1. Новый модуль `server/src/runtime/wealthfolioMcp.ts` по образцу `infraPanelMcp.ts`:
   - `connectWealthfolio(role)`, только `role === "secretary"`;
   - транспорт StreamableHTTP, адрес из `TASKFLOW_WEALTHFOLIO_MCP_URL` (по умолчанию `http://127.0.0.1:8095/mcp`), токен из vault через `vault-run.py` (кэш в памяти процесса, не в логах);
   - имена инструментов `wealthfolio_<tool>`, таймаут подключения 20 с, вызова 120 с;
   - сбой подключения логируется одной строкой и не ломает ход роли.
2. `graftMcp.ts:184` — третий член в `Promise.all`, изоляция сбоя как у соседей.
3. По требованию: `"wealthfolio_"` добавляется в `ON_DEMAND_PREFIXES` (`roleToolCatalog.ts:70`). В каждый запрос 65 схем не уходят; роль подключает нужные через `taskflow_tools`. На старте не активируется ничего.
4. Приложение: `GET /api/integrations/wealthfolio` → `{connected, url, toolCount, error}` с живым пингом и кэшем 60 с, в `server/src/routes/integrations.ts`. В iOS — `ExternalAppAccessStore` (`Sources/Features/Settings/ExternalAppAccessSection.swift`) плюс карточка в `Sources/Features/Settings/IntegrationsScreen.swift` рядом с Things 3 (образец строки 509–520): «Подключено · 65 инструментов», раскрытие показывает возможности из серверного каталога роли.

## Риски и как закрыты
- **Запись денег.** Токен даёт `record_activity` и `commit_*`. Каждый вызов виден в аудите Wealthfolio (`/api/v1/agent-access/audit`) и в `role_tool_audit` TaskFlow.
- **Секрет в коде.** Адрес в env, токен только в хранилище.
- **Объём контекста.** 65 инструментов идут только по требованию.
- **Прокси на .110.** Как в `composioPolicy.ts:47` — `NODE_USE_ENV_PROXY: "0"`.
- **Права ролей.** Гейт по роли в модуле плюс существующий `roleToolAllowed`.

## Проверка
- unit `server/src/runtime/wealthfolioMcp.test.ts`: префикс имён, отказ другим ролям, изоляция сбоя (фейковый MCP).
- живой смок: роль `secretary` через `taskflow_tools` вызывает `get_accounts` и `get_net_worth`, получает данные; в Wealthfolio появляется запись в аудите.
- iOS: сборка, скриншот «Интеграций» с карточкой; при остановленном контейнере карточка честно показывает «Не подключено».
- регресс: `tsc` сервера, целевые тесты runtime.

## Оценка
Сервер — половина дня, iOS — половина дня.
