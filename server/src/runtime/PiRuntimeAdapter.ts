import { TASK_CHAT_FILE_TOOLS, TASK_CHAT_MODE } from "./taskChatTools.js";
import {chatTurnSystemText,installSecretarySystem,chatUserTurnText,chatRuntimeGuidanceEnabled} from "./secretaryChatPrompt.js";
import {installProviderDiagnostics, installProxyAwareGlobalFetch, registerProviderSession, observeProviderRetries} from "./providerDiagnostics.js";
import { captureBash, withFileChanges } from "../lib/toolFileCapture.js";
import { localCaptureIO } from "../lib/localCaptureIO.js";
import {supportedThinkingLevels,validateChatThinking,thinkingLevelLabels} from "./thinkingLevels.js";
import {safelyCaptureBudgetCases,budgetContinuationPrompt} from "./chatBudgetCases.js";
import { resolveChatWorkspace } from "../lib/chatWorkspace.js";
import { MemoryConsultationGuard } from "./memoryConsultationGuard.js";
import { ensurePlanItemClosed } from "./chatPlanClose.js";
import { PlanHintGuard, assistantTextOf } from "./chatPlanHints.js";
import { ChatPreparationDeadline } from "./chatPreparationDeadline.js";
import {chatExecutionMode,chatExecutionInstruction} from "./chatExecutionMode.js";
import {installSteeringBoundary} from "./steeringBoundary.js";
import {ThrashGuard, stepDigest} from "./thrashGuard.js";
import {registerChatSteering,_resetChatSteeringForTests} from "./chatSteering.js";
import {
  buildRoleToolCatalog,
  installNativeToolCore,
  installNativeToolSchemas,
  ROLE_TOOL_INSTRUCTION,
} from "./roleToolCatalog.js";
import { secretaryThings3Tools } from "./secretaryThings3Tools.js";
import { connectRoleMcp } from "./graftMcp.js";
import {
  chatModeInstruction,
  GOAL_MARK,
  goalStatus,
  PLANNING_TOOLS,
  stripGoalMark,
  type ChatWorkMode,
} from "./chatWorkMode.js";
import { getSetting } from "../lib/serverSettings.js";
import { filterByZenCatalog, zenModelIds } from "../lib/zenModelCatalog.js";
import { reserveChatItemAction, guardChatActions, assertChatBudgetAtTurnEnd } from "./chatActionBudget.js";
import { chatWorkPlanPrompt, stopChatWorkPlan } from "../lib/subtaskWorkPlan.js";
import {
  chatInstructionArgs,
  chatSystemPrompt,
  createTaskResourceLoader,
} from "./instructionResources.js";
import { parseModelRef } from "../lib/attemptModel.js";
import { resolveCatalogModel } from "./modelCatalog.js";
import { closeChatSession, measureChatSession, openChatSession } from "./chatContextUsage.js";
import { providerAvailable } from "../lib/modelLadder.js";
import { connectRoleComposio } from "./composioRuntime.js";
import {
  ensureRoleHome,
  prepareChatSessionDirectory,
  roleHome,
} from "./roleHome.js";
import { homedir } from "node:os";
import type { CliAgentSession } from "./cliAgentSession.js";
import { createExternalAgentSession } from "./externalAgentSession.js";
import { externalAgentBoost } from "./externalAgentActions.js";
import { agentBinary } from "../lib/externalAgents.js";
import { roleRunToken } from "./roleRunAccess.js";
import { externalRuntime, roleUserId } from "../roleRouting.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  SessionManager,
  SettingsManager,
  getPackageDir,
  ModelRuntime,
  RpcClient,
  type JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import db from "../db.js";
import {
  ROLE_NAMES,
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
import { currentChatGeneration } from "./chatQueue.js";
import { authSessionManager, type AuthSessionView } from "./AuthSession.js";
import { prepareRoleRunAccess, releaseRoleRunAccess } from "./roleRunAccess.js";
import { composeLayer } from "../lib/roleContextResolver.js";
import { ModelNotAvailableError, RuntimeUnavailableError } from "./errors.js";

const ROLE_PROFILES_DIR =
  process.env.TASKFLOW_ROLE_PROFILES_DIR ??
  path.join(process.env.HOME ?? ".", ".pi", "agent", "taskflow-profiles");

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
let modelRuntimePending: Promise<ModelRuntime> | null = null;
let catalogRefreshPending: Promise<void> | null = null;
let catalogRefreshAfter = 0;

/** Demand-driven refresh: no credentials leave the SDK; failed providers retain cached models. */
async function refreshConnectedCatalog(rt: ModelRuntime): Promise<void> {
  if (catalogRefreshPending) return catalogRefreshPending;
  if (Date.now() < catalogRefreshAfter) return;
  catalogRefreshPending = (async () => {
    try {
      const providers = rt.getProviders().filter(p =>
        p.id === "opencode" || rt.getProviderAuthStatus(p.id).configured,
      ).map(p => p.id);
      const result = await rt.refresh({
        allowNetwork: true, providers, signal: AbortSignal.timeout(15_000),
      });
      if (result?.aborted || result?.errors?.size) throw new Error("Provider catalog refresh incomplete");
      catalogRefreshAfter = Date.now() + 6 * 60 * 60 * 1000;
    } catch {
      catalogRefreshAfter = Date.now() + 5 * 60 * 1000;
      console.warn("model-catalog: refresh failed; retaining cached catalog, retry in five minutes");
      // Persistent daily deduplication survives process restarts.
      try {
        const type = "model_catalog_watch";
        const recent = db.prepare("SELECT 1 FROM notifications WHERE type=? AND created_at > datetime(?,?) LIMIT 1").get(type, "now", "-1 day");
        const owner = db.prepare("SELECT id FROM users WHERE role=? AND COALESCE(archived,0)=0 LIMIT 1").get("owner") as { id: string } | undefined;
        if (!recent && owner) db.prepare("INSERT INTO notifications (id,user_id,type,text) VALUES (?,?,?,?)").run(
          crypto.randomUUID(), owner.id, type,
          "Не удалось обновить каталог моделей провайдеров. Выбор использует сохранённый список; новые модели могут отсутствовать. Повтор через 5 минут. Проверьте доступность провайдеров и журнал сервера.",
        );
      } catch (error) { console.warn("model-catalog: watcher notification failed", error instanceof Error ? error.message : "unknown"); }
    }
  })().finally(() => { catalogRefreshPending = null; });
  return catalogRefreshPending;
}


export async function getModelRuntime(): Promise<ModelRuntime> {
  if (modelRuntime) return modelRuntime;
  modelRuntimePending ??= (async () => {
    try {
      const rt = await ModelRuntime.create();
      installProviderDiagnostics(rt);
      installProxyAwareGlobalFetch();
      modelRuntime = rt;
      return rt;
    } catch (error) {
      throw new RuntimeUnavailableError(
        `ModelRuntime.create() failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally { modelRuntimePending = null; }
  })();
  return modelRuntimePending;
}

/** Сбрасывает singleton — нужно тестам и после смены credentials, если
 *  SDK не увидел запись. */
export function resetModelRuntime(): void {
  modelRuntime = null;
  modelRuntimePending = null;
  catalogRefreshPending = null;
  catalogRefreshAfter = 0;
}

/** Какой уровень размышлений сервер передаёт в `createAgentSession` по
 *  фактической capability модели.
 *
 *  - reasoning модель → `null` (не передаём опцию): SDK сам возьмёт
 *    `medium` из defaults и для новой сессии запишет в jsonl; для
 *    resumed с persisted `"off"` миграция ниже (setThinkingLevel +
 *    persist) поднимет до `medium` и обновит jsonl.
 *  - не-reasoning → `"off"` explicit: SDK запишет в jsonl и для
 *    resumed, и для новой. Даже если persisted в чужой сессии был
 *    `"medium"`, мы фиксируем `"off"` и провайдер не получит
 *    `reasoning.effort`.
 *
 *  Владелец 02.10.2026: жёсткое `"off"` для всех моделей гасило
 *  thinking в чате. MAK-121 (chat/work расхождение): inProcessRun раньше
 *  ставил `"off"` для ЛЮБОЙ модели, PiRuntimeAdapter чата — только
 *  для deep_research, и resumed-сессии с persisted `"off"` оставались
 *  без размышлений.
 */
export function resolveThinkingLevel(
  model: { reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> } | null | undefined,
  role?: string,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null {
  if (!model?.reasoning) return "off";
  // Legacy callers without a role keep SDK defaults.
  if (!role) return null;
  const config = JSON.parse(fs.readFileSync(new URL("../../scripts/role-thinking.json", import.meta.url), "utf8"));
  const requested = config.roles?.[role] ?? config.default;
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  if (!levels.includes(requested)) throw new Error("Invalid role thinking level: " + requested);
  const available = levels.filter(level => model.thinkingLevelMap?.[level] !== null &&
    (!(level === "max" || level === "xhigh") || model.thinkingLevelMap?.[level] !== undefined));
  // Clamp down to the strongest level supported by a fallback model.
  return [...levels.slice(0, levels.indexOf(requested) + 1)].reverse().find(level => available.includes(level)) ?? "off";
}

/** Полный каталог моделей Pi (все модели, независимо от того,
 *  авторизован провайдер или нет). Именно каталог — источник правды для
 *  «модель существует» (спека §10, §14). Если каталог недоступен —
 *  RuntimeUnavailableError (503), а не пустой список. */
async function loadModelCatalog(): Promise<SdkModel[]> {
  const rt = await getModelRuntime();
  await refreshConnectedCatalog(rt);
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
  const auth = (
    provider as unknown as {
      auth?: { apiKey?: unknown; oauth?: unknown };
    }
  ).auth;
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
  // Инструкция роли — AGENTS.md в папке роли (один источник, 20.10.2026).
  const file = roleHome(role).agents;
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
    return tools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
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

/** userId, которого попытка будет записана как executor. Исполнитель —
 *  ролевая учётка; иначе любой ai-пользователь (страховка до посева ролей).
 *  null = записать attempt нельзя (нет пользователя), run всё равно идёт. */
function resolveExecutorId(
  role: string | null,
  _agentId: string,
): string | null {
  if (role && (ROLE_NAMES as readonly string[]).includes(role)) {
    const account = readRoleAccount(role as RoleName);
    if (account) return account.id;
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
      (m) =>
        m &&
        typeof m === "object" &&
        (m as { role?: string }).role === "assistant",
    ) as { stopReason?: string; errorMessage?: string } | undefined;
  if (!lastAssistant?.stopReason) return null;
  return {
    stopReason: lastAssistant.stopReason,
    errorMessage: lastAssistant.errorMessage ?? null,
  };
}

/** Обновляет активность/последний ход. НЕ завершает run и НЕ пишет
 *  терминальный итог: результат вычисляется только на agent_settled. */
function recordRunActivity(
  run: ActiveRun,
  event: { type: string; [k: string]: unknown },
): void {
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
          errorMessage:
            typeof event.finalError === "string"
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
async function finalizeRun(
  run: ActiveRun,
  outcome: AgentRun["status"],
  stopReason: string | null,
): Promise<void> {
  if (run.settled) return;
  run.settled = true;
  releaseRoleRunAccess(run.mcpConfigPath);

  const attemptOutcome =
    outcome === "completed"
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
  } catch {
    /* задача/попытка могла быть удалена */
  }

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
  } catch {
    /* ignore */
  }
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
  } catch {
    /* процесс уже умер — окей */
  }

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
    } catch {
      /* процесс мог уже завершиться */
    }
    await finalizeRun(run, "cancelled", "cancelled");
  }
}

/** Итог вычисляется ТОЛЬКО на agent_settled. Единственный источник
 *  «плохого» исхода — явная отмена (cancelRun) или последний фактический
 *  ход с stopReason error/aborted. Промежуточные agent_end эту функцию не
 *  зовут. */
function resultStatus(run: ActiveRun): {
  outcome: AgentRun["status"];
  reason: string | null;
} {
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
        thinkingLevels: await supportedThinkingLevels(sm),
        thinkingLevelLabels: thinkingLevelLabels(sm),
        images: Array.isArray(sm.input)
          ? sm.input.includes("image")
          : undefined,
      });
    }
    // Каталог models.dev держит в провайдере opencode модели, которых шлюз
    // Zen уже не обслуживает: выбор такой модели даёт 400 «Model is
    // unavailable». Сверяем с живым каталогом шлюза (кэш 6 часов).
    return filterByZenCatalog(models, await zenModelIds());
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
        status = mapProviderStatus(
          rt.getProviderAuthStatus(p.id) as AuthStatus,
        );
      } catch {
        status = "expired";
      }
      let authType: "api_key" | "oauth" | null = null;
      try {
        authType =
          (rt.checkAuth(p.id) as unknown as { type?: "api_key" | "oauth" })
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
      notify: () => {
        /* api_key flow не эмитит событий */
      },
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
      authMethods: providerInfo
        ? providerAuthMethods(providerInfo)
        : ["api_key"],
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
    const match =
      catalog.find(
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
      ...(mcpConfigPath
        ? {
            args: [
              "--mcp-config",
              mcpConfigPath,
              ...(await chatInstructionArgs(
                role,
                mcpConfigPath,
                "work",
                input.cwd ?? process.cwd(),
              )),
            ],
          }
        : {}),
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
          routingRole: (ROLE_NAMES as readonly string[]).includes(role)
            ? role
            : null,
        });
      } catch {
        /* attempt — не критично для запуска */
      }
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
        ]
          .filter(Boolean)
          .join("\n\n");
        db.prepare(
          "UPDATE attempts SET system_prompt_snapshot = ? WHERE id = ?",
        ).run(composed, runId);
        db.prepare(
          "UPDATE tasks SET composed_prompt_snapshot = ? WHERE id = ?",
        ).run(composed, input.taskId);
      } catch {
        /* колонки ещё нет — после миграции 081 */
      }
    }
    try {
      db.prepare(
        `UPDATE tasks
            SET current_attempt_id = ?, agent_state = 'in_progress',
                agent_started_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`,
      ).run(runId, input.taskId);
    } catch {
      /* ignore */
    }

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
        const actual = state?.model as
          { provider?: string; id?: string } | undefined;
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
          db.prepare(`UPDATE attempts SET session_id = ? WHERE id = ?`).run(
            run.sessionId,
            runId,
          );
          db.prepare(
            `UPDATE tasks SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ?`,
          ).run(run.sessionId, input.taskId);
        } catch {
          /* ignore */
        }
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
    } catch {
      /* процесс мог уже завершиться */
    }
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
        status:
          mapAttemptStatus(attempt as AttemptRow) === "running"
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

/** Проверяет, что модель есть в каталоге Pi. Принимает и «голый» id (`MiniMax-M3`), и ссылку
 *  `провайдер/модель` (`opencode-go/deepseek-v4.1-flash`): именно так маршруты ролей хранят модели
 *  не-основных провайдеров, иначе провайдер угадывался бы по имени и выходил MiniMax. */
export async function modelExists(ref: string): Promise<boolean> {
  const value = ref.trim();
  const catalog = await loadModelCatalog();
  if (catalog.some((m) => m.id === value)) return true;
  const slash = value.indexOf("/");
  if (slash <= 0) return false;
  const provider = value.slice(0, slash);
  const id = value.slice(slash + 1);
  return catalog.some((m) => m.provider === provider && m.id === id);
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
  /** Чат задачи: только чтение своей задачи (владелец 05.11.2026). */
  taskChatTaskId?: string;
  /** Settles after the visible reply is persisted, never merely on SDK completion. */
  deliveryOutcome?: Promise<boolean>;
  mode?: ChatWorkMode;
  chatId: string;
  messageId?: string;
  role: RoleName;
  /** id ролевой учётки (role_<role>) — будет автором сообщения-ответа. */
  roleId: string;
  prompt: string;
  /** Модель, выбранная в окне ввода на этот ход; не задана — модель роли. */
  model?: string;
  thinkingLevel?: string;
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
  /** Режим «Цель»: промежуточный ответ роли между ходами — сервер кладёт его в чат. */
  onGoalProgress?: (text: string) => void;
  /** Только сжать сохранённую сессию (кнопка «Сжать»), без хода роли. */
  compactOnly?: boolean;
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
  /** Прервать ход: сессия Pi внутри сервера (`session.abort`). */
  abort: () => Promise<void>;
  /** Дождаться фактической остановки хода (`session.waitForIdle`).
   *  `abort()` просит остановиться; `waitForIdle` — дождаться, пока
   *  выполняемое действие действительно завершилось. Без него «остановленный»
   *  ход может ещё секунду-другую работать в фоне. */
  waitIdle?: () => Promise<void>;
  startedAt: string;
  cancelled: boolean;
}

const activeChatRuns = new Map<string, ActiveChatRun>();

/** Стандартные лимиты на одну онлайн-сессию. Документированы как константы,
 *  чтобы тесты могли на них опереться, а продакшен подменить через
 *  переменные окружения при росте нагрузки. */
//
// Владелец 27.09.2026: прежние «60 секунд на весь ход» обрывали роль посреди
// работы (в журнале — «Timeout collecting events» у Помощника владельца и QA), причём
// молча. Теперь ход живёт, пока роль что-то делает: обрыв — только по
// тишине (idle) или по общему потолку (ceiling), и о нём пишется в чат.
// Сторож тишины ВЫКЛЮЧЕН по умолчанию (0) — владелец 12.10.2026: «если
// агент долго занимается, его вырубает с чата… такой инструмент здесь
// точно не нужен». Живой пример: 11.10 23:16 в чат упало «Остановил ход:
// 3 мин не было никаких действий», хотя роль работала. Тишина в чате
// неотличима от работы: пока идёт долгий вызов инструмента или модель
// думает, событий может не быть минутами. Общий потолок CEILING (30 мин)
// остаётся единственной границей — он ловит и зависшие ходы, но не
// мешает длинной работе. Вернуть сторож можно переменной окружения
// TASKFLOW_CHAT_RUN_IDLE_MS, если понадобится.
export const CHAT_RUN_IDLE_MS = 0;
export const CHAT_RUN_CEILING_MS = 30 * 60_000;

function resolveChatRunTimeout(override?: number): number {
  const raw =
    override && override > 0
      ? override
      : Number(process.env.TASKFLOW_CHAT_RUN_TIMEOUT_MS) || CHAT_RUN_CEILING_MS;
  return Math.min(raw, CHAT_RUN_CEILING_MS);
}

/** 0 — сторож тишины выключен (дефолт), см. CHAT_RUN_IDLE_MS. */
function resolveChatRunIdle(override?: number): number {
  if (override && override > 0) return override;
  const raw = process.env.TASKFLOW_CHAT_RUN_IDLE_MS;
  if (raw === undefined || raw === "") return CHAT_RUN_IDLE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : CHAT_RUN_IDLE_MS;
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
      await run.abort();
    } catch {
      /* процесс мог уже завершиться */
    }
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
export async function startChatRun(input: StartChatRunInput): Promise<StartChatRunResult> {
  const generation=currentChatGeneration(input.chatId,input.roleId);
  let attempt=input;
  // Each item may reset once. The durable item entry prevents another reset
  // for that item, even across server restarts or later owner messages.
  for(;;){
    try { return await startChatRunOnce(attempt); }
    catch(error){
      if((error as {code?:string}).code!=="CHAT_ACTION_CONTINUE")throw error;
      if(currentChatGeneration(input.chatId,input.roleId)!==generation)throw chatRunCancelledError();
      const continuation=budgetContinuationPrompt(input.chatId,input.roleId);
      if(!continuation)throw chatRunCancelledError();
      attempt={...input,sessionId:undefined,prompt:continuation+"\n\nИсходный контекст поручения:\n"+input.prompt};
    }
  }
}

async function startChatRunOnce(
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

  if (externalRuntime(role)) {
    try {
      return await runExternalChat(input, runId);
    } finally {
      releaseChatRoleLock(input.chatId, input.roleId);
    }
  }

  const preparation = new ChatPreparationDeadline();
  try {
    // Модель/провайдер берём из routing роли — ровно как в startRun.
    // Различие: input.provider/model не предусмотрены, чат ходит всегда
    // на «своей» для роли модели (маркировка роли и есть намерение).
    const routing = loadRoleRouting();
    const model = routing.models[role];
    const provider = providerOfModel(model);

    const catalog = await preparation.wait(loadModelCatalog());
    // «opencode-go/deepseek-…» в каталоге Pi лежит как id «deepseek-…» +
    // provider «opencode-go»: без разбора ссылки модели с префиксом в чате
    // не находились никогда — ни основная, ни запасные (20.10.2026).
    const findInCatalog = (id: string) =>
      // Явный выбор «провайдер/модель» не подменяется моделью с тем же
      // именем у другого провайдера (карточка e11eae7a, пункт 1).
      resolveCatalogModel(catalog as any, id, providerOfModel(model));
    // Владелец 12.10.2026: «у нас должен был быть настроен запасной провайдер…
    // лимиты кончились и не переключаются». ХОД ЧАТА вообще не смотрел на
    // цепочку: бралась только основная модель роли, поэтому в чате не
    // переключался НИКТО — ни Помощник владельца (у которого цепочка была настроена),
    // ни кто-либо ещё. `pickFailoverModel` живёт в ветке шагов задачи и в чат
    // не заходит. Теперь идём по цепочке [основная, ...запасные] и берём
    // первую модель, чей провайдер сейчас не помечен как упёршийся в лимит.
    // Выбор в окне ввода чата — первым в цепочке (только на этот ход).
    const chain = [
      input.model,
      model,
      ...(routing.fallbacks[role] ?? []),
    ].filter(Boolean) as string[];
    const match = chain
      .map(findInCatalog)
      .find((m): m is NonNullable<typeof m> => {
        // Провайдер — из каталога: по голому id «deepseek-…» угадывался
        // minimax, и его лимит отбрасывал модели чужих провайдеров.
        return !!m && providerAvailable(m.provider);
      });
    if (!match) {
      throw new ModelNotAvailableError(model, provider);
    }
    const resolvedProvider = match.provider;
    const resolvedModel = match.id;

    // Ход чата — внутри сервера (владелец 02.10.2026: «у нас всё должно быть
    // на сервере»). Раньше здесь поднимался отдельный процесс Pi с
    // `--mcp-config`, а тот — `mcp_server.py`; после `--no-extensions` флаг
    // стал неизвестен, и чаты легли. Теперь та же сессия Pi живёт в процессе
    // сервера, инструменты трекера — прямые вызовы маршрутов от имени роли.
    const home = ensureRoleHome(role);
    // Папка, выбранная в чате (владелец 27.10.2026); нет выбора — папка роли.
    const chatWorkspace = resolveChatWorkspace(input.chatId, input.messageId);
    const cwd = chatWorkspace?.cwd ?? home.workspace;
    const mode: ChatWorkMode = input.mode ?? "work";
    const sessionDirectory = await preparation.wait(prepareChatSessionDirectory(
      role,
      input.chatId,
      input.sessionId,
    ));
    const known = input.sessionId
      ? (await preparation.wait(SessionManager.list(cwd, sessionDirectory))).find(
          (s) => s.id === input.sessionId,
        )
      : undefined;
    // Сохранённая сессия — продолжаем её; файла нет — заводим новую с тем же
    // id (как делал `--session-id` у Pi CLI), чтобы chat_sessions не терял её.
    const sessionManager = known
      ? SessionManager.open(known.path, sessionDirectory, cwd)
      : SessionManager.create(
          cwd,
          sessionDirectory,
          input.sessionId ? { id: input.sessionId } : undefined,
        );

    const runtime: any = await preparation.wait(getModelRuntime());
    const piModel =
      runtime.getModel?.(resolvedProvider, resolvedModel) ??
      ((await preparation.wait(runtime.getAvailable?.() ?? [])) ?? []).find(
        (m: any) => m.id === resolvedModel,
      );
    if (!piModel) throw new ModelNotAvailableError(model, provider);

    // Чек-лист чата ведёт сервер (владелец 25.10.2026): в начало хода кладём
    // не просьбу «не забудь», а сам план с текущим этапом — роль не держит его
    // в голове и не выбирает шаг по ощущению.
    const chatPlanPrompt = chatWorkPlanPrompt(input.chatId, input.roleId);
    const systemPrompt = chatTurnSystemText(role,
      await preparation.wait(chatSystemPrompt(role,mode,cwd)),
      [chatExecutionInstruction(chatExecutionMode(input.chatId,input.messageId)),ROLE_TOOL_INSTRUCTION,chatPlanPrompt??""]);
    const resourceLoader = await preparation.wait(createTaskResourceLoader(
      role,
      cwd,
      systemPrompt,
      undefined,
      true,
    ), resource => resource.disposeResources());
    const composio = await preparation.wait(connectRoleComposio(role, mode, input.chatId).catch(
      (error) => {
        console.warn(`[chats] Composio для ${role} не подключился:`, error);
        return { tools: [] as any[], close: async () => {} };
      },
    ), resource => resource.close());
    // «Обсуждение» — как «Работа» (владелец 20.10.2026); ограничен только «План».
    const allowed = (name: string) =>
      input.taskChatTaskId ? TASK_CHAT_FILE_TOOLS.includes(name) :
      mode !== "plan" ||
      PLANNING_TOOLS.includes(name) ||
      [
        "COMPOSIO_SEARCH_TOOLS",
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        "COMPOSIO_GET_TOOL_SCHEMAS",
      ].some((n) => name.endsWith(n));
    const builtin = [
      ...new Map(
        [...createCodingTools(cwd), ...createReadOnlyTools(cwd)].map((t) => [
          t.name,
          t,
        ]),
      ).values(),
    ]
      .filter((t) => allowed(t.name))
      .map((t) => ({
        ...t,
        description:
          composeLayer(role, "tool.builtin." + t.name)?.effective ??
          t.description,
        // Диф под ответом в чате: что bash поменял в git-репозитории папки
        // роли (LOCK-ASSISTANT-TOOL-DIFFS-20261028).
        ...(t.name === "bash"
          ? {
              execute: async (id: string, args: any, signal?: AbortSignal, onUpdate?: any) => {
                const { result, files } = await captureBash(localCaptureIO(), cwd, () =>
                  t.execute(id, args, signal, onUpdate),
                );
                return withFileChanges(result, ".110", files);
              },
            }
          : {}),
      }));
    const infra = await preparation.wait(connectRoleMcp(role, cwd).catch(() => ({
      tools: [] as any[],
      close: async () => {},
    })), resource => resource.close());
    // Дела владельца в комнате чата: у Помощника это один из каналов, где с ним
    // говорят, поэтому инструмент должен быть и здесь.
    const secretary =
      role === "secretary"
        ? secretaryThings3Tools({
            role,
            chatId: input.chatId,
            messageId: input.messageId,
          })
        : [];
    const toolCatalog = buildRoleToolCatalog(
      {
        role,
        model: resolvedModel,
        mode: input.taskChatTaskId ? TASK_CHAT_MODE : mode,
        runId: sessionManager.getSessionId(),
        chatId: input.chatId,
        messageId: input.messageId,
        ...(input.taskChatTaskId ? { taskId: input.taskChatTaskId } : {}),
      },
      [...composio.tools, ...infra.tools, ...secretary],
    );

    registerProviderSession(sessionManager.getSessionId(), {role, chat_id:input.chatId, message_id:input.messageId, run_id:runId, origin:"chat"});
    let session: any;
    let budgetFailure: Error | null = null;
    const budgetEvents: unknown[] = [];
    try {
      ({ session } = await preparation.wait(createAgentSession({
        cwd,
        model: piModel,
        thinkingLevel: (await validateChatThinking(piModel,input.thinkingLevel)) ?? resolveThinkingLevel(piModel, role) ?? undefined,
        modelRuntime: runtime,
        resourceLoader,
        // `tools` у SDK — список ИМЁН разрешённых инструментов. Объекты сюда
        // нельзя: ни одно имя не совпадёт, и роль останется без инструментов
        // («у меня нет инструментов», владелец 02.10.2026). Встроенные с
        // описаниями владельца — через customTools: одноимённый перекрывает.
        tools: [...builtin.map((t) => t.name), ...toolCatalog.registeredNames],
        customTools: guardChatActions([...builtin, ...toolCatalog.customTools], callId => reserveChatItemAction({chatId:input.chatId,roleId:input.roleId,messageId:input.messageId,callId:runId+":"+callId}), () => {
          budgetFailure=Object.assign(new Error("Дополнительные 50 действий исчерпаны; материалы сохранены в приватной карточке разбора"),{code:"CHAT_ACTION_BUDGET"});
          stopChatWorkPlan(input.chatId, input.roleId, "budget_exhausted");
          db.prepare("UPDATE chat_sessions SET pi_session_id='' WHERE chat_id=? AND role_id=?").run(input.chatId,input.roleId);
          void session?.abort().catch(() => {});
        }, () => {
          budgetFailure=Object.assign(new Error("Продолжение в новой сессии на 50 действий"),{code:"CHAT_ACTION_CONTINUE"});
          safelyCaptureBudgetCases(input.chatId,input.roleId,{sessionFile:sessionManager.getSessionFile(),systemPrompt,events:budgetEvents});
          void session?.abort().catch(() => {});
        }),
        sessionManager,
        settingsManager: SettingsManager.inMemory({
          // Compaction uses Pi defaults and the actual model token window.
          // Do not impose character limits or shorten the SDK summary template.
          retry: { enabled: true, maxRetries: 2 },
        }),
      } as any), resource => resource.session.dispose()));
    } catch (error) {
      preparation.dispose();
      throw error;
    }
    preparation.transfer();

    installSecretarySystem(session,role,systemPrompt);
    observeProviderRetries(session, sessionManager.getSessionId());
    installNativeToolSchemas(session, toolCatalog);
    // Активно только ядро операций: остальное подключает taskflow_tools по
    // требованию (setActiveToolsByName). Реестр сессии полный — подключать можно
    // всё, что роль имеет право вызывать.
    installNativeToolCore(session, toolCatalog, builtin.map((t:any)=>t.name));

    // Актуальное окно контекста живой сессии для панели чата
    // (карточка e11eae7a, пункт 4): замеряем по настоящей сессии Pi.
    const liveSessionId: string | null =
      session.sessionId ?? input.sessionId ?? sessionManager.getSessionId() ?? null;
    openChatSession({
      chatId: input.chatId,
      roleId: input.roleId,
      session,
      sessionId: liveSessionId,
      provider: resolvedProvider,
      model: resolvedModel,
    });
    // Сессию сохраняем СРАЗУ, а не только после успешного ответа (владелец
    // 31.10.2026). Иначе первый же ход, прерванный владельцем, оставлял
    // chat_sessions пустым, и следующий ход начинал разговор заново —
    // ровно то, что владелец запретил: остановка не должна стирать память.
    if (liveSessionId)
      upsertChatSession(
        input.chatId,
        input.roleId,
        liveSessionId,
        currentChatGeneration(input.chatId, input.roleId),
      );

    installSteeringBoundary(session);
    // Role policy also replaces the level restored from an older session.
    const roleThinking = (await validateChatThinking(piModel,input.thinkingLevel)) ?? resolveThinkingLevel(piModel, role);
    if (roleThinking && session.thinkingLevel !== roleThinking && typeof session.setThinkingLevel === "function") {
      session.setThinkingLevel(roleThinking);
    }
    // Restoring a session is not a reason to compact. Pi checks the model's
    // token window itself before prompts and between tool turns.

    const run: ActiveChatRun = {
      runId,
      chatId: input.chatId,
      role,
      roleId: input.roleId,
      abort: () => session.abort(),
      waitIdle: () => session.waitForIdle?.() ?? Promise.resolve(),
      startedAt: new Date().toISOString(),
      cancelled: false,
    };
    activeChatRuns.set(runId, run);
    const steering = input.deliveryOutcome
      ? registerChatSteering({chatId:input.chatId,roleId:input.roleId,executionMode:chatExecutionMode(input.chatId,input.messageId),workMode:mode,steer:text=>session.steer(text),outcome:input.deliveryOutcome})
      : null;

    // Сторож тишины: каждое событие рантайма — признак жизни. Пока идёт
    // вызов инструмента, тишина не копится (команда может честно работать
    // минуты), ход держит только общий потолок.
    const thrash = new ThrashGuard();
    const memoryConsultation = new MemoryConsultationGuard();
    const planHints = new PlanHintGuard(input.chatId, input.roleId);
    const idleMs = resolveChatRunIdle(input.idleMs);
    const runningTools = new Set<string>();
    let lastActivity = Date.now();
    let watchdogFired: ChatRunTimeoutError | null = null;
    let rejectWatchdog: (error: ChatRunTimeoutError) => void = () => {};
    const watchdog = new Promise<never>((_, reject) => {
      rejectWatchdog = reject;
    });
    watchdog.catch(() => {});

    // Итог последнего хода модели: без него ошибка провайдера давала пустой
    // текст, и роль в чате просто молчала.
    const turnState: { last: TurnResult | null } = { last: null };

    // Рабочая папка роли — живому ходу: относительные пути правок файлов
    // считаются от неё («Изменения кода» под ответом, 27.10.2026).
    try { input.onEvent?.({ type: "taskflow_workspace", cwd }); } catch { /* украшение */ }
    const unsubscribe = session.subscribe((event: any) => {
      if(event?.type!=="message_update")budgetEvents.push(event);
      steering?.observe(event);
      lastActivity = Date.now();
      if (event?.type === "agent_end") {
        const turn = parseTurnResult(event.messages);
        if (turn) turnState.last = turn;
      } else if (event?.type === "auto_retry_end") {
        turnState.last =
          event.success === false
            ? {
                stopReason: "error",
                errorMessage:
                  typeof event.finalError === "string"
                    ? event.finalError
                    : "retry_failed",
              }
            : null;
      }
      if (event?.type === "tool_execution_start" && event.toolCallId)
        runningTools.add(event.toolCallId);
      // Сторож топтания: повторы одного вызова и длинные серии чтений без
      // изменений — указание в тот же ход (владелец 23.10.2026).
      if (event?.type === "tool_execution_start" && chatRuntimeGuidanceEnabled(role)) {
        const memoryNudge = memoryConsultation.observe(String(event.toolName ?? ""), event.args);
        const thrashNudge = thrash.observe({ tool: String(event.toolName ?? ""), argsDigest: stepDigest((event as any).args) });
        const nudge = [memoryNudge, thrashNudge].filter(Boolean).join("\n\n");
        if (nudge) void session.steer(nudge).catch(() => {});
      }
      else if (event?.type === "tool_execution_end" && event.toolCallId)
        runningTools.delete(event.toolCallId);
      // Подсказка «сдай пункт» по смыслу промежуточного сообщения (06.11.2026); ничего не закрывает.
      if (event?.type === "message_end" && !input.compactOnly && input.mode !== "plan" && chatRuntimeGuidanceEnabled(role)) {
        const text = assistantTextOf(event);
        if (text) void planHints.observe(text).then((hint) => { if (hint) return session.steer(hint); }).catch(() => {});
      }
      if (
        event?.type === "message_update" &&
        event.assistantMessageEvent?.type === "toolcall_start"
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
    let finalSessionId: string | null =
      session.sessionId ?? input.sessionId ?? null;
    const timeoutMs = resolveChatRunTimeout(input.timeoutMs);
    let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
    // Потолок — на каждый ход: в режиме «Цель» ходов много, и общий
    // 30-минутный потолок оборвал бы долгую цель посередине.
    const armCeiling = () => {
      clearTimeout(ceilingTimer);
      const ceiling = new Promise<never>((_, reject) => {
        ceilingTimer = setTimeout(() => {
          stopChatWorkPlan(input.chatId, input.roleId, "budget_exhausted");
          session.abort().catch(() => {});
          reject(new ChatRunTimeoutError("CHAT_RUN_CEILING", timeoutMs));
        }, timeoutMs);
      });
      ceiling.catch(() => {});
      return ceiling;
    };
    const idleTimer = setInterval(
      () => {
        if (idleMs <= 0 || watchdogFired || runningTools.size > 0) return;
        if (Date.now() - lastActivity < idleMs) return;
        watchdogFired = new ChatRunTimeoutError("CHAT_RUN_IDLE", idleMs);
        stopChatWorkPlan(input.chatId, input.roleId, "budget_exhausted");
        session.abort().catch(() => {});
        rejectWatchdog(watchdogFired);
      },
      Math.min(5_000, Math.max(50, Math.floor(idleMs / 4))),
    );

    try {
      // Один user message = один ответ; сверху — общий потолок, сбоку —
      // сторож тишины.
      const promptOnce = async (text: string) => {
        try {
          await Promise.race([session.prompt(text), watchdog, armCeiling()]);
          assertChatBudgetAtTurnEnd(input);
          measureChatSession(input.chatId, input.roleId);
        } catch (error) {
          if((error as {code?:string}).code==="CHAT_ACTION_BUDGET"){
            budgetFailure=error as Error;
            stopChatWorkPlan(input.chatId,input.roleId,"budget_exhausted");
            db.prepare("UPDATE chat_sessions SET pi_session_id='' WHERE chat_id=? AND role_id=?").run(input.chatId,input.roleId);
          }
          if((error as {code?:string}).code==="CHAT_ACTION_CONTINUE")budgetFailure=error as Error;
          if (run.cancelled) throw chatRunCancelledError();
          if (budgetFailure) throw budgetFailure;
          if (watchdogFired) throw watchdogFired;
          throw error;
        }
      };
      if (input.compactOnly) {
        // Manual compaction delegates to the SDK exactly once. A provider
        // failure must not be replaced by a destructive local pseudo-summary.
        await Promise.race([session.compact(), armCeiling()]);
      } else {
        await promptOnce(
          chatUserTurnText(role,input.mode ? chatModeInstruction(input.mode) : "",input.prompt),
        );
      }
      if (input.mode === "goal" && !input.compactOnly) {
        // «Цель»: пока роль пишет «ЦЕЛЬ: ПРОДОЛЖАЮ», даём следующий ход,
        // до потолка из настроек (владелец 20.10.2026: 50, меняется).
        const maxTurns = getSetting("chat_goal_max_turns");
        for (let turn = 2; turn <= maxTurns; turn++) {
          const text = (session.getLastAssistantText?.() ?? "").trim();
          if (goalStatus(text) !== "continue" || run.cancelled) break;
          const progress = stripGoalMark(text);
          if (progress) input.onGoalProgress?.(progress);
          const last = turn === maxTurns;
          await promptOnce(
            last
              ? `Ход ${turn} из ${maxTurns} — последний по потолку. Остановись: дай итог — что сделано, что осталось — и закончи строкой «${GOAL_MARK.owner}».`
              : `Продолжай к цели. Ход ${turn} из ${maxTurns}.`,
          );
        }
      }
      // Конец хода: текущий пункт плана должен быть сдан; один дожим, затем отметка unclosed.
      if (!input.compactOnly && input.mode !== "plan" && !run.cancelled)
        await ensurePlanItemClosed(input.chatId, input.roleId, promptOnce);
      finalText = input.compactOnly
        ? ""
        : stripGoalMark((session.getLastAssistantText?.() ?? "").trim());
      finalSessionId = session.sessionId ?? finalSessionId;
      if (run.cancelled) throw chatRunCancelledError();
      if (budgetFailure) throw budgetFailure;
      const lastTurn = turnState.last;
      if (!finalText && lastTurn?.stopReason === "error") {
        throw Object.assign(
          new Error(lastTurn.errorMessage || "модель вернула ошибку"),
          { code: "CHAT_RUN_MODEL_ERROR" },
        );
      }
    } finally {
      safelyCaptureBudgetCases(input.chatId,input.roleId,{sessionFile:sessionManager.getSessionFile(),systemPrompt,events:budgetEvents,error:budgetFailure});
      steering?.close();
      closeChatSession(input.chatId, input.roleId);
      clearInterval(idleTimer);
      clearTimeout(ceilingTimer);
      unsubscribe?.();
      try {
        session.dispose();
      } catch {
        /* уже закрыта */
      }
      resourceLoader.disposeResources();
      await composio.close().catch(() => {});
      await infra.close().catch(() => {});
      activeChatRuns.delete(runId);
    }

    if (finalSessionId) {
      // Сохраняем pi_session_id ДЛЯ СЛЕДУЮЩЕГО СООБЩЕНИЯ. Это
      // единственная запись в БД, которую делает онлайн-сессия —
      // tasks/attempts/agent_state остаются нетронутыми.
      // Поколение пишется рядом с сессией: поколение уехало (прерывание,
      // /new-session) — значит файл сессии больше не источник правды.
      upsertChatSession(
        input.chatId,
        input.roleId,
        finalSessionId,
        currentChatGeneration(input.chatId, input.roleId),
      );
    }

    return { runId, sessionId: finalSessionId, text: finalText };
  } finally {
    preparation.dispose();
    releaseChatRoleLock(input.chatId, input.roleId);
  }
}

/**
 * Ход внешнего агента (Claude Code и т. п.) в живом чате. Агент работает в
 * своём окружении; от TaskFlow — инструкция-буст, правила чата и MCP-сервер
 * taskflow_run с операциями чата от имени участника. Сессия агента
 * продолжается между сообщениями: её id хранится в chat_sessions, как у Pi.
 */
async function runExternalChat(
  input: StartChatRunInput,
  runId: string,
): Promise<StartChatRunResult> {
  const role = input.role;
  const runtimeKey = externalRuntime(role)!;
  const command = agentBinary(runtimeKey);
  if (!command)
    throw new Error(
      `внешний агент «${roleTitle(role)}» не найден на машине — нажми «Найти агентов» в «Команде»`,
    );
  const mode: ChatWorkMode = input.mode ?? "work";
  // Домашняя папка, как при обычном запуске агента, а не песочница роли.
  const cwd = homedir();
  const allowed = (name: string) =>
    mode !== "plan" || PLANNING_TOOLS.includes(name);
  const catalog = buildRoleToolCatalog({
    role,
    model: null,
    mode,
    runId,
    chatId: input.chatId,
    messageId: input.messageId,
  });
  const operations = catalog.customTools.filter(
    (t: any) => t.name !== "taskflow" && allowed(t.name),
  );
  const token = roleRunToken(role);
  const preparation = new ChatPreparationDeadline();
  let session: CliAgentSession;
  try {
  session = await preparation.wait(createExternalAgentSession(runtimeKey, {
    cwd,
    command,
    env: token ? { TASKFLOW_TOKEN: token } : undefined,
    resumeSessionId: input.sessionId ?? null,
    model: input.model,
    onModel: (model) => {
      db.prepare("UPDATE roles SET last_model = ? WHERE key = ?").run(
        model,
        role,
      );
    },
    // Только буст: правила внутренних ролей (песочница, назначение, host-инструменты) внешнему агенту не передаются.
    systemPrompt: externalAgentBoost(roleTitle(role), operations, "chat") + "\n\n" + chatExecutionInstruction(chatExecutionMode(input.chatId,input.messageId)),
    // Операции чата — инструментами MCP-сервера taskflow_run от имени участника.
    runTools: token ? { runId, userId: roleUserId(role), token, tools: operations } : undefined,
  }), resource => resource.dispose());
  preparation.transfer();
  } finally { preparation.dispose(); }
  const run: ActiveChatRun = {
    runId,
    chatId: input.chatId,
    role,
    roleId: input.roleId,
    abort: () => session.abort(),
    // Внешний CLI-агент не отдаёт waitForIdle: ждать нечего, его abort
    // завершает процесс.
    waitIdle: async () => undefined,
    startedAt: new Date().toISOString(),
    cancelled: false,
  };
  activeChatRuns.set(runId, run);
  const steering=input.deliveryOutcome
    ? registerChatSteering({chatId:input.chatId,roleId:input.roleId,executionMode:chatExecutionMode(input.chatId,input.messageId),workMode:mode,steer:text=>session.steer(text),outcome:input.deliveryOutcome})
    : null;
  // Рабочая папка роли — живому ходу: относительные пути правок файлов
  // считаются от неё («Изменения кода» под ответом, 27.10.2026).
  try { input.onEvent?.({ type: "taskflow_workspace", cwd }); } catch { /* украшение */ }
  const unsubscribe = session.subscribe((event: any) => {
    steering?.observe(event);
    if (event?.type === "tool_execution_start") input.onStep?.(event.toolName);
    try {
      input.onEvent?.(event);
    } catch (error) {
      console.warn("[chats] onEvent живого хода упал:", error);
    }
  });
  const timeoutMs = resolveChatRunTimeout(input.timeoutMs);
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.prompt(
        input.mode
          ? chatModeInstruction(input.mode) + "\n\n" + input.prompt
          : input.prompt,
      ),
      new Promise<never>((_, reject) => {
        ceilingTimer = setTimeout(() => {
          void session.abort();
          reject(new ChatRunTimeoutError("CHAT_RUN_CEILING", timeoutMs));
        }, timeoutMs);
      }),
    ]);
    if (run.cancelled) throw chatRunCancelledError();
    const last = session.state.messages[session.state.messages.length - 1];
    if (last?.stopReason === "error")
      throw Object.assign(
        new Error(last.errorMessage || "внешний агент вернул ошибку"),
        { code: "CHAT_RUN_MODEL_ERROR" },
      );
    const text = stripGoalMark(
      (last?.content ?? []).map((c: any) => c?.text ?? "").join("\n").trim(),
    );
    if (session.sessionId)
      upsertChatSession(
        input.chatId,
        input.roleId,
        session.sessionId,
        currentChatGeneration(input.chatId, input.roleId),
      );
    return { runId, sessionId: session.sessionId, text };
  } finally {
    steering?.close();
    clearTimeout(ceilingTimer);
    unsubscribe();
    session.dispose();
    activeChatRuns.delete(runId);
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
    await run.abort();
  } catch {
    /* процесс мог уже завершиться */
  }
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
export async function cancelChatRunsFor(
  chatId: string,
  roleId?: string,
): Promise<number> {
  const runs = [...activeChatRuns.values()].filter(
    (run) => run.chatId === chatId && (!roleId || run.roleId === roleId),
  );
  let stopped = 0;
  for (const run of runs) {
    if (await cancelChatRun(run.runId)) stopped += 1;
  }
  return stopped;
}

/** Дождаться фактической остановки ходов роли в чате (после abort).
 *
 *  Граница прерывания (карточка 252c400e) требует именно этого: «ход
 *  остановлен» должно означать «действие уже прекратилось», иначе частичный
 *  ответ собирается на ходу, а внешняя работа продолжает жить в фоне.
 *  Предел времени обязателен: ход, который не встаёт, не должен висеть
 *  вечно. */
export async function waitChatRunsIdle(
  chatId: string,
  roleId: string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const runs = [...activeChatRuns.values()].filter(
    (run) => run.chatId === chatId && (!roleId || run.roleId === roleId),
  );
  if (!runs.length) return true;
  const wait = Promise.all(
    runs.map(async (run) => {
      try {
        await run.waitIdle?.();
      } catch {
        /* ход мог завершиться вместе с отменой */
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(1, timeoutMs));
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([wait.then(() => "idle" as const), limit]);
    return outcome === "idle";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Тестовая утилита: сбросить in-memory карту активных чат-сессий и
 *  локи. В проде не нужна — после рестарта процесса всё и так пусто. */
export function _resetActiveChatRunsForTests(): void {
  activeChatRuns.clear();
  // Реестр подмешивания живёт рядом с ходами: без сброса уточнение ушло бы
  // в ход, которого уже нет.
  _resetChatSteeringForTests();
}
