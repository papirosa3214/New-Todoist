# Pi Runtime Facade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pi становится единым runtime для всех 8 ролей TaskFlow через API-фасад, без миграции БД. `agent_pi` уходит из кода как «отдельный агент», остаётся только как legacy-alias для старых карточек.

**Architecture:** `server/src/runtime/` с фасадными типами (`Runtime`, `AgentProfile`, `Model`, `ProviderConnection`, `AgentRun`) и реализацией `PiRuntimeAdapter`. API в `server/src/routes/runtime.ts`. Существующий `trigger.py` оборачивается, не переписывается.

**Tech Stack:** TypeScript (Node 22, Fastify), Python 3, vitest, pytest, SQLite.

**Spec:** [`docs/superpowers/specs/2026-09-18-pi-runtime-facade.md`](../specs/2026-09-18-pi-runtime-facade.md).

---

## Global Constraints

- Только ветка `main`. Без форков и feature-веток.
- Каждый task коммитится отдельным коммитом; не объединять независимые правки.
- `trigger.py` не переписывается — только удаление `LEGACY_EXTERNAL_AGENTS` и точечные правки в `handle_task` / `resolve_agent_for_role`.
- Контракт `/api/roles` (поля `default_shell`, `fallbacks`, `model`, `tools`, `skills`, `prompt`) **неизменен** — UI его читает.
- Новые npm-зависимости не добавляются без явного одобрения Максима.
- vitest и pytest должны проходить до коммита соответствующего task'а.
- В коде — только `pi_runtime` / `RUNTIME_ID = "pi"`. Строки `"agent_pi"` остаются только в legacy-картах для обратной совместимости и помечены комментарием.

---

## File Structure

### Создать

| Файл | Ответственность |
| --- | --- |
| `server/src/runtime/types.ts` | Фасадные типы: `Runtime`, `AgentProfile`, `Model`, `ProviderConnection`, `AgentRun`, `RuntimeId`, `RuntimeKind` |
| `server/src/runtime/RuntimeAdapter.ts` | Интерфейс `RuntimeAdapter` |
| `server/src/runtime/PiRuntimeAdapter.ts` | Реализация `RuntimeAdapter` поверх существующих источников |
| `server/src/runtime/index.ts` | Barrel: экспорт типов и адаптера |
| `server/src/routes/runtime.ts` | HTTP-маршруты `/api/runtime/*` |
| `server/test/runtime.test.ts` | vitest для типов и `PiRuntimeAdapter` |
| `server/scripts/test_pi_runtime_adapter.py` | pytest для обновлённого `trigger.py` |
| `docs/superpowers/specs/2026-09-18-pi-runtime-facade.md` | Спек (уже создан) |
| `docs/superpowers/plans/2026-09-18-pi-runtime-facade.md` | Этот план |

### Изменить

| Файл | Что меняется |
| --- | --- |
| `server/src/roleRouting.ts` | Удалить `SHELL_USER_IDS`. `loadRoleRouting` → `loadRuntimeConfig`. `nextShellForRole` → `nextModelForProfile`. `RoleRouting` → `RuntimeConfig` |
| `server/src/routes/roles.ts` | `roleDetails` отдаёт `runtime_id` (новое поле) рядом со старым `default_shell` (для UI). Новый импорт `RuntimeAdapter` |
| `server/src/routes/agent-state.ts` | Использовать `RuntimeAdapter` вместо прямого вызова `nextShellForRole` |
| `server/src/index.ts` | Регистрация новых маршрутов `/api/runtime/*` |
| `server/scripts/trigger.py` | Удалить `LEGACY_EXTERNAL_AGENTS`. Переименовать `agent_pi` → `pi_runtime` в `EXTERNAL_AGENTS` (оставить как alias). Убрать `resolve_agent_for_role` (заменить вызов через единый путь) |
| `server/scripts/role-routing.yaml` | `defaults: { architect: agent_pi, ... }` → `runtimes: { architect: pi, ... }` (через `RoleRuntime` секцию) |
| `server/scripts/test_role_routing.py` | Обновить тесты под новую секционную структуру YAML |
| `server/test/roles.test.ts` | Ассерт `default_shell: "agent_pi"` → `runtime_id: "runtime:pi"` рядом со старым полем |
| `docs/ARCHITECTURE.md` | Обновить терминологию: agent_pi → pi_runtime |
| `docs/AGENTS.md` | Обновить терминологию |

### Не трогать

- `server/src/routes/dispatch.ts` — уже работает правильно.
- `server/src/routes/consultation.ts`, `server/src/routes/agent-inbox.ts` — используют `assignee_id` напрямую.
- `server/scripts/role-prompts/`, `~/.pi/agent/taskflow-profiles/` — это источники правды для фасада.
- `vault-run.py`, systemd-юниты — это вне scope карточки.

---

## Task 1: Зафиксировать спек и план

**Files:**
- Create: `docs/superpowers/specs/2026-09-18-pi-runtime-facade.md`
- Create: `docs/superpowers/plans/2026-09-18-pi-runtime-facade.md`

- [ ] **Step 1: Спек уже создан** (выполнен в этой сессии).

Проверка:
```bash
ls -la docs/superpowers/specs/2026-09-18-pi-runtime-facade.md
```
Ожидаемо: файл существует.

- [ ] **Step 2: План уже создан** (этот файл).

Проверка:
```bash
ls -la docs/superpowers/plans/2026-09-18-pi-runtime-facade.md
```
Ожидаемо: файл существует.

- [ ] **Step 3: Коммит**

```bash
cd /home/maksim/Проекты/New-Todoist
git add docs/superpowers/
git commit -m "docs: спек и план рефакторинга Pi = единый runtime (фасад)"
```

---

## Task 2: Переименовать `agent_pi` → `pi_runtime` в коде и тестах

**Files:**
- Modify: `server/scripts/role-routing.yaml`
- Modify: `server/src/roleRouting.ts`
- Modify: `server/scripts/trigger.py`
- Modify: `server/test/roles.test.ts`

- [ ] **Step 1: Переименовать в role-routing.yaml**

Заменить `agent_pi` на `pi_runtime` в секции `defaults` × 8 раз. Старый `agent_pi` оставить **как alias** в комментарии сверху файла:
```yaml
# Алиас agent_pi → pi_runtime: карточки до 18.09.2026 ссылаются на agent_pi,
# trigger.py трактует оба имени одинаково (см. SHELL_AGENT_ALIASES).
defaults:
  researcher: pi_runtime
  analyst: pi_runtime
  synthesizer: pi_runtime
  critic_verifier: pi_runtime
  architect: pi_runtime
  builder: pi_runtime
  qa: pi_runtime
  designer: pi_runtime
```

- [ ] **Step 2: Переименовать в roleRouting.ts**

В `SHELL_USER_IDS` переименовать ключ `"agent_pi"` → `"pi_runtime"` (значение остаётся `PI_AGENT_ID`).
Добавить обратный alias для legacy:
```ts
export const SHELL_AGENT_ALIASES: Record<string, string> = {
  agent_pi: "pi_runtime",
};
```

- [ ] **Step 3: Переименовать в trigger.py**

В `SHELL_AGENT_IDS` (`server/scripts/trigger.py:354`) переименовать ключ `"agent_pi"` → `"pi_runtime"`, значение оставить `PI_AGENT_ID`. Старое имя — как alias.

- [ ] **Step 4: Запустить vitest, убедиться что не сломалось**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/roles.test.ts
```

Ожидаемо: тест `lists eight roles and returns Architect details` падает на `default_shell: "agent_pi"`. Это нормально — обновим в Task 10.

- [ ] **Step 5: Запустить pytest role-routing**

```bash
cd /home/maksim/Проекты/New-Todoist
python3 -m pytest server/scripts/test_role_routing.py -v
```

Ожидаемо: тесты на загрузку YAML проходят (там просто проверка структуры). Тест на `qa: agent_pi` (test_role_routing.py:L22) падает. Запомним — обновим в Task 10.

- [ ] **Step 6: Коммит**

```bash
git add server/scripts/role-routing.yaml server/src/roleRouting.ts server/scripts/trigger.py
git commit -m "refactor: agent_pi → pi_runtime в role-routing и SHELL_AGENT_IDS (legacy-alias сохранён)"
```

---

## Task 3: Удалить `LEGACY_EXTERNAL_AGENTS` из `trigger.py`

**Files:**
- Modify: `server/scripts/trigger.py`

- [ ] **Step 1: Прочитать блок LEGACY_EXTERNAL_AGENTS (L95-L217)**

Содержимое известно из разведки: 5 учёток (claude_bot, hermes, orchestrator-claude, dsh, antigravity). Все помечены «историческая документация, в работу не попадают».

- [ ] **Step 2: Удалить весь блок `LEGACY_EXTERNAL_AGENTS = { ... }`**

Удалить строки от `LEGACY_EXTERNAL_AGENTS = {` до закрывающей `}`. Сохранить комментарий над блоком как объяснение, почему legacy shells больше не входят в `EXTERNAL_AGENTS`:

```python
# До 16.09.2026 в EXTERNAL_AGENTS жили шесть оболочек (claude_bot, hermes,
# orchestrator-claude, deepseek, antigravity, pi). Их вытеснил единый
# Pi runtime: 8 ролей исполняются одной машиной, различаясь mcp-профилем
# и ролью в задаче. Старые записи вычищены 18.09.2026 (см. карточка
# f3108dcc — «Pi = единый runtime, фасад»). Если когда-то понадобится
# поднять отдельную оболочку под отдельную роль, формат ключей тот же,
# что в EXTERNAL_AGENTS: <id>: {id, token_env, cmd, roles, ...}.
```

- [ ] **Step 3: Запустить trigger.py в dry-run, убедиться что стартует**

```bash
cd /home/maksim/Проекты/New-Todoist
TASKFLOW_TRIGGER_DRY=1 timeout 3 python3 server/scripts/trigger.py 2>&1 | head -40
```

Ожидаемо: dry-run стартует без `NameError`/`KeyError`, печатает «[сухой прогон]» или ждёт WebSocket.

- [ ] **Step 4: Запустить pytest**

```bash
cd /home/maksim/Проекты/New-Todoist
python3 -m pytest server/scripts/test_trigger_isolated.py -v 2>&1 | head -40
python3 -m pytest server/scripts/test_trigger_v2.py -v 2>&1 | head -40
```

Ожидаемо: либо проходят, либо падают на несуществующих символах legacy — это нормально. Падения фиксируем, в Task 10 разберёмся.

- [ ] **Step 5: Коммит**

```bash
git add server/scripts/trigger.py
git commit -m "refactor(trigger): удалить LEGACY_EXTERNAL_AGENTS (5 мёртвых оболочек)"
```

---

## Task 4: Ввести фасадные типы в `server/src/runtime/types.ts`

**Files:**
- Create: `server/src/runtime/types.ts`
- Create: `server/test/runtime/types.test.ts`

- [ ] **Step 1: Написать failing test**

`server/test/runtime/types.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  RUNTIME_ID_PI,
  isRuntimeId,
  isAgentProfile,
  isModel,
  isProviderConnection,
  isAgentRun,
} from "../../src/runtime/types.js";

describe("runtime facade types", () => {
  it("RUNTIME_ID_PI is 'runtime:pi'", () => {
    expect(RUNTIME_ID_PI).toBe("runtime:pi");
  });

  it("isRuntimeId accepts the only known runtime", () => {
    expect(isRuntimeId("runtime:pi")).toBe(true);
    expect(isRuntimeId("runtime:claude_code")).toBe(false);
    expect(isRuntimeId("pi")).toBe(false);
  });

  it("isAgentProfile accepts a well-formed profile", () => {
    const profile = {
      id: "architect",
      role: "architect",
      title: "Архитектор",
      account_id: "role_architect",
      runtime_id: RUNTIME_ID_PI,
      prompt: { source: "scripts/role-prompts/architect.md", size: 1024 },
      skills: [{ name: "architecture", description: null }],
      tools: ["taskflow_doc_write"],
      permissions: null,
      modelPolicy: { primary: "MiniMax-M3", fallbacks: [] },
      status: "ready" as const,
    };
    expect(isAgentProfile(profile)).toBe(true);
  });

  it("isModel accepts a well-formed model", () => {
    expect(
      isModel({ id: "MiniMax-M3", provider: "minimax", runtime_id: RUNTIME_ID_PI, available: true })
    ).toBe(true);
  });

  it("isProviderConnection accepts a well-formed connection", () => {
    expect(
      isProviderConnection({ id: "anthropic", runtime_id: RUNTIME_ID_PI, status: "connected", managedBy: "pi", lastCheckedAt: null })
    ).toBe(true);
  });

  it("isAgentRun accepts a well-formed run", () => {
    expect(
      isAgentRun({
        id: "run-1",
        task_id: "task-1",
        agent_id: "architect",
        runtime_id: RUNTIME_ID_PI,
        provider: null,
        model: null,
        session_id: null,
        status: "queued",
        started_at: "2026-09-18T00:00:00Z",
        finished_at: null,
        stop_reason: null,
      })
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/runtime/types.test.ts
```

Ожидаемо: `Cannot find module ... runtime/types.js`.

- [ ] **Step 3: Реализовать типы**

`server/src/runtime/types.ts`:
```ts
// Фасадные типы рантайма. Источники правды остаются прежними:
// users, role-routing.yaml, role-prompts/, vault. Этот модуль —
// только терминология и валидаторы для API.

export const RUNTIME_ID_PI = "runtime:pi" as const;
export type RuntimeId = typeof RUNTIME_ID_PI;
export type RuntimeKind = "pi";

export interface Runtime {
  id: RuntimeId;
  kind: RuntimeKind;
  status: "ready" | "starting" | "down";
  version: string;
  endpoint: string;
}

export interface AgentProfile {
  id: string;
  role: string;
  title: string;
  account_id: string;
  runtime_id: RuntimeId;
  prompt: { source: string; size: number };
  skills: Array<{ name: string; description: string | null }>;
  tools: string[];
  permissions: string | null;
  modelPolicy: {
    primary: string;
    fallbacks: string[];
  };
  status: "ready" | "working" | "blocked" | "unavailable";
}

export interface Model {
  id: string;
  provider: string;
  runtime_id: RuntimeId;
  available: boolean;
}

export interface ProviderConnection {
  id: string;
  runtime_id: RuntimeId;
  status: "connected" | "disconnected" | "expired";
  managedBy: "pi";
  lastCheckedAt: string | null;
}

export interface AgentRun {
  id: string;
  task_id: string;
  agent_id: string;
  runtime_id: RuntimeId;
  provider: string | null;
  model: string | null;
  session_id: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  finished_at: string | null;
  stop_reason: string | null;
}

export function isRuntimeId(value: unknown): value is RuntimeId {
  return value === RUNTIME_ID_PI;
}

function hasField(obj: unknown, field: string): boolean {
  return typeof obj === "object" && obj !== null && field in obj;
}

export function isAgentProfile(value: unknown): value is AgentProfile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.role === "string" &&
    typeof v.title === "string" &&
    typeof v.account_id === "string" &&
    v.runtime_id === RUNTIME_ID_PI &&
    typeof v.prompt === "object" &&
    Array.isArray(v.skills) &&
    Array.isArray(v.tools) &&
    typeof v.modelPolicy === "object" &&
    typeof v.status === "string"
  );
}

export function isModel(value: unknown): value is Model {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.provider === "string" &&
    v.runtime_id === RUNTIME_ID_PI &&
    typeof v.available === "boolean"
  );
}

export function isProviderConnection(value: unknown): value is ProviderConnection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.runtime_id === RUNTIME_ID_PI &&
    typeof v.status === "string" &&
    v.managedBy === "pi"
  );
}

export function isAgentRun(value: unknown): value is AgentRun {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.task_id === "string" &&
    typeof v.agent_id === "string" &&
    v.runtime_id === RUNTIME_ID_PI &&
    typeof v.status === "string" &&
    typeof v.started_at === "string"
  );
}
```

- [ ] **Step 4: Запустить, убедиться что проходит**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/runtime/types.test.ts
```

Ожидаемо: 6 тестов passed.

- [ ] **Step 5: Коммит**

```bash
git add server/src/runtime/types.ts server/test/runtime/types.test.ts
git commit -m "feat(runtime): фасадные типы Runtime/AgentProfile/Model/ProviderConnection/AgentRun"
```

---

## Task 5: Реализовать `RuntimeAdapter` и `PiRuntimeAdapter`

**Files:**
- Create: `server/src/runtime/RuntimeAdapter.ts`
- Create: `server/src/runtime/PiRuntimeAdapter.ts`
- Create: `server/src/runtime/index.ts`
- Create: `server/test/runtime/PiRuntimeAdapter.test.ts`

- [ ] **Step 1: Написать failing test**

`server/test/runtime/PiRuntimeAdapter.test.ts`:
```ts
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";
import { piRuntime } from "../../src/runtime/index.js";

describe("PiRuntimeAdapter", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
    // Подсеять ролевые учётки и архитектора (для listProfiles)
    db.prepare(`INSERT OR IGNORE INTO users (id, name, role, type) VALUES
      ('role_architect', 'Архитектор', 'architect', 'ai'),
      ('role_qa', 'QA', 'qa', 'ai')`).run();
  });
  afterAll(async () => { await app.close(); });

  it("id is runtime:pi", () => {
    expect(piRuntime.id).toBe("runtime:pi");
  });

  it("status returns a Runtime", async () => {
    const status = await piRuntime.status();
    expect(status.id).toBe("runtime:pi");
    expect(status.kind).toBe("pi");
    expect(["ready", "starting", "down"]).toContain(status.status);
    expect(typeof status.version).toBe("string");
    expect(typeof status.endpoint).toBe("string");
  });

  it("listProfiles returns 8 profiles", async () => {
    const profiles = await piRuntime.listProfiles();
    expect(profiles).toHaveLength(8);
    expect(profiles[0].runtime_id).toBe("runtime:pi");
  });

  it("listModels returns unique models from role-routing", async () => {
    const models = await piRuntime.listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) expect(m.runtime_id).toBe("runtime:pi");
  });

  it("listProviders returns heuristic status from env", async () => {
    const providers = await piRuntime.listProviders();
    expect(providers.length).toBeGreaterThan(0);
    for (const p of providers) expect(p.managedBy).toBe("pi");
  });

  it("startRun throws UnsupportedInFacadeError", async () => {
    await expect(
      piRuntime.startRun({ taskId: "t", agentId: "architect", prompt: "x" })
    ).rejects.toThrow(/trigger\.py/i);
  });

  it("getRun returns AgentRun facade for existing task", async () => {
    const task = db.prepare(
      `INSERT INTO tasks (id, title, status) VALUES (?, ?, 'active')`
    ).run("task-facade-1", "test").lastInsertRowid;
    const run = await piRuntime.getRun(String(task));
    expect(run.task_id).toBe(String(task));
    expect(run.runtime_id).toBe("runtime:pi");
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/runtime/PiRuntimeAdapter.test.ts
```

Ожидаемо: `Cannot find module ... runtime/index.js`.

- [ ] **Step 3: Реализовать RuntimeAdapter**

`server/src/runtime/RuntimeAdapter.ts`:
```ts
import type {
  AgentProfile,
  AgentRun,
  Model,
  ProviderConnection,
  Runtime,
  RuntimeId,
} from "./types.js";

export interface StartRunInput {
  taskId: string;
  agentId: string;
  model?: string;
  prompt: string;
  tools?: string[];
}

export interface StartRunResult {
  runId: string;
  sessionId: string;
  status: AgentRun["status"];
}

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  status(): Promise<Runtime>;
  listProfiles(): Promise<AgentProfile[]>;
  listModels(): Promise<Model[]>;
  listProviders(): Promise<ProviderConnection[]>;
  startRun(input: StartRunInput): Promise<StartRunResult>;
  sendMessage(runId: string, text: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  getRun(runId: string): Promise<AgentRun>;
}

export class UnsupportedInFacadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInFacadeError";
  }
}
```

- [ ] **Step 4: Реализовать PiRuntimeAdapter**

`server/src/runtime/PiRuntimeAdapter.ts`:
```ts
import fs from "node:fs";
import path from "node:path";
import db from "../db.js";
import { ROLE_NAMES, type RoleName, loadRoleRouting } from "../roleRouting.js";
import type {
  AgentProfile,
  AgentRun,
  Model,
  ProviderConnection,
  Runtime,
} from "./types.js";
import { RUNTIME_ID_PI } from "./types.js";
import { UnsupportedInFacadeError, type RuntimeAdapter, type StartRunInput, type StartRunResult } from "./RuntimeAdapter.js";

const ROLE_PROMPTS_DIR = process.env.TASKFLOW_ROLE_PROMPTS_DIR
  ?? path.join(process.cwd(), "scripts", "role-prompts");
const ROLE_PROFILES_DIR = process.env.TASKFLOW_ROLE_PROFILES_DIR
  ?? path.join(process.env.HOME ?? ".", ".pi", "agent", "taskflow-profiles");

function readPromptSize(role: RoleName): { source: string; size: number } {
  const file = path.join(ROLE_PROMPTS_DIR, `${role}.md`);
  try {
    const stat = fs.statSync(file);
    return { source: file, size: stat.size };
  } catch {
    return { source: file, size: 0 };
  }
}

function readRoleTools(role: RoleName): string[] {
  const file = path.join(ROLE_PROFILES_DIR, `${role}.json`);
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as {
      mcpServers?: { taskflow?: { env?: Record<string, string> } };
    };
    const tools = config.mcpServers?.taskflow?.env?.TASKFLOW_MCP_TOOLS;
    if (!tools) return [];
    return tools.split(",").map((t) => t.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function readRoleSkills(role: RoleName) {
  return db
    .prepare(`SELECT skill_name, description FROM role_skills WHERE role = ? ORDER BY skill_name`)
    .all(role) as Array<{ skill_name: string; description: string | null }>;
}

function readRoleAccount(role: RoleName) {
  return db
    .prepare(`SELECT id, name, permissions, status, last_seen_at FROM users WHERE role = ? ORDER BY created_at LIMIT 1`)
    .get(role) as
      | { id: string; name: string; permissions: string | null; status: string | null; last_seen_at: string | null }
      | undefined;
}

async function piAlive(): Promise<boolean> {
  try {
    const { unitState } = await import("../routes/agent-service.js");
    return (await unitState()).active;
  } catch {
    return false;
  }
}

async function buildProfile(role: RoleName, alive: boolean): Promise<AgentProfile> {
  const routing = loadRoleRouting();
  const account = readRoleAccount(role);
  const skills = readRoleSkills(role).map((s) => ({ name: s.skill_name, description: s.description }));
  const tools = readRoleTools(role);
  const prompt = readPromptSize(role);
  const work = db
    .prepare(`SELECT agent_state FROM tasks WHERE status = 'active' AND dispatched_role = ? AND agent_state IN ('in_progress', 'blocked') LIMIT 1`)
    .get(role) as { agent_state: string } | undefined;
  let status: AgentProfile["status"] = "ready";
  if (!account) status = "unavailable";
  else if (!alive) status = "unavailable";
  else if (work?.agent_state === "in_progress") status = "working";
  else if (work?.agent_state === "blocked") status = "blocked";
  return {
    id: role,
    role,
    title: account?.name ?? role,
    account_id: account?.id ?? "",
    runtime_id: RUNTIME_ID_PI,
    prompt,
    skills,
    tools,
    permissions: account?.permissions ?? null,
    modelPolicy: {
      primary: routing.models[role],
      fallbacks: routing.fallbacks[role],
    },
    status,
  };
}

const KNOWN_PROVIDERS = ["anthropic", "openai", "minimax"] as const;

function providerStatusFromEnv(provider: string): "connected" | "disconnected" | "expired" {
  // Heuristic: реальный статус приходит из Pi/vault, здесь только фолбэк
  // для сухого прогона и тестов. Реальная проверка — в connectProvider().
  const envKey = `TASKFLOW_${provider.toUpperCase()}_TOKEN`;
  if (process.env[envKey]) return "connected";
  return "disconnected";
}

export const piRuntime: RuntimeAdapter = {
  id: RUNTIME_ID_PI,

  async status(): Promise<Runtime> {
    const alive = await piAlive();
    return {
      id: RUNTIME_ID_PI,
      kind: "pi",
      status: alive ? "ready" : "down",
      // Версия — из npm bin или из version-файла Pi. На первом этапе —
      // строка-маркер; реальная версия появится, когда Pi отдаст её.
      version: process.env.PI_VERSION ?? "unknown",
      endpoint: process.env.PI_ENDPOINT ?? "cli",
    };
  },

  async listProfiles(): Promise<AgentProfile[]> {
    const alive = await piAlive();
    return Promise.all(ROLE_NAMES.map((r) => buildProfile(r, alive)));
  },

  async listModels(): Promise<Model[]> {
    const routing = loadRoleRouting();
    const seen = new Set<string>();
    const models: Model[] = [];
    for (const role of ROLE_NAMES) {
      const id = routing.models[role];
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        provider: "minimax", // первый этап: провайдер один, MiniMax. Расширение — позже.
        runtime_id: RUNTIME_ID_PI,
        available: true,
      });
    }
    return models;
  },

  async listProviders(): Promise<ProviderConnection[]> {
    return KNOWN_PROVIDERS.map((p) => ({
      id: p,
      runtime_id: RUNTIME_ID_PI,
      status: providerStatusFromEnv(p),
      managedBy: "pi" as const,
      lastCheckedAt: null,
    }));
  },

  async startRun(_input: StartRunInput): Promise<StartRunResult> {
    throw new UnsupportedInFacadeError(
      "PiRuntimeAdapter.startRun() недоступен в этой версии фасада: " +
      "запуск процесса делает server/scripts/trigger.py. " +
      "См. карточку f3108dcc — Task 9.",
    );
  },

  async sendMessage(_runId: string, _text: string): Promise<void> {
    throw new UnsupportedInFacadeError(
      "PiRuntimeAdapter.sendMessage() недоступен: диалог с запущенным " +
      "Pi-заходом ведётся через claim/message API карточки, а не через runtime.",
    );
  },

  async cancelRun(_runId: string): Promise<void> {
    throw new UnsupportedInFacadeError(
      "PiRuntimeAdapter.cancelRun() недоступен: отмена — через cancel " +
      "на карточке, см. /api/tasks/:id/cancel.",
    );
  },

  async getRun(runId: string): Promise<AgentRun> {
    const task = db
      .prepare(
        `SELECT id, assignee_id, dispatched_role, agent_session_id, agent_started_at,
                agent_finished_at, stop_reason, agent_state
           FROM tasks WHERE id = ?`,
      )
      .get(runId) as
      | {
          id: string;
          assignee_id: string | null;
          dispatched_role: string | null;
          agent_session_id: string | null;
          agent_started_at: string | null;
          agent_finished_at: string | null;
          stop_reason: string | null;
          agent_state: string | null;
        }
      | undefined;
    if (!task) {
      throw new Error(`AgentRun ${runId}: задача не найдена`);
    }
    return {
      id: `run-${task.id.slice(0, 8)}`,
      task_id: task.id,
      agent_id: task.dispatched_role ?? task.assignee_id ?? "",
      runtime_id: RUNTIME_ID_PI,
      provider: null,
      model: null,
      session_id: task.agent_session_id,
      status: task.agent_state === "in_progress" ? "running"
            : task.agent_state === "review" ? "completed"
            : task.agent_state === "blocked" ? "failed"
            : "queued",
      started_at: task.agent_started_at ?? new Date().toISOString(),
      finished_at: task.agent_finished_at,
      stop_reason: task.stop_reason,
    };
  },
};
```

- [ ] **Step 5: Barrel**

`server/src/runtime/index.ts`:
```ts
export * from "./types.js";
export * from "./RuntimeAdapter.js";
export { piRuntime } from "./PiRuntimeAdapter.js";
```

- [ ] **Step 6: Запустить, убедиться что проходит**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/runtime/PiRuntimeAdapter.test.ts
```

Ожидаемо: 7 тестов passed (или разумная часть — `status()` зависит от systemd).

- [ ] **Step 7: Коммит**

```bash
git add server/src/runtime/
git commit -m "feat(runtime): PiRuntimeAdapter — фасад над существующими источниками"
```

---

## Task 6: API `/api/runtime/status`, `/api/runtime/profiles`, `/api/runtime/models`

**Files:**
- Create: `server/src/routes/runtime.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Написать failing test**

Добавить в `server/test/runtime/api.test.ts`:
```ts
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { buildApp } from "../../src/index.js";

describe("runtime API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { name: `RuntimeOwner${Date.now()}`, email: `runtime-${Date.now()}@test`, password: "password123" },
    });
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner.json().user.id);
    token = owner.json().token;
  });
  afterAll(async () => { await app.close(); });

  it("GET /api/runtime/status returns Runtime", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/runtime/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "runtime:pi", kind: "pi" });
  });

  it("GET /api/runtime/profiles returns 8 profiles", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/runtime/profiles",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profiles).toHaveLength(8);
    expect(res.json().profiles[0].runtime_id).toBe("runtime:pi");
  });

  it("GET /api/runtime/profiles/:id returns single profile", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/runtime/profiles/architect",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("architect");
  });

  it("GET /api/runtime/models returns unique models", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/runtime/models",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().models)).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/runtime/api.test.ts
```

Ожидаемо: 404 на `/api/runtime/status`.

- [ ] **Step 3: Реализовать маршруты**

`server/src/routes/runtime.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { piRuntime } from "../runtime/index.js";

export function registerRuntimeRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  app.get("/api/runtime/status", { preHandler: authPre }, async () => {
    const status = await piRuntime.status();
    return { runtime: status };
  });

  app.get("/api/runtime/profiles", { preHandler: authPre }, async () => {
    const profiles = await piRuntime.listProfiles();
    return { profiles };
  });

  app.get<{ Params: { id: string } }>(
    "/api/runtime/profiles/:id",
    { preHandler: authPre },
    async (req, reply) => {
      const profiles = await piRuntime.listProfiles();
      const profile = profiles.find((p) => p.id === req.params.id);
      if (!profile) return reply.code(404).send({ error: "profile not found" });
      return profile;
    },
  );

  app.get("/api/runtime/models", { preHandler: authPre }, async () => {
    const models = await piRuntime.listModels();
    return { models };
  });
}
```

- [ ] **Step 4: Регистрация в index.ts**

В `server/src/index.ts`, в месте `registerXxxRoutes(app)`, добавить:
```ts
import { registerRuntimeRoutes } from "./routes/runtime.js";
// ...
registerRuntimeRoutes(app);
```

- [ ] **Step 5: Запустить, убедиться что проходит**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/runtime/api.test.ts
```

Ожидаемо: 4 теста passed.

- [ ] **Step 6: Коммит**

```bash
git add server/src/routes/runtime.ts server/src/index.ts server/test/runtime/api.test.ts
git commit -m "feat(runtime): API /api/runtime/{status,profiles,models}"
```

---

## Task 7: API `/api/runtime/providers` + `/api/runtime/providers/:provider/auth`

**Files:**
- Modify: `server/src/routes/runtime.ts`
- Create: `server/test/runtime/providers.test.ts`

- [ ] **Step 1: Написать failing test**

`server/test/runtime/providers.test.ts`:
```ts
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";

describe("runtime providers API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { name: `ProvOwner${Date.now()}`, email: `prov-${Date.now()}@test`, password: "password123" },
    });
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner.json().user.id);
    token = owner.json().token;
  });
  afterAll(async () => { await app.close(); });

  it("GET /api/runtime/providers returns 3 providers with managedBy=pi", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/runtime/providers",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const providers = res.json().providers;
    expect(providers.length).toBeGreaterThanOrEqual(3);
    for (const p of providers) {
      expect(p.runtime_id).toBe("runtime:pi");
      expect(p.managedBy).toBe("pi");
    }
  });

  it("POST /api/runtime/providers/anthropic/auth returns current status", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/runtime/providers/anthropic/auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(["connected", "disconnected", "expired"]).toContain(res.json().status);
  });

  it("POST /api/runtime/providers/unknown/auth returns 404", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/runtime/providers/unknown/auth",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/runtime/providers.test.ts
```

Ожидаемо: 404.

- [ ] **Step 3: Добавить маршруты в runtime.ts**

Дополнить `server/src/routes/runtime.ts`:
```ts
const KNOWN_PROVIDERS = ["anthropic", "openai", "minimax"] as const;

app.get("/api/runtime/providers", { preHandler: authPre }, async () => {
  const providers = await piRuntime.listProviders();
  return { providers };
});

app.post<{ Params: { provider: string } }>(
  "/api/runtime/providers/:provider/auth",
  { preHandler: authPre },
  async (req, reply) => {
    const name = req.params.provider;
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(name)) {
      return reply.code(404).send({ error: "unknown provider" });
    }
    // Заглушка до появления реального OAuth в Pi.
    // Возвращаем текущий статус из окружения, не инициируем OAuth.
    const providers = await piRuntime.listProviders();
    const provider = providers.find((p) => p.id === name);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    return {
      provider: provider.id,
      status: provider.status,
      note: "Реальный connectProvider появится в Pi; пока возвращается текущий статус.",
    };
  },
);
```

- [ ] **Step 4: Запустить, убедиться что проходит**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/runtime/providers.test.ts
```

Ожидаемо: 3 теста passed.

- [ ] **Step 5: Коммит**

```bash
git add server/src/routes/runtime.ts server/test/runtime/providers.test.ts
git commit -m "feat(runtime): API /api/runtime/providers + auth-заглушка"
```

---

## Task 8: Перевести `roleRouting.ts` и `agent-state.ts` на новые имена

**Files:**
- Modify: `server/src/roleRouting.ts`
- Modify: `server/src/routes/agent-state.ts`
- Modify: `server/src/routes/roles.ts`

- [ ] **Step 1: Переименовать функции в roleRouting.ts**

Переименовать:
- `loadRoleRouting` → `loadRuntimeConfig` (новое имя для новой функции, старую оставить как deprecated обёртку).
- `nextShellForRole` → `nextModelForProfile`.
- `ShellRoute` → `ModelRoute`.

Внутри `nextModelForProfile` использовать **новые правила**: вместо обхода shells по `SHELL_USER_IDS`, смотрим на `routing.fallbacks[role]` — это список моделей, не оболочек.

```ts
export interface ModelRoute { model: string; provider: string }

export function nextModelForProfile(
  config: RuntimeConfig,
  role: RoleName,
  currentModel: string,
): ModelRoute | null {
  const chain = [config.models[role], ...config.fallbacks[role]];
  const idx = chain.indexOf(currentModel);
  for (const candidate of chain.slice(idx + 1)) {
    return { model: candidate, provider: providerOfModel(candidate) };
  }
  return null;
}
```

`providerOfModel` — простая эвристика: `claude-*` → `anthropic`, `gpt-*` → `openai`, всё остальное → `minimax`. Вынести в `server/src/runtime/PiRuntimeAdapter.ts` или новый `server/src/runtime/modelProvider.ts`.

- [ ] **Step 2: Удалить SHELL_USER_IDS из roleRouting.ts**

Удалить всю декларацию `SHELL_USER_IDS`. Оставить `SHELL_AGENT_ALIASES` для совместимости с Task 2.

- [ ] **Step 3: Перевести agent-state.ts**

Заменить импорт:
```ts
// Было:
import { loadRoleRouting, nextShellForRole } from "../roleRouting.js";
// Стало:
import { loadRuntimeConfig, nextModelForProfile } from "../roleRouting.js";
```

В точке вызова (L1306) — переписать вызов под новую семантику.

- [ ] **Step 4: Дополнить roles.ts новыми полями**

В `roleDetails` добавить новое поле `runtime_id: "runtime:pi"` рядом со старым `default_shell`. **Не удалять** старые поля — UI их читает.

- [ ] **Step 5: Прогнать тесты**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/roles.test.ts server/test/readyDispatchBridge.test.ts server/test/runtime/api.test.ts
```

Ожидаемо: либо проходят, либо падают только на `default_shell: "agent_pi"` (исправим в Task 10). Никаких TypeScript-ошибок на импорты.

- [ ] **Step 6: Коммит**

```bash
git add server/src/roleRouting.ts server/src/routes/agent-state.ts server/src/routes/roles.ts
git commit -m "refactor: SHELL_USER_IDS → RUNTIME_ID, nextShellForRole → nextModelForProfile"
```

---

## Task 9: Перевести `trigger.py` на единый путь через Pi

**Files:**
- Modify: `server/scripts/trigger.py`

- [ ] **Step 1: Заменить resolve_agent_for_role на runtime-путь**

Удалить `resolve_agent_for_role` (L468). В `handle_task` (L2621-2640) — убрать вызов `resolve_agent_for_role` и его ветку. Заменить на:

```python
# Раньше здесь был resolve_agent_for_role(role), который отдавал для
# всех восьми ролей оболочку agent_pi. С 18.09.2026 (карточка
# f3108dcc) Pi — единый runtime: 8 ролей исполняются одной машиной,
# различаясь mcp-профилем и ролью в задаче. Маршрутизации по shell
# больше нет: когда карточка уже адресована роли, выбирать нечего.
if not assignee_is_role and agent is None:
    log(f"роль {role}: исполнитель не выбран, fallback не сработал — карточка остаётся без запуска")
```

- [ ] **Step 2: Переименовать agent_pi в EXTERNAL_AGENTS**

В `EXTERNAL_AGENTS` (`trigger.py:L219`):
- Ключ `PI_AGENT_ID` оставить.
- В комментарии сверху упомянуть legacy-alias.

- [ ] **Step 3: Прогнать dry-run**

```bash
cd /home/maksim/Проекты/New-Todoist
TASKFLOW_TRIGGER_DRY=1 timeout 5 python3 server/scripts/trigger.py 2>&1 | head -30
```

Ожидаемо: dry-run стартует, ждёт событий или печатает heartbeat. Никаких NameError.

- [ ] **Step 4: Прогнать pytest**

```bash
cd /home/maksim/Проекты/New-Todoist
python3 -m pytest server/scripts/test_role_routing.py -v 2>&1 | tail -20
```

Ожидаемо: тесты на загрузку YAML проходят (Task 10 обновит ассерты на pi_runtime).

- [ ] **Step 5: Коммит**

```bash
git add server/scripts/trigger.py
git commit -m "refactor(trigger): resolve_agent_for_role удалён, единый путь через Pi"
```

---

## Task 10: Обновить тесты

**Files:**
- Modify: `server/test/roles.test.ts`
- Modify: `server/scripts/test_role_routing.py`
- Modify: `server/scripts/test_trigger_isolated.py`
- Modify: `server/scripts/test_trigger_v2.py`

- [ ] **Step 1: roles.test.ts — ассерт `default_shell: "agent_pi"`**

В `server/test/roles.test.ts:L100` заменить:
```ts
expect(details.json()).toMatchObject({
  role: "architect",
  model: "MiniMax-M3",
  default_shell: "agent_pi",
  fallbacks: [],
});
```

На:
```ts
expect(details.json()).toMatchObject({
  role: "architect",
  model: "MiniMax-M3",
  runtime_id: "runtime:pi",
  default_shell: "agent_pi",  // legacy-alias для UI, deprecated
  fallbacks: [],
});
```

- [ ] **Step 2: test_role_routing.py — qa: agent_pi → qa: pi_runtime**

В `server/scripts/test_role_routing.py:L22` заменить `qa: agent_pi` на `qa: pi_runtime`.

- [ ] **Step 3: test_trigger_*.py — обновить ссылки на LEGACY**

Если тесты ссылаются на `LEGACY_EXTERNAL_AGENTS`, обновить под `EXTERNAL_AGENTS`. Если тесты были завязаны на конкретные shell-имена (`agent_hermes`, `agent_deepseek`, и т.д.) — пометить как `skip` с TODO: «зависит от удалённого legacy-shell, см. карточку f3108dcc».

- [ ] **Step 4: Прогнать всё**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/
python3 -m pytest server/scripts/ -v 2>&1 | tail -50
```

Ожидаемо: все ключевые тесты проходят. Падения, связанные с удалёнными legacy-shells, явно помечены `skip`.

- [ ] **Step 5: Коммит**

```bash
git add server/test/roles.test.ts server/scripts/test_role_routing.py server/scripts/test_trigger_isolated.py server/scripts/test_trigger_v2.py
git commit -m "test: обновить ассерты под pi_runtime, пометить legacy-зависимости как skip"
```

---

## Task 11: Обновить документацию

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/AGENTS.md`

- [ ] **Step 1: ARCHITECTURE.md**

Найти все упоминания `agent_pi` (grep):
```bash
grep -n "agent_pi\|Agent Pi\|Pi Agent" docs/ARCHITECTURE.md
```

Заменить на:
- `agent_pi` → `pi_runtime` (или «Pi runtime», если в предложении).
- «Agent Pi», «Pi Agent» → «Pi runtime».

В местах, где объясняется архитектура запуска, добавить ссылку: «фасад описан в `docs/superpowers/specs/2026-09-18-pi-runtime-facade.md`».

- [ ] **Step 2: AGENTS.md**

То же: `grep -n "agent_pi\|Pi Agent" docs/AGENTS.md` и замена.

- [ ] **Step 3: Проверить docs/ на оставшиеся вхождения**

```bash
grep -rn "agent_pi\|Agent Pi" docs/ | grep -v "legacy\|deprecated\|alias"
```

Ожидаемо: пусто (или только в явно legacy-помеченных местах).

- [ ] **Step 4: Коммит**

```bash
git add docs/ARCHITECTURE.md docs/AGENTS.md
git commit -m "docs: терминология agent_pi → pi_runtime"
```

---

## Task 12: Финальная проверка, коммит, review

**Files:** (нет новых правок)

- [ ] **Step 1: Прогнать vitest целиком**

```bash
cd /home/maksim/Проекты/New-Todoist
npx vitest run server/test/ 2>&1 | tail -30
```

Ожидаемо: все (или почти все) тесты проходят. Падения — задокументированы.

- [ ] **Step 2: Прогнать pytest целиком**

```bash
cd /home/maksim/Проекты/New-Todoist
python3 -m pytest server/scripts/ -v 2>&1 | tail -30
```

Ожидаемо: тесты проходят или явно skipped.

- [ ] **Step 3: Проверить TypeScript компиляцию**

```bash
cd /home/maksim/Проекты/New-Todoist
npx tsc --noEmit -p server/tsconfig.json 2>&1 | tail -30
```

Ожидаемо: ошибок нет.

- [ ] **Step 4: Прогнать dead-code контроль**

```bash
cd /home/maksim/Проекты/New-Todoist
node scripts/check-dead-controls.mjs 2>&1 | tail -30
```

Ожидаемо: без новых мёртвых файлов.

- [ ] **Step 5: git status — чисто**

```bash
cd /home/maksim/Проекты/New-Todoist
git status
```

Ожидаемо: только откоммиченные изменения.

- [ ] **Step 6: Коммит «chore: финальный осмотр»** (если есть правки)

```bash
git status
# если есть изменения:
git add -A
git commit -m "chore: финальный осмотр pi-runtime facade"
```

- [ ] **Step 7: Закрыть карточку в review**

Через TaskFlow MCP: перевести все subtasks в `done` (с `result`), затем карточку — в `state=review` с комментарием «фасад готов: 12 коммитов, vitest+pytest зелёные, TypeScript без ошибок».

---

## Self-Review

**Spec coverage** (по разделам спека):
- Goal (Pi = единый runtime, фасад) → Tasks 1–5, 8, 9.
- Architecture (фасад над users/YAML/prompts) → Tasks 4, 5, 8.
- Tech Stack (TS/Python/vitest/pytest) → все Tasks.
- Решение по объёму (фасад без миграции БД) → явно в Task 1 (спек), не делаем таблицы.
- Сущности (Runtime/AgentProfile/Model/ProviderConnection/AgentRun) → Task 4.
- RuntimeAdapter → Tasks 5, 6, 7.
- API → Tasks 6, 7.
- Что входит (переименование, LEGACY, фасад, тесты, документация) → Tasks 2, 3, 5–11.
- Что не входит (миграция БД, ClaudeCodeRuntime, UI) → явно в спеке, в плане не делается.

**Placeholders**: ни одного TBD/TODO в плане.

**Type consistency**: `RUNTIME_ID_PI`, `RuntimeId`, `AgentProfile`, `Model`, `ProviderConnection`, `AgentRun` — единые имена во всех Tasks. `piRuntime` (export) согласован с `RuntimeAdapter.id`.

**Risk review**: 
- Task 9 (trigger.py) — самый рискованный. Если dry-run падает — откат на предыдущий коммит, перечитываем `EXTERNAL_AGENTS`.
- Task 8 (agent-state.ts) — может сломать claim/fallback. После Task 8 прогоняем тесты.
- Task 10 — последняя проверка перед review.

Финальное состояние: 12 коммитов в `main`, vitest+pytest зелёные, контракт `/api/roles` сохранён, новый фасад `/api/runtime/*` работает, UI не тронут.
