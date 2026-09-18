import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ModelRuntime,
  RpcClient,
  type JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import db from "../db.js";
import {
  ROLE_NAMES,
  SHELL_AGENT_IDS,
  loadRoleRouting,
  providerOfModel,
  type RoleName,
} from "../roleRouting.js";
import type {
  AgentAttempt,
  AgentProfile,
  AgentRun,
  AuthMethod,
  Model,
  ProviderConnection,
  Runtime,
} from "./types.js";
import { RUNTIME_ID_PI } from "./types.js";
import {
  UnsupportedInFacadeError,
  type ConnectProviderInput,
  type RuntimeAdapter,
  type StartRunInput,
  type StartRunResult,
} from "./RuntimeAdapter.js";
import { authSessionManager, type AuthSessionView } from "./AuthSession.js";
import {
  ModelNotAvailableError,
  RuntimeUnavailableError,
} from "./errors.js";

const ROLE_PROMPTS_DIR = process.env.TASKFLOW_ROLE_PROMPTS_DIR
  ?? path.join(process.cwd(), "scripts", "role-prompts");

const ROLE_PROFILES_DIR = process.env.TASKFLOW_ROLE_PROFILES_DIR
  ?? path.join(process.env.HOME ?? ".", ".pi", "agent", "taskflow-profiles");

// 18.09.2026 (правка SDK): вся самописная обвязка вокруг `pi auth check`
// / `pi --list-models` / `~/.pi/agent/auth.json` удалена. Источник
// правды — ModelRuntime из @earendil-works/pi-coding-agent.
//
// 18.09.2026 (доработка после ревью владельца): переписаны lifecycle
// AgentRun, sessionId, providers/models, OAuth. См. комментарии по месту.

type AuthStatus = Awaited<ReturnType<ModelRuntime["getProviderAuthStatus"]>>;
type SdkModel = ReturnType<ModelRuntime["getModels"]>[number];
type SdkProvider = ReturnType<ModelRuntime["getProviders"]>[number];

/** Singleton ModelRuntime. ModelRuntime.create() — асинхронный (поднимает
 *  каталог провайдеров, читает credentials, проверяет доступность
 *  моделей), поэтому держим его в lazy-переменной. */
let modelRuntime: ModelRuntime | null = null;

async function getModelRuntime(): Promise<ModelRuntime> {
  if (!modelRuntime) {
    try {
      modelRuntime = await ModelRuntime.create();
    } catch (error) {
      throw new RuntimeUnavailableError(
        `ModelRuntime.create() failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return modelRuntime;
}

/** Сбрасывает singleton — нужно тестам и после смены credentials, если
 *  SDK не увидел запись. */
export function resetModelRuntime(): void {
  modelRuntime = null;
}

/** Полный каталог моделей Pi (все модели, независимо от того,
 *  авторизован провайдер или нет). Именно каталог — источник правды для
 *  «модель существует» (спека §10, §14). Если каталог недоступен —
 *  RuntimeUnavailableError (503), а не пустой список. */
async function loadModelCatalog(): Promise<SdkModel[]> {
  const rt = await getModelRuntime();
  let all = rt.getModels() as readonly SdkModel[];
  if (all.length === 0) {
    try {
      await rt.refresh();
    } catch (error) {
      throw new RuntimeUnavailableError(
        `Pi model catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    all = rt.getModels() as readonly SdkModel[];
  }
  if (all.length === 0) {
    const err = rt.getError();
    // Пустой каталог без ошибки SDK — это легитимное «провайдеров/моделей
    // нет». Пустой каталог с ошибкой — Pi недоступен (503).
    if (err) throw new RuntimeUnavailableError(err);
  }
  return [...all];
}

function providerAuthMethods(provider: SdkProvider): AuthMethod[] {
  const methods: AuthMethod[] = [];
  const auth = (provider as unknown as {
    auth?: { apiKey?: unknown; oauth?: unknown };
  }).auth;
  if (auth?.apiKey) methods.push("api_key");
  if (auth?.oauth) methods.push("oauth");
  return methods;
}

function mapProviderStatus(status: AuthStatus): ProviderConnection["status"] {
  return status.configured ? "connected" : "disconnected";
}

interface ProfileConfig {
  mcpServers?: {
    taskflow?: {
      env?: Record<string, string>;
    };
  };
}

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
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as ProfileConfig;
    const tools = config.mcpServers?.taskflow?.env?.TASKFLOW_MCP_TOOLS;
    if (!tools) return [];
    return tools.split(",").map((t) => t.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function readRoleSkills(role: RoleName) {
  return db
    .prepare(
      `SELECT skill_name, description FROM role_skills WHERE role = ? ORDER BY skill_name`,
    )
    .all(role) as Array<{ skill_name: string; description: string | null }>;
}

function readRoleAccount(role: RoleName) {
  return db
    .prepare(
      `SELECT id, name, permissions, status, last_seen_at
         FROM users WHERE role = ? ORDER BY created_at LIMIT 1`,
    )
    .get(role) as
      | {
          id: string;
          name: string;
          permissions: string | null;
          status: string | null;
          last_seen_at: string | null;
        }
      | undefined;
}

/** userId, которого попытка будет записана как executor. По возможности —
 *  ролевая учётка; иначе shell-учётка pi_runtime; иначе любой ai-пользователь.
 *  null = записать attempt нельзя (нет пользователя), run всё равно идёт. */
function resolveExecutorId(role: string | null, agentId: string): string | null {
  if (role && (ROLE_NAMES as readonly string[]).includes(role)) {
    const account = readRoleAccount(role as RoleName);
    if (account) return account.id;
  }
  const shell = SHELL_AGENT_IDS[agentId] ?? SHELL_AGENT_IDS.pi_runtime;
  if (shell) {
    const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(shell) as
      | { id: string }
      | undefined;
    if (exists) return exists.id;
  }
  const anyAi = db
    .prepare(
      `SELECT id FROM users WHERE role IS NOT NULL OR type = 'ai'
        ORDER BY created_at LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  return anyAi?.id ?? null;
}

async function piAlive(): Promise<boolean> {
  try {
    const { unitState } = await import("../routes/agent-service.js");
    return (await unitState()).active;
  } catch {
    return false;
  }
}

async function buildProfile(
  role: RoleName,
  alive: boolean,
): Promise<AgentProfile> {
  const routing = loadRoleRouting();
  const account = readRoleAccount(role);
  const skills = readRoleSkills(role).map((s) => ({
    name: s.skill_name,
    description: s.description,
  }));
  const tools = readRoleTools(role);
  const prompt = readPromptSize(role);
  const work = db
    .prepare(
      `SELECT agent_state FROM tasks
        WHERE status = 'active' AND dispatched_role = ?
          AND agent_state IN ('in_progress', 'blocked')
        LIMIT 1`,
    )
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

// ===== Активные запуски (in-memory) =====

interface ActiveRun {
  runId: string;
  taskId: string;
  agentId: string;
  provider: string | null;
  model: string | null;
  sessionId: string | null;
  client: RpcClient;
  startedAt: string;
  retrying: boolean;
  cancelled: boolean;
  stopReason: string | null;
  settled: boolean;
  finish: Promise<void>;
}

const activeRuns = new Map<string, ActiveRun>();

/** Обновляет lastActivityAt/retry-маркеры из события. НЕ завершает run. */
function recordRunActivity(run: ActiveRun, event: { type: string; [k: string]: unknown }): void {
  switch (event.type) {
    case "agent_end": {
      // agent_end — промежуточное событие: Pi после него может сделать
      // retry, продолжить или уйти в compaction. run НЕ завершаем.
      const willRetry = event.willRetry === true;
      if (willRetry) {
        // Pi сам продолжит (retry). Ошибку/stopReason фиксировать рано:
        // retry может завершиться успешно, и run нельзя пометить failed.
        run.retrying = true;
        break;
      }
      const messages = event.messages;
      if (Array.isArray(messages)) {
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m && typeof m === "object" && (m as { role?: string }).role === "assistant") as
          | { stopReason?: string; errorMessage?: string }
          | undefined;
        if (lastAssistant?.stopReason === "error") {
          run.stopReason = lastAssistant.errorMessage ?? "error";
        } else if (lastAssistant?.stopReason === "aborted") {
          run.cancelled = true;
        }
      }
      break;
    }
    case "auto_retry_start":
      run.retrying = true;
      break;
    case "auto_retry_end":
      run.retrying = false;
      if (event.success === false) {
        run.stopReason = typeof event.finalError === "string"
          ? event.finalError
          : "retry_failed";
      }
      break;
    case "compaction_start":
    case "compaction_end":
    case "session_info_changed":
    case "message_update":
    case "message_end":
      // просто активность
      break;
    default:
      break;
  }
}

interface AttemptRow {
  id: string;
  model: string | null;
  provider: string | null;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  reason: string | null;
  session_id: string | null;
}

function mapAttemptStatus(row: AttemptRow): AgentAttempt["status"] {
  if (!row.ended_at) return "running";
  if (row.outcome === "cancelled") return "cancelled";
  if (row.outcome === "failed") return "failed";
  return "completed";
}

function attemptsForTask(taskId: string): AgentAttempt[] {
  const rows = db
    .prepare(
      `SELECT id, model, provider, started_at, ended_at, outcome, reason, session_id
         FROM attempts
        WHERE task_id = ? AND subtask_id IS NULL
        ORDER BY started_at ASC, rowid ASC`,
    )
    .all(taskId) as AttemptRow[];
  return rows.map((row) => ({
    id: row.id,
    model: row.model,
    provider: row.provider,
    status: mapAttemptStatus(row),
    outcome: row.outcome,
    started_at: row.started_at,
    finished_at: row.ended_at,
    reason: row.reason,
  }));
}

/** Закрывает ранее активную попытку задачи, чтобы partial unique index
 *  «одна активная попытка на задачу» не падал при повторном запуске. */
function closeActiveAttempts(taskId: string): void {
  db.prepare(
    `UPDATE attempts
        SET ended_at = datetime('now'),
            outcome = COALESCE(outcome, 'superseded')
      WHERE task_id = ? AND subtask_id IS NULL AND ended_at IS NULL`,
  ).run(taskId);
}

function createAttempt(input: {
  runId: string;
  taskId: string;
  executorId: string;
  model: string;
  provider: string | null;
  routingRole: string | null;
}): void {
  db.prepare(
    `INSERT INTO attempts
       (id, task_id, subtask_id, executor_id, runner, model, provider,
        routing_role, started_at)
     VALUES
       (@id, @taskId, NULL, @executorId, 'pi', @model, @provider,
        @routingRole, datetime('now'))`,
  ).run({
    id: input.runId,
    taskId: input.taskId,
    executorId: input.executorId,
    model: input.model,
    provider: input.provider,
    routingRole: input.routingRole,
  });
}

/** Итог run определяется НЕ boolean `success` (его в Pi нет), а
 *  stopReason / cancel / ошибкой. Pi event type не равен TaskFlow status. */
async function finalizeRun(run: ActiveRun, outcome: AgentRun["status"], stopReason: string | null): Promise<void> {
  if (run.settled) return;
  run.settled = true;

  const attemptOutcome = outcome === "completed"
    ? "completed"
    : outcome === "cancelled"
    ? "cancelled"
    : "failed";
  const nextState = outcome === "completed" ? "review" : "blocked";

  try {
    db.prepare(
      `UPDATE attempts
          SET ended_at = datetime('now'),
              outcome = ?,
              reason = ?,
              stop_reason = ?,
              session_id = COALESCE(?, session_id)
        WHERE id = ?`,
    ).run(attemptOutcome, stopReason, stopReason, run.sessionId, run.runId);
  } catch { /* задача/попытка могла быть удалена */ }

  try {
    db.prepare(
      `UPDATE tasks
          SET agent_state = ?,
              agent_finished_at = datetime('now'),
              stop_reason = ?,
              agent_session_id = COALESCE(agent_session_id, ?),
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(nextState, stopReason, run.sessionId, run.taskId);
  } catch { /* ignore */ }

  // client.stop() вызывается ТОЛЬКО здесь — не на agent_end. На agent_end
  // Pi может ещё продолжать (retry/compaction), гасить процесс нельзя.
  try {
    await run.client.stop();
  } catch { /* процесс уже умер — окей */ }

  activeRuns.delete(run.runId);
}

/** Определяет итоговый статус по наблюдаемым фактам (не по success). */
function resultStatus(run: ActiveRun): { outcome: AgentRun["status"]; reason: string | null } {
  if (run.cancelled) return { outcome: "cancelled", reason: "cancelled" };
  if (run.stopReason) return { outcome: "failed", reason: run.stopReason };
  return { outcome: "completed", reason: null };
}

export const piRuntime: RuntimeAdapter = {
  id: RUNTIME_ID_PI,

  async status(): Promise<Runtime> {
    const alive = await piAlive();
    return {
      id: RUNTIME_ID_PI,
      kind: "pi",
      status: alive ? "ready" : "down",
      version: process.env.PI_VERSION ?? "unknown",
      endpoint: process.env.PI_ENDPOINT ?? "cli",
    };
  },

  async listProfiles(): Promise<AgentProfile[]> {
    const alive = await piAlive();
    return Promise.all(ROLE_NAMES.map((r) => buildProfile(r, alive)));
  },

  async listModels(): Promise<Model[]> {
    // Каталог Pi — источник правды. Если Pi недоступен — 503, не [].
    const catalog = await loadModelCatalog();
    const rt = await getModelRuntime();

    const availableKeys = new Set<string>();
    try {
      const available = await rt.getAvailable();
      for (const m of available) {
        const sm = m as SdkModel;
        availableKeys.add(`${sm.provider}:${sm.id}`);
      }
    } catch {
      // Авторизационный снимок не собрался — каталог всё равно отдаём,
      // просто помечаем всё как недоступное. Это не «Pi недоступен».
    }

    const seen = new Set<string>();
    const models: Model[] = [];
    for (const m of catalog) {
      const sm = m as SdkModel;
      const key = `${sm.provider}:${sm.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({
        id: sm.id,
        provider: sm.provider,
        runtime_id: RUNTIME_ID_PI,
        available: availableKeys.has(key),
        name: sm.name,
        contextWindow: sm.contextWindow,
        maxTokens: sm.maxTokens,
        thinking: sm.reasoning,
        images: Array.isArray(sm.input) ? sm.input.includes("image") : undefined,
      });
    }
    return models;
  },

  async listProviders(): Promise<ProviderConnection[]> {
    let rt: ModelRuntime;
    try {
      rt = await getModelRuntime();
    } catch (error) {
      throw error instanceof RuntimeUnavailableError
        ? error
        : new RuntimeUnavailableError(String(error));
    }
    // Источник списка провайдеров — ModelRuntime.getProviders(), НЕ
    // checkAuth(). checkAuth отвечает «есть ли рабочая авторизация», а не
    // «существует ли провайдер». Неподключённые провайдеры обязаны
    // оставаться в UI (спека §9).
    let providers: readonly SdkProvider[];
    try {
      providers = rt.getProviders();
    } catch (error) {
      throw new RuntimeUnavailableError(
        `Pi providers unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const now = new Date().toISOString();
    return providers.map((p) => {
      let status: ProviderConnection["status"] = "disconnected";
      try {
        status = mapProviderStatus(rt.getProviderAuthStatus(p.id) as AuthStatus);
      } catch {
        status = "expired";
      }
      let authType: "api_key" | "oauth" | null = null;
      try {
        authType = (rt.checkAuth(p.id) as unknown as { type?: "api_key" | "oauth" })
          ?.type ?? null;
      } catch {
        authType = null;
      }
      return {
        id: p.id,
        name: p.name,
        runtime_id: RUNTIME_ID_PI,
        status,
        authType,
        authMethods: providerAuthMethods(p),
        managedBy: "pi" as const,
        lastCheckedAt: now,
      };
    });
  },

  async connectProvider(
    provider: string,
    body: ConnectProviderInput,
  ): Promise<ProviderConnection> {
    const apiKey = body.apiKey?.trim();
    if (!apiKey) {
      throw new Error(`apiKey required for ${provider}`);
    }
    const rt = await getModelRuntime();

    // Штатный persistent credential mechanism Pi: ModelRuntime.login с
    // типом api_key. Провайдер сам запрашивает ключ через interaction.prompt
    // (нам ключ уже известен — отдаём его), а SDK пишет credential в свой
    // CredentialStore (auth.json) через modify(). Runtime setRuntimeApiKey
    // для этого НЕ годится: он in-memory и умирает с процессом (спека §8).
    await rt.login(provider, "api_key", {
      signal: new AbortController().signal,
      notify: () => { /* api_key flow не эмитит событий */ },
      prompt: () => Promise.resolve(apiKey),
    } as never);

    const status = rt.getProviderAuthStatus(provider) as AuthStatus;
    if (!status.configured) {
      throw new Error(
        `api_key for ${provider} не сохранился: getProviderAuthStatus.configured=false`,
      );
    }
    const providerInfo = rt.getProvider(provider) as SdkProvider | undefined;
    return {
      id: provider,
      name: providerInfo?.name,
      runtime_id: RUNTIME_ID_PI,
      status: "connected",
      authType: "api_key",
      authMethods: providerInfo ? providerAuthMethods(providerInfo) : ["api_key"],
      managedBy: "pi",
      lastCheckedAt: new Date().toISOString(),
    };
  },

  async startAuthSession(provider: string): Promise<AuthSessionView> {
    const rt = await getModelRuntime();
    const session = authSessionManager.startOAuth(provider, rt);
    return session.toView();
  },

  getAuthSession(id: string): AuthSessionView | null {
    return authSessionManager.get(id)?.toView() ?? null;
  },

  submitAuthInput(id: string, value: string): void {
    authSessionManager.submitInput(id, value);
  },

  cancelAuthSession(id: string): void {
    authSessionManager.cancel(id);
  },

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    // 18.09.2026: startRun честно запускает выбранную model/provider через
    // официальный RpcClient. Возвращает реальный sessionId из
    // client.getState(). AgentRun завершается ТОЛЬКО по agent_settled.
    const task = db
      .prepare(
        `SELECT id, assignee_id, dispatched_role, role FROM tasks WHERE id = ?`,
      )
      .get(input.taskId) as
      | {
          id: string;
          assignee_id: string | null;
          dispatched_role: string | null;
          role: string | null;
        }
      | undefined;
    if (!task) {
      throw new Error(`task ${input.taskId} not found`);
    }

    const routing = loadRoleRouting();
    const role = task.dispatched_role ?? task.role ?? input.agentId;
    let provider = input.provider?.trim() || undefined;
    let model = input.model?.trim() || undefined;
    if (!model && role && (ROLE_NAMES as readonly string[]).includes(role)) {
      model = routing.models[role as RoleName];
    }
    if (!provider && model) {
      provider = providerOfModel(model);
    }

    // Модель обязана существовать в каталоге Pi. Различаем «Pi недоступен»
    // (RuntimeUnavailableError → 503) и «модели нет» (ModelNotAvailableError
    // → 422).
    const catalog = await loadModelCatalog();
    const match = catalog.find(
      (m) => m.id === model && (!provider || m.provider === provider),
    ) ?? catalog.find((m) => m.id === model);
    if (!match) {
      throw new ModelNotAvailableError(model ?? "(default)", provider ?? null);
    }
    provider = match.provider;
    model = match.id;

    const runId = `run_${crypto.randomUUID()}`;
    const client = new RpcClient({
      cliPath: process.env.PI_BIN_PATH ?? "/home/maksim/.local/bin/pi",
      cwd: process.cwd(),
      provider,
      model,
      // NODE_USE_ENV_PROXY=1 — без него Pi встроенный fetch игнорирует
      // HTTPS_PROXY и провайдеры отвечают 403 (гео-блок).
      env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
    });

    const executorId = resolveExecutorId(role, input.agentId);
    closeActiveAttempts(input.taskId);
    if (executorId) {
      try {
        createAttempt({
          runId,
          taskId: input.taskId,
          executorId,
          model,
          provider: provider ?? null,
          routingRole: (ROLE_NAMES as readonly string[]).includes(role) ? role : null,
        });
      } catch { /* attempt — не критично для запуска */ }
    }
    try {
      db.prepare(
        `UPDATE tasks
            SET current_attempt_id = ?, agent_state = 'in_progress',
                agent_started_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`,
      ).run(runId, input.taskId);
    } catch { /* ignore */ }

    const run: ActiveRun = {
      runId,
      taskId: input.taskId,
      agentId: input.agentId,
      provider: provider ?? null,
      model,
      sessionId: null,
      client,
      startedAt: new Date().toISOString(),
      retrying: false,
      cancelled: false,
      stopReason: null,
      settled: false,
      finish: Promise.resolve(),
    };
    activeRuns.set(runId, run);

    client.onEvent((event: JsonAgentSessionEvent) => {
      const e = event as unknown as { type: string; [k: string]: unknown };
      if (e.type === "session_start") {
        // Резервный источник sessionId, если getState() недоступен.
        const sid = (e as { sessionId?: string }).sessionId;
        if (typeof sid === "string" && sid && !run.sessionId) {
          run.sessionId = sid;
        }
        return;
      }
      if (e.type === "agent_settled") {
        const { outcome, reason } = resultStatus(run);
        void finalizeRun(run, outcome, reason);
        return;
      }
      // Всё остальное — активность, run не завершаем.
      recordRunActivity(run, e);
    });

    try {
      await client.start();
      // sessionId берём через getState(), а не ждём session_start.
      try {
        const state = await client.getState();
        if (state?.sessionId) run.sessionId = state.sessionId;
        // Проверяем, что Pi реально поднял запрошенную модель.
        const actual = state?.model as { provider?: string; id?: string } | undefined;
        if (actual?.id) {
          run.model = actual.id;
          run.provider = actual.provider ?? run.provider;
          db.prepare(
            `UPDATE attempts SET model = ?, provider = ? WHERE id = ?`,
          ).run(run.model, run.provider, runId);
        }
      } catch {
        // getState упал — sessionId останется из session_start (если был).
      }
      if (run.sessionId) {
        try {
          db.prepare(
            `UPDATE attempts SET session_id = ? WHERE id = ?`,
          ).run(run.sessionId, runId);
          db.prepare(
            `UPDATE tasks SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ?`,
          ).run(run.sessionId, input.taskId);
        } catch { /* ignore */ }
      }
      await client.prompt(input.prompt);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await finalizeRun(run, "failed", reason);
      throw new RuntimeUnavailableError(
        `Pi startRun failed for ${input.taskId}: ${reason}`,
      );
    }

    return {
      runId,
      sessionId: run.sessionId,
      status: "running",
    };
  },

  async sendMessage(_runId: string, _text: string): Promise<void> {
    throw new UnsupportedInFacadeError(
      "PiRuntimeAdapter.sendMessage() недоступен: диалог с запущенным " +
        "Pi-заходом ведётся через claim/message API карточки, а не через runtime.",
    );
  },

  async cancelRun(runId: string): Promise<void> {
    const run = activeRuns.get(runId);
    if (!run) {
      throw new UnsupportedInFacadeError(
        `PiRuntimeAdapter.cancelRun(${runId}): активный заход не найден. ` +
          "Отмена задачи — через /api/tasks/:id/cancel.",
      );
    }
    run.cancelled = true;
    try {
      await run.client.abort();
    } catch { /* процесс мог уже завершиться */ }
    await finalizeRun(run, "cancelled", "cancelled");
  },

  async getRun(runId: string): Promise<AgentRun> {
    // runId — это id попытки (attempts.id), уникальный на каждый запуск.
    const attempt = db
      .prepare(
        `SELECT a.id, a.task_id, a.executor_id, a.model, a.provider,
                a.session_id, a.started_at, a.ended_at, a.outcome, a.reason,
                t.dispatched_role, t.assignee_id, t.agent_session_id AS task_session
           FROM attempts a
           JOIN tasks t ON t.id = a.task_id
          WHERE a.id = ?`,
      )
      .get(runId) as
      | {
          id: string;
          task_id: string;
          executor_id: string;
          model: string | null;
          provider: string | null;
          session_id: string | null;
          started_at: string;
          ended_at: string | null;
          outcome: string | null;
          reason: string | null;
          dispatched_role: string | null;
          assignee_id: string | null;
          task_session: string | null;
        }
      | undefined;

    if (attempt) {
      return {
        id: attempt.id,
        task_id: attempt.task_id,
        agent_id: attempt.dispatched_role ?? attempt.assignee_id ?? "",
        runtime_id: RUNTIME_ID_PI,
        provider: attempt.provider,
        model: attempt.model,
        session_id: attempt.session_id ?? attempt.task_session,
        status: mapAttemptStatus(attempt as AttemptRow) === "running"
          ? "running"
          : mapAttemptStatus(attempt as AttemptRow) === "cancelled"
          ? "cancelled"
          : mapAttemptStatus(attempt as AttemptRow) === "failed"
          ? "failed"
          : "completed",
        started_at: attempt.started_at,
        finished_at: attempt.ended_at,
        stop_reason: attempt.reason,
        attempts: attemptsForTask(attempt.task_id),
      };
    }

    // Обратная совместимость: раньше runId был taskId. Планировщик/UI могли
    // звать getRun(taskId).
    const task = db
      .prepare(
        `SELECT id, assignee_id, dispatched_role, agent_session_id,
                agent_started_at, agent_finished_at, stop_reason, agent_state
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
      throw new Error(`AgentRun ${runId}: не найдена ни попытка, ни задача`);
    }
    return {
      id: `run_${task.id}`,
      task_id: task.id,
      agent_id: task.dispatched_role ?? task.assignee_id ?? "",
      runtime_id: RUNTIME_ID_PI,
      provider: null,
      model: null,
      session_id: task.agent_session_id,
      status:
        task.agent_state === "in_progress"
          ? "running"
          : task.agent_state === "review"
          ? "completed"
          : task.agent_state === "blocked"
          ? "failed"
          : "queued",
      started_at: task.agent_started_at ?? new Date().toISOString(),
      finished_at: task.agent_finished_at,
      stop_reason: task.stop_reason,
      attempts: attemptsForTask(task.id),
    };
  },
};

/** Множество id моделей из полного каталога Pi. Используется для валидации
 *  routing: несуществующая модель → 422, недоступный Pi → 503 (ловит роут). */
export async function getAvailableModelIds(): Promise<Set<string>> {
  const catalog = await loadModelCatalog();
  return new Set(catalog.map((m) => m.id));
}

/** Проверяет, что модель есть в каталоге Pi. */
export async function modelExists(id: string): Promise<boolean> {
  const ids = await getAvailableModelIds();
  return ids.has(id);
}
