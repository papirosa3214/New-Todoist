# Pi Runtime Facade — спецификация

> **For agentic workers:** это спек, не план. За планом — `docs/superpowers/plans/2026-09-18-pi-runtime-facade.md`.

## Goal

Pi становится **единым runtime** для всех 8 ролей TaskFlow. TaskFlow знает агентов (AgentProfile), задачи, оркестрацию и историю запусков. Pi знает сессии, инструменты, модели и авторизацию провайдеров. На этом шаге — без миграции БД, фасадом поверх существующих источников правды.

## Architecture

```
TaskFlow
  ↓
Orchestrator (server/src/routes/dispatch.ts)
  ↓
AgentProfile  ← фасад (role + prompt + skills + tools + modelPolicy)
  ↓
Runtime = "pi"  ← единственный, жёстко зашит
  ↓
Model  ← из role-routing.yaml:models
  ↓
Provider/Auth  ← ключи в Pi/vault
```

Pi больше **не считается отдельным агентом** в TaskFlow. `assignee_id` всегда указывает на ролевую учётку `role_*`, не на Pi.

## Tech Stack

- Backend: TypeScript (Node 22, Fastify) в `server/src/`, Python 3 в `server/scripts/`.
- БД: SQLite (без миграций в этой карточке).
- Конфиг ролей: `server/scripts/role-routing.yaml`.
- Тесты: vitest (`server/test/*.test.ts`), pytest (`server/scripts/test_*.py`).

## Решение по объёму (Максим, 18.09.2026)

**Фасад без миграции БД.** Не заводим таблицы `agent_profiles`, `runtimes`, `models`, `provider_connections`, `agent_runs`. Источники правды:

| Сущность       | Источник правды                                          |
| -------------- | -------------------------------------------------------- |
| AgentProfile   | users (role) + role-prompts/ + role_skills + role-routing.yaml |
| Runtime        | константа `RUNTIME_ID = "pi"` + systemd-юнит `taskflow-trigger.service` |
| ProviderConnection | `vault-run.py` + systemd drop-in (ключи) + MCP-сервер Pi |
| Model          | `role-routing.yaml:models.<role>`                        |
| AgentRun       | tasks.attempt_* + agent_state + activity_log (расширение, без новой таблицы) |

Новые имена — это **API-фасад и терминология в коде**, не новое хранилище. Дублирование `role_skills`, `attempt_policies`, `users.prompt` запрещено.

## Сущности (TypeScript-фасад в `server/src/runtime/`)

### Runtime

```ts
export type RuntimeKind = "pi";           // расширяемо: позже возможны ещё
export type RuntimeId   = `runtime:${RuntimeKind}`;

export interface Runtime {
  id: RuntimeId;                          // "runtime:pi"
  kind: RuntimeKind;                      // "pi"
  status: "ready" | "starting" | "down";
  version: string;                        // semver Pi
  endpoint: string;                       // путь к CLI или HTTP
}
```

В текущей версии `Runtime.kind === "pi"` всегда. Это **жёсткое ограничение** первого этапа: Claude Code / Codex CLI как отдельный runtime не вводятся (причина — свои агенты-обёрчки, см. исходное ТЗ, п. 7).

### AgentProfile

```ts
export interface AgentProfile {
  id: string;                             // = role_name, напр. "architect"
  role: RoleName;                         // из ROLE_NAMES
  title: string;                          // человеческое имя из users.name
  account_id: string;                     // id ролевой учётки (role_architect)
  runtime_id: RuntimeId;                  // всегда "runtime:pi"
  prompt: { source: string; size: number };
  skills: Array<{ name: string; description: string | null }>;
  tools: string[];                        // из MCP-профиля Pi
  permissions: string | null;             // из users.permissions
  modelPolicy: {
    primary: string;                      // из role-routing.yaml:models[role]
    fallbacks: string[];                  // из role-routing.yaml:fallbacks[role]
  };
  status: "ready" | "working" | "blocked" | "unavailable";
}
```

`runtime_id` в каждом профиле фиксированный. Это позволяет будущим профилям указывать на разные runtime, не меняя форму.

### Model

```ts
export interface Model {
  id: string;                             // "claude-sonnet-4-6"
  provider: ProviderId;                   // "anthropic"
  runtime_id: RuntimeId;                  // "runtime:pi"
  /** Доступна ли Pi: реальный статус приходит из MCP Pi, не из TaskFlow. */
  available: boolean;
}
```

Список моделей на первом этапе **жёстко зашит** (тот же набор, что в `role-routing.yaml:models`). Динамический список — когда у Pi появится queryable API моделей.

### ProviderConnection

```ts
export interface ProviderConnection {
  id: ProviderId;                         // "anthropic" | "openai" | "minimax"
  runtime_id: RuntimeId;                  // "runtime:pi" (managedBy = runtime)
  status: "connected" | "disconnected" | "expired";
  /** Реальные ключи — в Pi/vault, TaskFlow их НЕ хранит. */
  managedBy: "pi";
  lastCheckedAt: string | null;
}
```

Реальный OAuth — когда у Pi появится `connectProvider(name)` API. На первом этапе `/api/runtime/providers/:provider/auth` — заглушка, которая возвращает текущий статус (читает из vault или systemd-окружения).

### AgentRun

```ts
export interface AgentRun {
  id: string;                             // runId
  task_id: string;
  agent_id: string;                       // = profile.id
  runtime_id: RuntimeId;
  provider: ProviderId | null;
  model: string; | null;
  session_id: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  finished_at: string | null;
  stop_reason: string | null;
}
```

На первом этапе — **read-only фасад** поверх существующих полей `tasks` (`agent_state`, `agent_session_id`, `agent_heartbeat_at`, `agent_started_at`, `agent_finished_at`, `stop_reason`). Полная таблица `agent_runs` — отдельная карточка.

## RuntimeAdapter

```ts
export interface RuntimeAdapter {
  readonly id: RuntimeId;
  status(): Promise<Runtime>;
  listProfiles(): Promise<AgentProfile[]>;
  listModels(): Promise<Model[]>;
  listProviders(): Promise<ProviderConnection[]>;
  startRun(input: { taskId: string; agentId: string; model?: string; prompt: string; tools?: string[] }): Promise<{ runId: string; sessionId: string; status: AgentRun["status"] }>;
  sendMessage(runId: string, text: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  getRun(runId: string): Promise<AgentRun>;
}
```

Реализация `PiRuntimeAdapter` на первом этапе — **тонкая обёртка** над существующими вызовами:

- `status()` → `unitState()` из `agent-service.ts` (жив ли systemd-юнит `taskflow-trigger.service`).
- `listProfiles()` → `roleDetails()` из `routes/roles.ts` с переименованием `default_shell → runtime_id`.
- `listModels()` → уникальные значения `role-routing.yaml:models`.
- `listProviders()` → проверка vault/env на наличие `TASKFLOW_*_TOKEN` (heuristic).
- `startRun()` → **НЕ вызывается напрямую**: `trigger.py` остаётся исполнителем, `startRun()` кидает `UnsupportedInFacadeError` с понятным сообщением «используйте trigger.py, PiRuntimeAdapter не запускает процессы в этой версии».

Это удерживает объём: `trigger.py` уже работает, мы не ломаем его ради красоты. Реальная интеграция — отдельная карточка.

## API

Новые маршруты в `server/src/routes/runtime.ts`:

| Метод | Путь                                       | Назначение                                    |
| ----- | ------------------------------------------ | --------------------------------------------- |
| GET   | `/api/runtime/status`                      | `Runtime` (один, `pi`)                        |
| GET   | `/api/runtime/profiles`                    | `AgentProfile[]` (8 профилей)                 |
| GET   | `/api/runtime/profiles/:id`                | `AgentProfile` (один)                         |
| GET   | `/api/runtime/models`                      | `Model[]` (дедуп по `role-routing.yaml:models`) |
| GET   | `/api/runtime/providers`                   | `ProviderConnection[]` (статус из vault)      |
| POST  | `/api/runtime/providers/:provider/auth`    | Заглушка, возвращает текущий статус           |
| POST  | `/api/runtime/runs`                        | Заглушка, см. `startRun()` выше               |
| GET   | `/api/runtime/runs/:id`                    | `AgentRun` (фасад над tasks)                  |
| POST  | `/api/runtime/runs/:id/message`            | 501 Not Implemented в этой версии             |
| POST  | `/api/runtime/runs/:id/cancel`             | 501 Not Implemented в этой версии             |

Старый `/api/roles` остаётся **без изменений** — UI продолжает читать `default_shell`, `fallbacks`, `model`. Маркером перехода будет отдельная карточка (UI-обновление).

## Что входит

1. Переименование `agent_pi` → `pi_runtime` в коде, тестах, YAML, комментариях.
2. Удаление `LEGACY_EXTERNAL_AGENTS` из `server/scripts/trigger.py`.
3. Удаление `SHELL_USER_IDS` из `server/src/roleRouting.ts` (после перевода `nextShellForRole`).
4. Новый модуль `server/src/runtime/` с фасадными типами и `PiRuntimeAdapter`.
5. Новый маршрут `server/src/routes/runtime.ts` с 9 endpoint'ами.
6. Перевод `nextShellForRole` на `RuntimeAdapter`-семантику (без потери поведения).
7. Обновление тестов: `roles.test.ts`, `test_role_routing.py`, новые тесты для `PiRuntimeAdapter`.
8. Обновление документации: `docs/ARCHITECTURE.md`, `docs/AGENTS.md` (терминология).

## Что не входит

1. **Миграция БД** — таблицы `agent_profiles`, `runtimes`, `models`, `provider_connections`, `agent_runs` не заводятся.
2. **ClaudeCodeRuntime, CodexRuntime** — отложены (см. исходное ТЗ, п. 7).
3. **Реальный OAuth в Pi** — `connectProvider(name)` остаётся заглушкой до появления в Pi.
4. **UI** — экран «Настройки → Провайдеры» отдельной карточкой.
5. **Полная переработка `trigger.py`** — оборачиваем, не переписываем.
6. **Изменение публичного контракта `/api/roles`** — UI его читает, не ломаем.

## Риски и способы их снять

| Риск                                                       | Снятие                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| Ломаем legacy карточки с `assignee_id = agent_pi`          | `agent_pi` остаётся в `EXTERNAL_AGENTS` как alias; `handle_task` уже умеет оба пути |
| Ломаем claim для ролевых ключей при изменении trigger.py   | Шаг «перевод trigger.py на PiRuntimeAdapter» — последний перед тестами; если падает — откат на текущий `EXTERNAL_AGENTS` |
| `/api/runtime/providers/:provider/auth` пока без реального OAuth | Endpoint возвращает 501 со ссылкой на issue «Pi OAuth» |
| `nextShellForRole` использует `agent_pi`                   | Заменяем на `RUNTIME_ID`-семантику + читаем `users` для id |

## Глобальные ограничения

- Только ветка `main`. Без форков, без feature-веток.
- Все изменения коммитятся отдельными коммитами по subtask, не сводным.
- `trigger.py` не переписывается — только точечные правки в `handle_task` и удаление `LEGACY_EXTERNAL_AGENTS`.
- Никаких новых npm-зависимостей без явной отметки в спеке.
- Тесты vitest и pytest должны проходить до закрытия карточки.
- Контракт `/api/roles` неизменен.
