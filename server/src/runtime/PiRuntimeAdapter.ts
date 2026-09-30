import { chatInstructionArgs } from "./instructionResources.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getPackageDir,
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
  roleTitle,
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
import {
  acquireChatRoleLock,
  releaseChatRoleLock,
  upsertChatSession,
  makeChatRunId,
} from "./chatSession.js";
import { authSessionManager, type AuthSessionView } from "./AuthSession.js";
import { prepareRoleRunAccess, releaseRoleRunAccess } from "./roleRunAccess.js";
import { composeLayer } from "../lib/roleContextResolver.js";
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

/** Путь к JS-энтрипоинту Pi для RpcClient. Важно: RpcClient спавнит
 *  `node <cliPath> --mode rpc`, поэтому это должен быть именно JS-файл
 *  (`dist/cli.js` из установленного SDK), а НЕ shell-обёртка
 *  `~/.local/bin/pi` — она для человека в терминале. Берём CLI из того же
 *  пакета, что и SDK, чтобы версии клиента и агента совпадали.
 *  PI_BIN_PATH — аварийный override. */
function resolvePiCliPath(): string {
  const override = process.env.PI_BIN_PATH?.trim();
  if (override) return override;
  return path.join(getPackageDir(), "dist", "cli.js");
}

/** Singleton ModelRuntime. ModelRuntime.create() — асинхронный (поднимает
 *  каталог провайдеров, читает credentials, проверяет доступность
 *  моделей), поэтому держим его в lazy-переменной. */
let modelRuntime: ModelRuntime | null = null;

export async function getModelRuntime(): Promise<ModelRuntime> {
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
         FROM users
        WHERE role_key = ? AND role = 'agent' AND type = 'ai'
        ORDER BY created_at LIMIT 1`,
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
    title: account?.name ?? roleTitle(role),
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

/** Последний фактический результат хода (turn). НЕтерминальный: нужен
 *  только чтобы отличить финальный провал от успеха в момент
 *  agent_settled. Успешная continuation/compaction перезаписывает его. */
interface TurnResult {
  stopReason: string | null;
  errorMessage: string | null;
}

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
  /** Последний ход. На agent_settled решает failed/completed. */
  lastTurn: TurnResult | null;
  settled: boolean;
  finish: Promise<void>;
  /** Временный файл подключения роли к трекеру — удаляется при завершении. */
  mcpConfigPath: string | null;
}

const activeRuns = new Map<string, ActiveRun>();

/** Достаёт результат последнего assistant-хода из agent_end.messages.
 *  Возвращает null, если ход не несёт терминального stopReason. */
function parseTurnResult(messages: unknown): TurnResult | null {
  if (!Array.isArray(messages)) return null;
  const lastAssistant = [...messages]
    .reverse()
    .find(
      (m) => m && typeof m === "object" && (m as { role?: string }).role === "assistant",
    ) as { stopReason?: string; errorMessage?: string } | undefined;
  if (!lastAssistant?.stopReason) return null;
  return {
    stopReason: lastAssistant.stopReason,
    errorMessage: lastAssistant.errorMessage ?? null,
  };
}

/** Обновляет активность/последний ход. НЕ завершает run и НЕ пишет
 *  терминальный итог: результат вычисляется только на agent_settled. */
function recordRunActivity(run: ActiveRun, event: { type: string; [k: string]: unknown }): void {
  switch (event.type) {
    case "agent_end": {
      // agent_end — промежуточное событие: Pi после него может сделать
      // retry, продолжить, выполнить compaction и снова запустить loop.
      // Никакого терминального stopReason/blocked/stop здесь быть не может.
      const willRetry = event.willRetry === true;
      if (willRetry) run.retrying = true;
      // Запоминаем фактический итог хода как НЕтерминальный — следующий
      // успешный ход (например, после compaction) перезапишет эту ошибку.
      const turn = parseTurnResult(event.messages);
      if (turn) run.lastTurn = turn;
      break;
    }
    case "auto_retry_start":
      run.retrying = true;
      break;
    case "auto_retry_end":
      run.retrying = false;
      if (event.success === false) {
        run.lastTurn = {
          stopReason: "error",
          errorMessage: typeof event.finalError === "string"
            ? event.finalError
            : "retry_failed",
        };
      } else {
        // Успешный retry снимает промежуточную ошибку.
        run.lastTurn = null;
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
  releaseRoleRunAccess(run.mcpConfigPath);

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
  if (nextState === "review") {
    // Дочерняя сдана — может, пора исполнять родителя (его свои пункты).
    void import("../routes/dispatch.js")
      .then((m) => m.admitParentAfterChildren(run.taskId))
      .catch((err) => console.warn("родитель после дочерней:", err));
  }

  // client.stop() вызывается ТОЛЬКО здесь — не на agent_end. На agent_end
  // Pi может ещё продолжать (retry/compaction), гасить процесс нельзя.
  try {
    await run.client.stop();
  } catch { /* процесс уже умер — окей */ }

  activeRuns.delete(run.runId);
}

/** Гарантия «один task = максимум один active Pi run». Проверяем именно
 *  in-memory activeRuns (по taskId), а не только БД: closeActiveAttempts()
 *  закрывает запись, но оставшийся процесс Pi продолжал бы работать и
 *  позже перезаписал состояние задачи. Предыдущий run штатно отменяем
 *  (это безопаснее 409 для сценариев retry/fallback). */
async function cancelActiveRunsForTask(taskId: string): Promise<void> {
  const running = [...activeRuns.values()].filter(
    (run) => run.taskId === taskId && !run.settled,
  );
  for (const run of running) {
    run.cancelled = true;
    try {
      await run.client.abort();
    } catch { /* процесс мог уже завершиться */ }
    await finalizeRun(run, "cancelled", "cancelled");
  }
}

/** Итог вычисляется ТОЛЬКО на agent_settled. Единственный источник
 *  «плохого» исхода — явная отмена (cancelRun) или последний фактический
 *  ход с stopReason error/aborted. Промежуточные agent_end эту функцию не
 *  зовут. */
function resultStatus(run: ActiveRun): { outcome: AgentRun["status"]; reason: string | null } {
  if (run.cancelled) return { outcome: "cancelled", reason: "cancelled" };
  const turn = run.lastTurn;
  if (turn?.stopReason === "error") {
    return { outcome: "failed", reason: turn.errorMessage ?? "error" };
  }
  if (turn?.stopReason === "aborted") {
    return { outcome: "cancelled", reason: "aborted" };
  }
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
    // Доступ роли к трекеру — пропуск, подписанный сервером, во временном
    // файле подключения (см. roleRunAccess.ts): ключи из хранилища не нужны.
    const mcpConfigPath = prepareRoleRunAccess(runId, role);
    const client = new RpcClient({
      cliPath: resolvePiCliPath(),
      cwd: input.cwd ?? process.cwd(),
      ...(mcpConfigPath ? { args: ["--mcp-config", mcpConfigPath, ...await chatInstructionArgs(role,mcpConfigPath)] } : {}),
      provider,
      model,
      // NODE_USE_ENV_PROXY=1 — без него Pi встроенный fetch игнорирует
      // HTTPS_PROXY и провайдеры отвечают 403 (гео-блок).
      env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
    });

    // Один task = максимум один active Pi run: гасим предыдущий процесс.
    await cancelActiveRunsForTask(input.taskId);

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
    // Снимок effective system prompt на старте попытки (дизайн §8):
    // если у роли есть override слоёв prompt/rules/local_policy — он
    // идёт в Pi через тот же путь, что и в inProcessRun. Здесь тот же
    // composeLayer(), чтобы UI и in-process показывали одну и ту же
    // effective-версию.
    if ((ROLE_NAMES as readonly string[]).includes(role)) {
      try {
        const composed = [
          composeLayer(role, "role.prompt")?.effective || "",
          composeLayer(role, "local_policy")?.effective || "",
        ]
          .filter(Boolean)
          .join("\n\n");
        db.prepare(
          "UPDATE attempts SET system_prompt_snapshot = ? WHERE id = ?",
        ).run(composed, runId);
        db.prepare(
          "UPDATE tasks SET composed_prompt_snapshot = ? WHERE id = ?",
        ).run(composed, input.taskId);
      } catch { /* колонки ещё нет — после миграции 081 */ }
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
      lastTurn: null,
      settled: false,
      finish: Promise.resolve(),
      mcpConfigPath,
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

// ===== Живая онлайн-сессия Пи для чата (Этап 2 плана от 21.09.2026) =====
//
// Та же машинерия, что у startRun (RpcClient, провайдер/модель из routing,
// валидация каталога), но БЕЗ taskId/attempt/claim/agent_state. Никаких
// попыток в attempts, никаких правок tasks.agent_state, никакой аренды.
// Онлайн-сессия Пи живёт параллельно карточкам: карточка про свой путь
// (claim→heartbeat→review), чат про свой (чат→чат→чат). Это и есть
// «изоляция» из требований плана.
//
// Состояние сессии — в chat_sessions (chat_id, role_id) → pi_session_id,
// одна строка на пару. In-memory `activeChatRuns` — только рантайм-лок,
// чтобы не словить гонку «два сообщения подряд на одну пару». После
// рестарта процесса карта пуста, но sessionId в таблице сохраняется и
// следующее сообщение продолжает контекст.

/** Аргументы старта живой сессии Пи в чате. Никакого taskId — чат живёт
 *  отдельной осью, карточки и аренда остаются нетронутыми. */
export interface StartChatRunInput {
  chatId: string;
  role: RoleName;
  /** id ролевой учётки (role_<role>) — будет автором сообщения-ответа. */
  roleId: string;
  prompt: string;
  /** Сохранённый ранее pi_session_id — продолжит ту же сессию. Если
   *  null/undefined — стартует новую. */
  sessionId?: string | null;
  /** Общий потолок на один ход (стена сверху). По умолчанию 30 минут.
   *  Обрывает ход раньше не он, а тишина — см. idleMs. */
  timeoutMs?: number;
  /** Сколько роль может молчать (ни одного события рантайма), прежде чем
   *  ход оборвётся. По умолчанию 3 минуты. Пока идёт вызов инструмента
   *  (длинная команда, сборка), тишина не считается — такой ход ограничен
   *  только общим потолком. */
  idleMs?: number;
  /** Сырые события рантайма хода — для живого хода в окне чата
   *  (chatLiveTurn.ts). Необязательный. */
  onEvent?: (event: unknown) => void;
  /** Вызывается на каждом начале использования инструмента в ходе — для
   *  живой ленты «что роль делает сейчас» в чате (owner UI). Необязательный:
   *  вызовы без колбэка (если такие появятся) работают как раньше. */
  onStep?: (tool: string) => void;
}

/** Результат одного захода онлайн-сессии: runId живёт в логах, sessionId
 *  сохраняется в chat_sessions, text — ответ ассистента для укладки в
 *  chat_messages (может быть пустой строкой — это легитимный ответ). */
export interface StartChatRunResult {
  runId: string;
  sessionId: string | null;
  text: string;
}

/** Активная онлайн-сессия чата. Только рантайм-лок; источник правды
 *  по sessionId — таблица chat_sessions. */
interface ActiveChatRun {
  runId: string;
  chatId: string;
  role: RoleName;
  roleId: string;
  client: RpcClient;
  startedAt: string;
  cancelled: boolean;
}

const activeChatRuns = new Map<string, ActiveChatRun>();

/** Стандартные лимиты на одну онлайн-сессию. Документированы как константы,
 *  чтобы тесты могли на них опереться, а продакшен подменить через
 *  переменные окружения при росте нагрузки. */
//
// Владелец 27.09.2026: прежние «60 секунд на весь ход» обрывали роль посреди
// работы (в журнале — «Timeout collecting events» у Секретаря и QA), причём
// молча. Теперь ход живёт, пока роль что-то делает: обрыв — только по
// тишине (idle) или по общему потолку (ceiling), и о нём пишется в чат.
export const CHAT_RUN_IDLE_MS = 3 * 60_000;
export const CHAT_RUN_CEILING_MS = 30 * 60_000;

function resolveChatRunTimeout(override?: number): number {
  const raw =
    override && override > 0
      ? override
      : Number(process.env.TASKFLOW_CHAT_RUN_TIMEOUT_MS) || CHAT_RUN_CEILING_MS;
  return Math.min(raw, CHAT_RUN_CEILING_MS);
}

function resolveChatRunIdle(override?: number): number {
  return override && override > 0
    ? override
    : Number(process.env.TASKFLOW_CHAT_RUN_IDLE_MS) || CHAT_RUN_IDLE_MS;
}

/** Ход оборван сторожем: code = CHAT_RUN_IDLE (тишина) или
 *  CHAT_RUN_CEILING (общий потолок). limitMs — сработавший предел. */
export class ChatRunTimeoutError extends Error {
  readonly code: "CHAT_RUN_IDLE" | "CHAT_RUN_CEILING";
  readonly limitMs: number;
  constructor(code: "CHAT_RUN_IDLE" | "CHAT_RUN_CEILING", limitMs: number) {
    super(
      code === "CHAT_RUN_IDLE"
        ? `ход роли оборван: ${limitMs} мс без событий`
        : `ход роли оборван: превышен потолок ${limitMs} мс`,
    );
    this.name = "ChatRunTimeoutError";
    this.code = code;
    this.limitMs = limitMs;
  }
}

/** Снять все активные онлайн-сессии Пи — единственная «глобальная» кнопка.
 *  Нужна для тестов и для аварийной остановки; в проде процесс один и
 *  сервис не перезапускают ради одного чата. */
export async function stopAllChatRuns(): Promise<void> {
  const runs = [...activeChatRuns.values()];
  for (const run of runs) {
    run.cancelled = true;
    try {
      await run.client.abort();
    } catch { /* процесс мог уже завершиться */ }
    releaseChatRoleLock(run.chatId, run.roleId);
  }
  activeChatRuns.clear();
}

/** Живая онлайн-сессия Пи в чате. Не трогает attempts/tasks/agent_state;
 *  ответ сохраняется в chat_messages отдельно (вызывающей стороной —
 *  routes/chats.ts), здесь только RpcClient, валидация и сохранение
 *  pi_session_id в chat_sessions.
 *
 *  Жизненный цикл:
 *    1. Захватываем слот (chat, role) — если уже занят, ошибка «живая
 *       сессия уже идёт», без ожидания: параллельный ход для одной роли в
 *       одном чате не нужен и будет просто дороже по токенам.
 *    2. Валидируем роль и модель в каталоге (тот же путь, что у startRun).
 *    3. Поднимаем RpcClient: если есть сохранённый sessionId — передаём
 *       `--session-id` через args, иначе Pi создаст сессию сам и отдаст
 *       id через getState().
 *    4. Шлём promptAndWait(prompt, timeoutMs): один ответ на одно
 *       сообщение. timeoutMs ограничивает общий wall-time; Pi сам
 *       следит за retry/compaction, наш потолок — сверху.
 *    5. Достаём финальный текст через getLastAssistantText (Pi хранит
 *       свою историю сообщений и возвращает последний assistant turn).
 *    6. Апсёртим sessionId в chat_sessions, отдаём результат.
 *    7. Освобождаем слот в любом исходе (finally) — чтобы ошибка одного
 *       хода не подвешивала дальнейшие. */
export async function startChatRun(
  input: StartChatRunInput,
): Promise<StartChatRunResult> {
  const role: RoleName = input.role;
  if (!(ROLE_NAMES as readonly string[]).includes(role)) {
    throw new Error(`startChatRun: неизвестная роль «${role}»`);
  }
  if (!acquireChatRoleLock(input.chatId, input.roleId)) {
    // code = CHAT_RUN_BUSY: ход этой роли в этом чате уже идёт и ответит
    // сам — вызывающая сторона молчит, а не пишет в чат об ошибке.
    throw Object.assign(
      new Error(
        `startChatRun: для пары (chat=${input.chatId}, role=${input.roleId}) ` +
          `уже идёт живая сессия — дождитесь ответа или отмените её`,
      ),
      { code: "CHAT_RUN_BUSY" },
    );
  }

  const runId = makeChatRunId();
  const client: RpcClient | null = null;
  let mcpConfigPath: string | null = null;
  // Инициализируем фиктивной ссылкой — реальный client создаётся после
  // успешной валидации модели; в блоке finally смотрим на activeChatRuns.
  void client;

  try {
    // Модель/провайдер берём из routing роли — ровно как в startRun.
    // Различие: input.provider/model не предусмотрены, чат ходит всегда
    // на «своей» для роли модели (маркировка роли и есть намерение).
    const routing = loadRoleRouting();
    const model = routing.models[role];
    const provider = providerOfModel(model);

    const catalog = await loadModelCatalog();
    const match =
      catalog.find(
        (m) => m.id === model && m.provider === provider,
      ) ?? catalog.find((m) => m.id === model);
    if (!match) {
      throw new ModelNotAvailableError(model, provider);
    }
    const resolvedProvider = match.provider;
    const resolvedModel = match.id;

    // Доступ роли к трекеру — пропуск, подписанный сервером, во временном
    // файле подключения (см. roleRunAccess.ts). Роль в чате подключается
    // своей учёткой и своим набором инструментов, а не личным MCP-конфигом
    // владельца (владелец 25.09.2026: роли в чате — те же агенты, что и в
    // карточках, без ассоциации с Pi Agent).
    mcpConfigPath = prepareRoleRunAccess(runId, role);
    const args: string[] = [];
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath, ...await chatInstructionArgs(role,mcpConfigPath));
    }
    if (input.sessionId) {
      // --session-id продолжает РОВНО ту сессию, что у нас в таблице.
      // Если по какой-то причине сессия была удалена из Pi — Pi создаст
      // новую с тем же id (по спецификации CLI), и мы её же и запишем
      // обратно в chat_sessions. Это поведение совпадает с
      // ожиданием «следующее сообщение продолжает тот же контекст».
      args.push("--session-id", input.sessionId);
    }

    const newClient = new RpcClient({
      cliPath: resolvePiCliPath(),
      cwd: process.cwd(),
      provider: resolvedProvider,
      model: resolvedModel,
      // NODE_USE_ENV_PROXY=1 — без него встроенный fetch Pi игнорирует
      // HTTPS_PROXY и провайдеры отвечают 403 (гео-блок).
      env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
      args,
    });

    const run: ActiveChatRun = {
      runId,
      chatId: input.chatId,
      role,
      roleId: input.roleId,
      client: newClient,
      startedAt: new Date().toISOString(),
      cancelled: false,
    };
    activeChatRuns.set(runId, run);

    // Сторож тишины: каждое событие рантайма — признак жизни. Пока идёт
    // вызов инструмента, тишина не копится (команда может честно работать
    // минуты), ход держит только общий потолок.
    const idleMs = resolveChatRunIdle(input.idleMs);
    const runningTools = new Set<string>();
    let lastActivity = Date.now();
    let watchdogFired: ChatRunTimeoutError | null = null;
    let rejectWatchdog: (error: ChatRunTimeoutError) => void = () => {};
    const watchdog = new Promise<never>((_, reject) => {
      rejectWatchdog = reject;
    });
    watchdog.catch(() => {});

    // Итог последнего хода модели (как у задач — recordRunActivity): без
    // него ошибка провайдера («Request timed out», 30.09.2026) давала
    // пустой текст, и роль в чате просто молчала.
    const turnState: { last: TurnResult | null } = { last: null };

    newClient.onEvent((event: JsonAgentSessionEvent) => {
      lastActivity = Date.now();
      const e = event as { type: string; toolCallId?: string };
      const raw = event as unknown as { type: string; messages?: unknown; success?: unknown; finalError?: unknown };
      if (raw.type === "agent_end") {
        const turn = parseTurnResult(raw.messages);
        if (turn) turnState.last = turn;
      } else if (raw.type === "auto_retry_end") {
        turnState.last = raw.success === false
          ? {
              stopReason: "error",
              errorMessage: typeof raw.finalError === "string" ? raw.finalError : "retry_failed",
            }
          : null;
      }
      if (e.type === "tool_execution_start" && e.toolCallId) {
        runningTools.add(e.toolCallId);
      } else if (e.type === "tool_execution_end" && e.toolCallId) {
        runningTools.delete(e.toolCallId);
      }
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "toolcall_start"
      ) {
        input.onStep?.(event.assistantMessageEvent.toolName);
      }
      try {
        input.onEvent?.(event);
      } catch (error) {
        // Живая лента — украшение, её сбой не должен ронять ход роли.
        console.warn("[chats] onEvent живого хода упал:", error);
      }
    });

    let finalText = "";
    let finalSessionId: string | null = input.sessionId ?? null;
    const timeoutMs = resolveChatRunTimeout(input.timeoutMs);
    const idleTimer = setInterval(() => {
      if (watchdogFired || runningTools.size > 0) return;
      if (Date.now() - lastActivity < idleMs) return;
      watchdogFired = new ChatRunTimeoutError("CHAT_RUN_IDLE", idleMs);
      newClient.abort().catch(() => {});
      rejectWatchdog(watchdogFired);
    }, Math.min(5_000, Math.max(50, Math.floor(idleMs / 4))));

    try {
      await newClient.start();
      // Сессия могла стартовать с нашим sessionId (resume) или с новым
      // (Pi создал сам). Реальный id берём через getState(), а не
      // session_start — тот же путь, что в startRun: getState()
      // надёжнее.
      try {
        const state = await newClient.getState();
        const sid = (state as { sessionId?: string } | null)?.sessionId;
        if (sid) finalSessionId = sid;
      } catch { /* getState() упал — оставим то, что было */ }
      // Один user message = один ответ. promptAndWait блокирует до
      // agent_settled; сверху — общий потолок timeoutMs, сбоку — сторож
      // тишины (он прерывает ход раньше, если роль замолчала).
      try {
        await Promise.race([
          newClient.promptAndWait(input.prompt, undefined, timeoutMs),
          watchdog,
        ]);
      } catch (error) {
        if (run.cancelled) throw chatRunCancelledError();
        if (watchdogFired) throw watchdogFired;
        if (error instanceof Error && /^Timeout collecting events/.test(error.message)) {
          newClient.abort().catch(() => {});
          throw new ChatRunTimeoutError("CHAT_RUN_CEILING", timeoutMs);
        }
        throw error;
      }
      try {
        const text = await newClient.getLastAssistantText();
        finalText = (text ?? "").trim();
      } catch { /* нет ассистентского хода — оставим пустую строку */ }
      if (run.cancelled) throw chatRunCancelledError();
      const lastTurn = turnState.last;
      if (!finalText && lastTurn?.stopReason === "error") {
        throw Object.assign(
          new Error(lastTurn.errorMessage || "модель вернула ошибку"),
          { code: "CHAT_RUN_MODEL_ERROR" },
        );
      }
    } finally {
      clearInterval(idleTimer);
      // Останавливать процесс ОБЯЗАТЕЛЬНО, иначе каждый user-message
      // оставит висеть по zombie-RpcClient. На повторное использование
      // не рассчитываем — на следующее сообщение поднимем свежий client.
      try {
        await newClient.stop();
      } catch { /* процесс уже умер — окей */ }
      activeChatRuns.delete(runId);
    }

    if (finalSessionId) {
      // Сохраняем pi_session_id ДЛЯ СЛЕДУЮЩЕГО СООБЩЕНИЯ. Это
      // единственная запись в БД, которую делает онлайн-сессия —
      // tasks/attempts/agent_state остаются нетронутыми.
      upsertChatSession(input.chatId, input.roleId, finalSessionId);
    }

    return { runId, sessionId: finalSessionId, text: finalText };
  } finally {
    releaseRoleRunAccess(mcpConfigPath);
    releaseChatRoleLock(input.chatId, input.roleId);
  }
}

/** Отменить активную онлайн-сессию. Используется, когда владелец явно
 *  прервал разговор (например, через «Стоп» в UI). Неизвестный runId —
 *  no-op (тихий отказ), а не 404: вызывающая сторона могла опоздать
 *  с отменой, и упасть на чужой гонке — хуже, чем промолчать. */
export async function cancelChatRun(runId: string): Promise<boolean> {
  const run = activeChatRuns.get(runId);
  if (!run) return false;
  run.cancelled = true;
  try {
    await run.client.abort();
  } catch { /* процесс мог уже завершиться */ }
  // activeChatRuns сам себя почистит в finally startChatRun, но
  // освободим слот сразу — чтобы следующее сообщение могло стартовать
  // новую сессию, не дожидаясь финала cleanup.
  activeChatRuns.delete(runId);
  releaseChatRoleLock(run.chatId, run.roleId);
  return true;
}

/** Ход, остановленный владельцем: вызывающая сторона кладёт в чат то,
 *  что роль успела написать, а не сообщение об ошибке. */
function chatRunCancelledError(): Error {
  return Object.assign(new Error("ход остановлен владельцем"), {
    code: "CHAT_RUN_CANCELLED",
  });
}

/** Остановить идущие ходы в чате: всех ролей или одной (roleId). Кнопка
 *  «Остановить» в окне чата. Возвращает число остановленных ходов. */
export async function cancelChatRunsFor(chatId: string, roleId?: string): Promise<number> {
  const runs = [...activeChatRuns.values()].filter(
    (run) => run.chatId === chatId && (!roleId || run.roleId === roleId),
  );
  let stopped = 0;
  for (const run of runs) {
    if (await cancelChatRun(run.runId)) stopped += 1;
  }
  return stopped;
}

/** Тестовая утилита: сбросить in-memory карту активных чат-сессий и
 *  локи. В проде не нужна — после рестарта процесса всё и так пусто. */
export function _resetActiveChatRunsForTests(): void {
  activeChatRuns.clear();
}
