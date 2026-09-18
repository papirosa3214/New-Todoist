# Pi Runtime Real Integration — спецификация (фаза 2)

> Продолжение спека [`2026-09-18-pi-runtime-facade.md`](./2026-09-18-pi-runtime-facade.md).
> Фаза 1: `PiRuntimeAdapter` собран как фасад над существующими источниками,
> `startRun()`/`connectProvider()` — заглушки. Фаза 2: фасад становится
> реальным — `startRun()` запускает Pi, `connectProvider()` идёт через Pi.

## Goal

Сделать `PiRuntimeAdapter` реально управляющим Pi:
- `startRun()` запускает Pi-сессию (та же логика, что сейчас в `trigger.py`).
- `getModels()` берёт список моделей из самого Pi (`pi --list-models`).
- `getProviders()`/`getAuthStatus()` берут статус из самого Pi (`pi auth check`).
- `connectProvider()` сохраняет credentials в `~/.pi/agent/auth.json` так,
  как их хранит сам Pi.
- `POST /api/runtime/providers/:provider/auth` вызывает `connectProvider()`,
  доступен только owner/service или api-токену со scope `runtime:auth`.
- В UI добавляются экраны «Провайдеры» и «Агенты».

`ClaudeCodeRuntime`, `CodexRuntime` не вводятся. Pi — единственный runtime.

## Принцип (Максим 18.09.2026)

**TaskFlow владеет AgentProfile и routing. Pi владеет runtime, sessions,
models и provider credentials.** Credentials не ходят через форму UI,
не логируются, не покидают машину, на которой работает Pi.

## Архитектурные решения (подтверждены Максим 18.09.2026)

### A. Где живёт запуск Pi

Сейчас запуск Pi размазан по `server/scripts/trigger.py` (L2280–2400):
формирование `cmd` через `make_cmd`, `subprocess.Popen` с цепочкой заходов,
env-переменные, MCP-профиль, skills.

**Решение.** Вынести запуск в общий launcher
`server/scripts/start_agent_run.py`. Контракт:
- вход — структурированный JSON через stdin,
- выход — JSON через stdout (статус, session_id, returncode, spent),
- **никакого `shell=True`** и **никакой строковой конкатенации команд** —
  только `argv`-массив, передаваемый в `Popen`,
- `cmd`/`env`/`Popen`/`session` — всё в одном файле, больше нигде.
- `trigger.py` импортирует `start_agent_run.start_agent_run()` напрямую
  и больше не знает про `subprocess.Popen`/`make_cmd`.
- `PiRuntimeAdapter.startRun()` вызывает его через `spawn python3
  server/scripts/start_agent_run.py`.
- Один путь запуска: одно место для багфиксов, одна точка тестирования.

### B. Источник моделей

**Решение.** `pi --list-models` — единственный источник правды. Парсим
вывод (TSV с шапкой provider/model/context/max-out/thinking/images).
Провайдер определяется по первому столбцу. Поле `available` идёт от
`pi auth check --provider X --json` (ready → true, иначе false). Кэш на
10 секунд, чтобы не дёргать `pi` на каждый запрос `/api/runtime/models`.

### C. Источник статуса провайдеров

**Решение.** `pi auth check --provider X --json`. Маппинг статусов:
- `ready` → `connected`
- `not_ready` (reason: `credentials_not_configured`) → `disconnected`
- `not_ready` (reason: `provider_not_found`) → не показывать провайдера
- `invalid` → `expired` (Pi не смог прочитать auth.json)

`providerStatusFromEnv()` из `PiRuntimeAdapter` удаляется — TaskFlow
больше не смотрит `TASKFLOW_*_TOKEN` из ENV.

### D. connectProvider()

Pi не имеет CLI-команды для запуска OAuth flow из headless.

**D.1. Для api_key провайдеров (сейчас только `minimax`):**
- Endpoint принимает `{apiKey: string}` в теле запроса.
- PiRuntimeAdapter пишет ключ в `~/.pi/agent/auth.json` через тот же
  путь, что использует `FileAuthStorageBackend` в Pi:
  - `proper-lockfile` для исключения гонки с самим Pi,
  - atomic write через `writeFileSync` во временный файл + `renameSync`
    (POSIX atomic rename),
  - `chmod 0o600` на файл (как делает `AUTH_FILE_WRITE_OPTIONS` в Pi),
  - credential **не логируется** ни в одном из слоёв (Node, Python, логи).
- Проверка после записи: повторный `pi auth check --provider X --json`
  → `ready`. Если нет — 502 с reason от Pi.

**D.2. Для OAuth провайдеров (anthropic, openai-codex):**
- Endpoint **не принимает токены** через UI. Никаких access/refresh.
- Возвращает:
  ```json
  {
    "status": "auth_required",
    "provider": "anthropic",
    "command": "pi --provider anthropic --model <любая доступная> \"ping\"",
    "note": "Запустите команду на машине с интерактивным Pi. Pi откроет OAuth-браузер, после успешного входа вернитесь сюда и нажмите «Переподключить»."
  }
  ```
- Владелец проходит OAuth в интерактивном режиме на своей машине,
  где у него работает `pi` в TUI. Pi сам сохраняет токены в свой
  `auth.json`. После возвращения в TaskFlow кнопка «Переподключить»
  перечитывает статус через `pi auth check --provider X --json`.
- `pi://auth/<provider>` НЕ делаем, пока нет зарегистрированного
  handler для такого deep link (Максим 18.09.2026).

### E. POST /api/runtime/providers/:provider/auth — авторизация

`authOrApiToken` стоит на всех runtime-endpoint'ах. Для connect нужно
жёстче: только owner/service **или API-токен со scope `runtime:auth`**
(Максим 18.09.2026). Обычный API-токен **не должен** автоматически
давать право менять авторизацию провайдеров.

**Решение.**
- Новый preHandler `ownerOrApiToken` в `server/src/auth.ts`:
  api-токен принимается **только при наличии scope `runtime:auth`** в
  его meta; user — только `role in (owner, service)`. Без scope —
  403 `runtime:auth scope required`.
- Использовать на POST `/api/runtime/providers/:provider/auth` И на
  PUT `/api/runtime/routing/:role`. Оба меняют состояние рантайма.
- GET остаётся на `authOrApiToken` (status читать может любой
  авторизованный — это диагностика, не запись).
- GET `/api/runtime/providers` в ответе отдаёт **только**:
  ```json
  {"provider": "...", "status": "...", "authType": "oauth|api_key|null"}
  ```
  Никаких токенов, refresh, access, expires, accountId, ключей —
  никаких credential details. Поля `lastCheckedAt`, `managedBy`,
  `runtime_id` остаются в TypeScript-фасаде `ProviderConnection`, но
  HTTP-ответ эндпоинта фильтрует только три публичных поля.

### F. Перевод provider_limit/fallback с shell-семантики на model-семантику

`nextModelForProfile()` уже добавлен (коммит d5c5c75e). Нужно:
1. Заменить вызовы `nextShellForRole()` в `agent-state.ts` (точка
   fallback при provider_limit) на `nextModelForProfile()`.
2. Удалить `nextShellForRole()` из `server/src/roleRouting.ts`.
3. `resolve_agent_for_role()` в `trigger.py` уже удалён (коммит
   c9004137). Проверить, что `handle_task` в trigger.py больше не
   выбирает «следующего исполнителя» — теперь выбор только по модели.

**Важно:** сам runtime не меняется (Pi единственный), меняется только
пара (model, provider) в `task.attempt_*` / agent_state.

### G. PUT /api/runtime/routing/:role — правила записи (переходный вариант)

Долгосрочно routing уедет в БД. До тех пор — YAML остаётся
bootstrap/default config. Правила записи (подтверждено Максим 18.09.2026):

- **schema validation:** `primary` — непустая строка; `fallbacks` —
  массив строк, может быть пустым. Несуществующая роль → 404.
- **Проверка моделей:** каждый `primary` и каждый элемент `fallbacks`
  обязан присутствовать в `pi --list-models` для соответствующего
  провайдера. Несуществующая модель → 422 `model_not_available`.
- **Уникальность:** `primary` не должен встречаться в `fallbacks`
  той же роли. Дубликаты внутри `fallbacks` тоже запрещены.
- **Атомарность записи:** файл блокируется (`proper-lockfile`), пишется
  во временный `role-routing.yaml.tmp` в той же директории, затем
  `renameSync` — атомарная замена (POSIX rename).
- **Чистая запись:** YAML переписывается без потери шапки-комментария,
  порядок секций сохраняется (`defaults`, `fallbacks`, `models`).
- **Инвалидация кэша:** после записи `loadRuntimeConfig()` должен
  перечитывать файл. Если используется кэш — сбросить через явный
  re-export / version marker.
- **Доступ:** preHandler `ownerOrApiToken` (owner/service ИЛИ api-токен
  со scope `runtime:auth`).
- **YAML остаётся bootstrap/default:** при переезде routing в БД YAML
  будет seed'ом для новых инсталляций.

### H. UI

Экраны добавляются в `src/screens/`:
- `ProvidersScreen.tsx` — список провайдеров, кнопки «Подключить» /
  «Переподключить». Для api_key — поле ввода ключа. Для OAuth — модалка
  с командой `pi --provider X --model Y "ping"`, без deep-link.
  При «Переподключить» статус перечитывается через `pi auth check`.
- `AgentsScreen.tsx` — выбор primary model + fallback models для
  каждой из 8 ролей. Источник моделей — `GET /api/runtime/models`.
  Сохранение через `PUT /api/runtime/routing/:role`.

DESIGN.md и UI-CHECKLIST.md перечитываются до правок.

### I. Как PiRuntimeAdapter.startRun() вызывает Python

**Решение.** `spawn('python3', ['server/scripts/start_agent_run.py', ...])`
с stdin=JSON, stdout=JSON. Изоляция, latency приемлема (запуск Pi и так
1–5 c). Альтернатива через HTTP endpoint отвергнута — лишний слой.

## Что входит

1. `server/scripts/start_agent_run.py` — общий launcher (JSON stdin/stdout).
2. `server/scripts/trigger.py` — `subprocess.Popen`/`make_cmd` удаляются,
   вызов через `start_agent_run`. Поведение сохраняется.
3. `server/src/runtime/PiRuntimeAdapter.ts`:
   - `startRun()` → `spawn python3 server/scripts/start_agent_run.py`,
     stdin=JSON с задачей.
   - `listModels()` → `pi --list-models` + кэш 10 c.
   - `listProviders()` → `pi auth check --provider X --json` для каждого.
   - `connectProvider(provider, body)` → запись api_key в auth.json под
     lockfile, для OAuth — возврат `{status: "auth_required", command}`.
4. `server/src/auth.ts` — `ownerOrApiToken` preHandler с поддержкой
   scope `runtime:auth` для api-токенов.
5. `server/src/routes/runtime.ts`:
   - POST `/providers/:provider/auth` на `ownerOrApiToken` → `connectProvider`.
   - PUT `/routing/:role` на `ownerOrApiToken` → запись routing.
   - GET `/providers` фильтрует credential details (только `provider`,
     `status`, `authType`).
6. `server/src/roleRouting.ts` — удалить `nextShellForRole()`.
7. `server/src/routes/agent-state.ts` — перевести fallback на
   `nextModelForProfile()`.
8. `src/screens/ProvidersScreen.tsx` + `src/screens/AgentsScreen.tsx`.
9. Роутинг в `src/App.tsx`, новые пункты меню.
10. Тесты vitest + pytest + проверка UI в браузере.

## Что не входит

1. Миграция БД. Источники правды те же: `~/.pi/agent/*`,
   `role-routing.yaml`, `tasks.agent_*`.
2. ClaudeCodeRuntime / CodexRuntime.
3. Фоновая автозагрузка auth.json в TaskFlow — мы только пишем/читаем
   через тот же lockfile, что и Pi.
4. Автоматический OAuth без участия владельца.
5. Полный редизайн UI — только два новых экрана.
6. Изменение публичного контракта `/api/roles` — UI его читает.
7. Перенос routing в БД — это отдельная карточка позже.

## Риски

| Риск | Снятие |
| --- | --- |
| Lock на auth.json: Pi и TaskFlow пишут одновременно | `proper-lockfile` + atomic rename, как у Pi |
| Старт через spawn медленнее, чем trigger.py inline | Один spawn — приемлемо |
| UI не может вызвать OAuth flow | Endpoint для OAuth возвращает команду, owner идёт к себе |
| `nextModelForProfile` даёт другую модель | Тесты на routing фиксируют поведение |
| Кэш `pi --list-models` отстаёт на 10 c | `connectProvider` инвалидирует кэш принудительно |
| Credential утекает в логи | В Python — `log(f"...provider={name}, key=***")`. В Node — credential не передаётся в логгер вообще |

## Глобальные ограничения

- Только ветка `main`.
- Каждый subtask — отдельный коммит.
- `trigger.py` не переписывается; `subprocess.Popen`/`make_cmd` выносятся в
  `server/scripts/start_agent_run.py` (JSON stdin/stdout, без shell=True).
- Контракт `/api/roles` неизменен.
- vitest и pytest зелёные после каждого subtask.
- Реальный OAuth — на машине владельца через интерактивный `pi`.
- **TaskFlow владеет AgentProfile и routing. Pi владеет runtime, sessions,
  models и provider credentials.**
