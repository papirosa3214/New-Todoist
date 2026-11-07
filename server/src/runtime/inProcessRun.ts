import {registerProviderSession, observeProviderRetries} from "./providerDiagnostics.js";
import {reportReviewBlockForTask} from "../lib/jevAssist.js";
import { MemoryConsultationGuard } from "./memoryConsultationGuard.js";
import { reviewThoughts, thoughtNudge, looksLikeLoop, REVIEW_EVERY, NUDGE_COOLDOWN } from "../lib/thoughtReviewJev.js";
import { COMPACTION_SETTINGS, compactSessionSafely } from "./compactionFallback.js";
import {oneShotReviewInstruction} from "../lib/integrationResponsibility.js";
import {installSteeringBoundary} from "./steeringBoundary.js";
import {queueWorkCoordination,markDeliveredToWork,traceCoordination} from "./chatCoordination.js";
import { reserveReviewRun, assertReviewRunAllowed, finishReviewRun } from "./reviewRunBudget.js";
import { chatTools } from "./chatTools.js";
import { buildRoleToolCatalog, installNativeToolCore, installNativeToolSchemas, ROLE_TOOL_INSTRUCTION, roleToolInstruction } from "./roleToolCatalog.js";
import { teamReadTools } from "./teamReadTools.js";
import { allRoles } from "../roleRouting.js";
import { roleToolAllowed } from "../lib/roleToolScope.js";
import { clockLine } from "../lib/clockLine.js";
import { currentChatGeneration, claimMessageDelivery, finishMessageDelivery, fenceMessageDelivery } from "./chatQueue.js";
import { agentMessagingTools } from "./agentMessaging.js";
import { WORK_PLAN_INSTRUCTION } from "../lib/subtaskWorkPlan.js";
import { orchestratorTools } from "./orchestratorTools.js";
import { ORCHESTRATE_SLOT, ORCHESTRATE_ASSEMBLE_SLOT } from "./orchestratedPlan.js";
import { resolveReviewTaskId } from "../lib/reviewTaskId.js";
import { beginTaskLiveTurn } from "./taskLiveTurn.js";
import { broadcastToUsers } from "../ws.js";
import { requireSubmissionReceipt, SUBMISSION_POLICY } from "../lib/submissionReceipt.js";
import { ROLE_REPORT_INSTRUCTION } from "../lib/roleReportPolicy.js";
import { searchNotes } from "../lib/noteSearch.js";
import { KB_CATEGORIES, KB_DROP_MARK } from "../lib/kbCategories.js";
import { secretaryMailTools } from "./secretaryMailTools.js";
import { secretaryThings3Tools } from "./secretaryThings3Tools.js";
import { secretaryAppleTools } from "./secretaryAppleTools.js";
import { openMidPlanCritic } from "./planSubtaskAdmission.js";
import { ensureResultVersionForReview } from "../resultVersions.js";
import { PLAN_ROLE_HELP_POLICY, planRoleHelpPolicy } from "./instructionDefaults.js";
import { acquireSlotSession,openSlotSession,rememberSlotSession,resolveTopicSlot } from "./slotSession.js";
import { pickRecipientSlot } from "./roleMessageWait.js";
import { connectRoleMcp } from "./graftMcp.js";
import { teamStructureText } from "../lib/teamStructure.js";
import { branchMembership } from "./branchPlan.js";
import { ensurePlanTopic, topicContext } from "../lib/projectTopics.js";
import { markPlanFinalReviewerStarted, markPlanFinalReviewerWaiting, hasPendingPlanFinalReview, planReviewRouteContext } from "./planReviewLifecycle.js";
import { instructionResources, createTaskResourceLoader } from "./instructionResources.js";
import { ensureRoleHome, renderPromptAddendum } from "./roleHome.js";
import { ThrashGuard, stepDigest } from "./thrashGuard.js";
import { connectRoleComposio } from "./composioRuntime.js";
import { roleProjectContext,roleProjectSnapshot } from "./roleProjectContext.js";
import { saveSlotSnapshot, slotSnapshotBlock, technicalSlotSnapshot } from "./slotWorkSnapshot.js";
import { resolutionHandoff, slotTeamMap } from "../lib/taskChatScope.js";
import { buildTaskHistory } from "./taskHistoryContext.js";
import { INSTRUCTION_DEFAULTS } from "./instructionDefaults.js";
import { buildRoleSliceText, collectRoleSlice } from "./roleSlice.js";
import { renderInstruction, effectiveRules, registerInstructionBlock, instructionManifest } from "../lib/roleContextResolver.js";
import { isOwner } from "../access.js";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import db from "../db.js";
import { AGENT_RULES, logEvent } from "../agentState.js";
import { loadRoleRouting, providerOfModel, rolePromptText, roleTitle, roleUserId, ROLE_NAMES } from "../roleRouting.js";
import { composeLayer } from "../lib/roleContextResolver.js";
import { instructionSnapshotValue } from "../lib/instructionManifestStore.js";
import { getModelRuntime, resolveThinkingLevel } from "./PiRuntimeAdapter.js";
import { parseModelRef, recordAttemptModel } from "../lib/attemptModel.js";
import { enqueueRoleRunJob } from "./roleRunQueue.js";
import { buildInProcessTaskContext } from "./taskContextBridge.js";
import { buildDependencyContext } from "./dependencyContext.js";
import { buildCollaborationPlanContext } from "./collaborationPlanContext.js";
import { projectRepo, roleWorkspace } from "./roleWorkspace.js";
import { RoleProcessLease } from "./roleProcessLease.js";
import { ROLE_USER, isolatedLocalOperations, roleIsolationEnabled } from "./localRoleOperations.js";
import { withRoleBashKillGuard } from "./roleBashGuard.js";
import { previousSessionDigest } from "./slotSession.js";
import { remoteRoleWorkspace } from "./roleWorkspace.js";
import { resolveRoleHost } from "./roleHost.js";
import { hostOperations, withHostToolExecution } from "./hostOperations.js";
import { ensureTaskArtifactFolder } from "../lib/taskArtifactFolder.js";
import { recordTaskDocument } from "../lib/taskOutcome.js";
import { isProviderLimitText, lastAssistantEmptyAnswer, lastAssistantLimitError, lastAssistantError, pickFailoverModel, pickStartModel } from "./providerFailover.js";
import { logStepOutcome } from "./stepOutcome.js";
import { classifyFailureReason } from "./failureReasons.js";
import { isNetworkFailure } from "./failurePolicy.js";
import { roleNote } from "./planSubtaskAdmission.js";
import { withTestCommandGuard } from "./testRunBudget.js";
import { ThinkingGuard } from "./thinkingGuard.js";
import { createExternalAgentSession } from "./externalAgentSession.js";
import { externalAgentBoost } from "./externalAgentActions.js";
import { agentBinary } from "../lib/externalAgents.js";
import { externalRuntime } from "../roleRouting.js";
import { roleRunToken } from "./roleRunAccess.js";
import {
  logServerEvent,
  normalizeServerError,
  recordServerOperation,
} from "../lib/serverEvents.js";

/**
 * Агент — часть TaskFlow, как профили у Гермеса (владелец 23.09.2026:
 * «делай как у Гермеса, без ключей»).
 *
 * Роль запускается ВНУТРИ сервера движком Pi (createAgentSession). Её
 * действия в трекере — не сетевые запросы с ключом, а внутренние вызовы
 * маршрутов сервера (app.inject) от имени учётки роли: права, лента и
 * правила те же, что для любого клиента, а наружу ничего не выдаётся.
 * Файлы, команды и правки кода — встроенные инструменты Pi.
 */

let app: FastifyInstance | null = null;
/** Ссылка на приложение для инструментов вне этого модуля (hostRoleTools). */
export function appRef(): FastifyInstance | null { return app; }

/** Подключается при старте сервера (index.ts). */
export function setInProcessApp(instance: FastifyInstance): void {
  app = instance;
}

type Json = Record<string, unknown>;

/** Отказ по правилам сервера: побочного действия не было, роль должна исправить
 *  аргументы или порядок шагов. status — HTTP-код внутреннего маршрута, если был. */
export class ToolError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ToolError";
    this.status = status;
  }
}

/** Внутренний вызов маршрута от имени роли. Подпись живёт в памяти сервера
 *  на один вызов: наружу не уходит, храниться нигде не нужно. */
export async function asRole(
  role: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
): Promise<any> {
  if (!app) throw new ToolError("сервер ещё не поднят");
  return asControlActor(roleUserId(role), method, url, body);
}

export async function asControlActor(actorId: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<any> {
  if (!app) throw new ToolError("сервер ещё не поднят");
  const token = app.jwt.sign({ id: actorId }, { expiresIn: "5m" });
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: body as any } : {}),
  });
  const raw = res.body;
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { text: raw };
  }
  if (res.statusCode >= 400) {
    throw new ToolError(`${method} ${url} → ${res.statusCode}: ${data?.error ?? raw.slice(0, 200)}`, res.statusCode);
  }
  return data;
}

// В датах «ГГГГ-ММ-ДД» месяц с единицы, а Date.UTC — с нуля: без «-1»
// весь период уезжал на месяц вперёд.
function eachDate(from: string, to: string, limit: number): string[] {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  const out: string[] = [];
  for (
    let d = Date.UTC(fy, fm - 1, fd);
    d <= Date.UTC(ty, tm - 1, td) && out.length < limit;
    d += 86_400_000
  ) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

export function unwrap(d: any): any {
  return d && typeof d === "object" && "task" in d ? d.task : d;
}

export function short(t: any): Json {
  // due_date и priority — необязательные: у задачи их может не быть, и тогда
  // ключей в ответе просто нет (проверка 'in' на undefined безопасна). Без них
  // роль не могла нарисовать timeline, календарь и просрочки по дням и
  // выдумывала даты — см. shortTaskDates.
  const dates = shortTaskDates(t);
  return {
    id: t?.id,
    название: t?.title,
    статус: t?.status,
    работа: t?.agent_state ?? "не взята",
    ...(dates.due_date ? { срок: dates.due_date } : {}),
    ...(dates.priority != null ? { приоритет: dates.priority } : {}),
  };
}

/** Срок и приоритет задачи в виде, пригодном для виджета. В БД due_date —
 *  текст "YYYY-MM-DD", start_time — "ЧЧ:ММ" (см. routes/tasks.ts). Даты вне
 *  календаря («2026-02-30») и пустые строки отбрасываются: помощник владельца получит
 *  прочерк и нарисует пустую ячейку, а не выдуманную дату. */
export function shortTaskDates(t: any): { due_date?: string; priority?: number } {
  const out: { due_date?: string; priority?: number } = {};
  const raw = typeof t?.due_date === "string" ? t.due_date.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (
      parsed.getUTCFullYear() === y &&
      parsed.getUTCMonth() === m - 1 &&
      parsed.getUTCDate() === d
    ) {
      out.due_date = raw;
    }
  }
  const pr = Number(t?.priority);
  if (Number.isInteger(pr) && pr >= 1 && pr <= 4) out.priority = pr;
  return out;
}

const STEP_STATE_RU: Record<string, string> = {
  in_progress: "в работе",
  blocked: "заблокирован",
  review: "на проверке",
};

export function asText(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: {},
  };
}

/** Живая строка «чем занят агент» в карточке. Мягко: сбой не роняет инструмент. */
async function postActivity(role: string, taskId: string, kind: string, target: string, subtaskId?: string): Promise<void> {
  try {
    await asRole(role, "POST", `/api/tasks/${taskId}/activity`, { kind, target, subtask_id: subtaskId });
  } catch {
    // активность — не работа
  }
}

const execFileAsync = promisify(execFile);

/**
 * Пять специальных инструментов роли researcher (web_search, web_get, ocr,
 * youtube, local_model) — реализованы в `scripts/mcp_server.py`, отданы
 * через `scripts/research_server.py`. Раньше цепляли их через отдельный
 * внешний MCP-профиль (`~/.pi/agent/taskflow-profiles/researcher.json`,
 * схема «внешний Pi-процесс говорит по MCP через stdio») — эта схема
 * умерла молча 23.09.2026, когда роли переехали исполняться внутри
 * сервера: `resourceLoader.getExtensions()` ниже всегда пуст, внешние MCP
 * вообще не подключаются. Владелец 30.09.2026, вспомнил и попросил
 * восстановить — но уже под сегодняшнюю схему: разовый процесс на вызов
 * (`research_server.py --call <name>`, аргументы JSON на stdin, результат
 * JSON на stdout), не полноценный MCP-хендшейк с долгоживущим процессом.
 * Реализации остаются одним кодом в mcp_server.py — не копируем в TS.
 */
const RESEARCH_TOOL_TIMEOUT_MS = 90_000; // web_get/youtube/ocr реально не мгновенные

/**
 * Прокси НЕ читаем из `researcher.json` и не зашиваем сюда сами — владелец
 * 30.09.2026: это была бы ровно ещё одна копия того же порта, что уже
 * захардкожен в `.bashrc` (`HTTP_PROXY=http://127.0.0.1:10811`, xray-claude)
 * — вторая точка, которую при смене сети забудут поправить, тот же класс
 * бага, что уже усыпил весь этот тулинг 23.09.2026. Наследуем process.env
 * как есть: если `taskflow-server.service` получит HTTP(S)_PROXY/NO_PROXY
 * из ЕДИНОГО systemd-уровневого источника (см. итог разговора) — все
 * дочерние процессы, в том числе этот, подхватят его сами, без своей копии.
 */
async function callResearchTool(name: string, args: unknown, role = "researcher"): Promise<unknown> {
  // Обвязка серверного журнала (карточка e87cd93f). Даже при тайм-ауте и
  // нестарте подпроцесса финальное событие записывается — без этого
  // operation_id висит без терминального исхода и цепочка вызовов рвётся.
  const op = recordServerOperation({
    scope: "mcp",
    kind: "mcp_call",
    subtype: name,
    message: `MCP-инструмент ${name}`,
    data: { tool: name, args_keys: args && typeof args === "object" ? Object.keys(args as object) : [] },
  });
  let stdout: string;
  try {
    // execFile (промисифицированный) не понимает опцию input, как
    // execFileSync — аргументы пишем в stdin самого child вручную, до
    // ожидания результата (PromiseWithChild даёт доступ к процессу через
    // .child, не дожидаясь await).
    const home = ensureRoleHome(role);
    const pending = execFileAsync("python3", [path.join(home.scripts, "research_server.py"), "--call", name], {
      cwd: home.workspace,
      timeout: RESEARCH_TOOL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        // Ролевой ключ — НЕ общий TASKFLOW_AGENT_TOKEN (он сознательно
        // отозван, см. CLAUDE.md §5.1), а свой, для собственных запросов
        // роли к API (например, скачать вложение задачи под ocr).
        // Ключ берётся по роли: Помощница владельца работает своим
        // учёткой/токеном, а не исследовательским (карточка e11eae7a).
        TASKFLOW_VAULT_KEY: `TASKFLOW_AGENT_TOKEN_${role.toUpperCase()}`,
      },
    });
    pending.child.stdin?.end(JSON.stringify(args ?? {}));
    const result = await pending;
    stdout = result.stdout;
  } catch (err: any) {
    // execFile бросает и на ненулевой exit code — наш --call всегда пишет
    // JSON в stdout ДО exit(1), так что содержательная ошибка обычно там же.
    stdout = err?.stdout ?? "";
    const timedOut = err?.code === "ETIMEDOUT" || err?.killed === true;
    const norm = normalizeServerError(err, "mcp_call_err");
    if (!stdout) {
      if (timedOut) {
        op.timeout({ message: `MCP ${name}: процесс превысил ${RESEARCH_TOOL_TIMEOUT_MS}мс` });
      } else {
        op.err({
          message: `MCP ${name}: процесс не запустился`,
          errorCode: norm.code,
          errorMessage: norm.message,
        });
      }
      throw new ToolError(`research-инструмент ${name} не запустился: ${err?.message ?? String(err)}`);
    }
    op.ok({ message: `MCP ${name}: ответ получен через stderr, но stdout не пуст` });
  }
  let parsed: { result?: unknown; error?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    op.err({
      message: `MCP ${name}: вернул не JSON`,
      data: { stdout_preview: stdout.slice(0, 200) },
      errorCode: "mcp_invalid_json",
    });
    throw new ToolError(`research-инструмент ${name} вернул не JSON: ${stdout.slice(0, 500)}`);
  }
  if (parsed.error) {
    op.err({
      message: `MCP ${name}: ${parsed.error}`,
      errorCode: "mcp_call_err",
      errorMessage: typeof parsed.error === "string" ? parsed.error : null,
    });
    throw new ToolError(parsed.error);
  }
  op.ok({ message: `MCP ${name}: готово` });
  return parsed.result;
}

/** Инструменты трекера для роли — те же имена и смысл, что в mcp_server.py,
 *  чтобы инструкции ролей не переписывать. Владелец 29.09.2026 (DESIGN.md
 *  «Роли плана — это подзадачи»): узел collaboration plan получает ТОТ ЖЕ
 *  полный набор, что и обычный запуск роли, без урезанного изолированного
 *  списка, который раньше был у slot'ов (`taskflow_slot_result`) — решение
 *  №2, «не вижу смысла что-то выдумывать, обычные тулы подзадачи более
 *  чем достаточно». */
/** `taskId` — карточка текущего хода: записанные `doc_write` документы
 *  привязываются к ней и попадают в её «Итог» (01.10.2026). */
export const PLAN_REQUEST_DESCRIPTION = "Достроить план из своего шага. kind=add_step — работа после твоей части; kind=request_help — результат другой роли нужен до завершения твоего шага: помощник стартует, твой шаг ждёт и продолжится автоматически. kind=rework — QA/критик возвращает на доработку. role, expected_result, reason обязательны для добавления. Проверь итог: applied / proposed / ошибка; сообщение коллеге не создаёт шаг.";
export const PLAN_REQUEST_PARAMETERS = Type.Object({
  subtask_id: Type.String(), kind: Type.String({description:"add_step | request_help | rework"}), reason: Type.String(),
  role: Type.Optional(Type.String()), expected_result: Type.Optional(Type.String()), instructions: Type.Optional(Type.String()), defects: Type.Optional(Type.String()),
  after: Type.Optional(Type.Array(Type.String())), before: Type.Optional(Type.Array(Type.String())),
});
export async function requestPlanStep(role: string, p: any, currentSubtaskId?: string) {
  const id = String(p.subtask_id ?? "").trim();
  if (!id) throw new ToolError("subtask_id — твой шаг плана (он есть в задании)");
  if (currentSubtaskId && id !== currentSubtaskId) throw new ToolError("Достраивай план только из назначенного текущего слота");
  const body: Json = {};
  for (const k of ["kind","role","expected_result","instructions","reason","after","before","defects"]) if(p[k]!=null) body[k]=p[k];
  const resp = await asRole(role,"POST","/api/subtasks/"+id+"/plan-request",body);
  const status = resp?.result?.status;
  return {итог:status==="applied"?"применено":status==="proposed"?"ждёт решения владельца":status,
    "почему ждёт":resp?.result?.reason,"новые шаги":resp?.result?.added,
    ожидание:resp?.waiting_for_help?"Твой шаг ждёт помощника. Заверши ход без сдачи шага; сервер продолжит после результата.":undefined,
    план:resp?.plan,связи:resp?.edges};
}

function taskflowToolsUnscoped(role: string) { return taskflowTools(role, null, undefined, undefined, true,{chatId:"",messageId:""}); }

export function taskflowTools(role: string, model: string | null, taskId?: string, subtaskId?:string, unscoped = false, chatContext?: {chatId:string;messageId:string}) {
  const activity = (role: string, taskId: string, kind: string, target: string) => postActivity(role, taskId, kind, target, subtaskId);
  const T = (
    name: string,
    description: string,
    parameters: any,
    run: (p: any) => Promise<unknown>,
  ) => {
    const key = "tool.runtime." + name;
    registerInstructionBlock({key,title:name,group:"Возможности",scope:"command",modes:["work","resume","reply","review","subtask"],sourceKind:"code",originRef:"inProcessRun.ts:taskflowTools:"+name,readOnly:false,
      ...(["web_search","web_get","ocr","youtube","local_model"].includes(name)?{roles:["researcher","secretary"]}:["taskflow_report"].includes(name)?{roles:["researcher"]}:{})},description);
    return defineTool({
      name,
      label: name,
      // Слоя может не быть (слой отфильтрован по роли или не зарегистрирован) —
      // тогда берём описание инструмента из кода, а не падаем.
      description: composeLayer(role,key)?.effective ?? description,
      parameters,
      execute: async (_id: string, params: any) => {
        try {
          if(subtaskId && ["taskflow_subtask_work","taskflow_subtask_done"].includes(name) && params.id!==subtaskId)throw new ToolError("Работай только в назначенном текущем слоте");
          if(subtaskId && ["taskflow_state","taskflow_heartbeat"].includes(name) && params.id!==taskId)throw new ToolError("Состояние относится только к текущему слоту");
          return asText(await run(params));
        } catch (e) {
          if (e instanceof ToolError) throw e;
          throw new Error(`сбой инструмента ${name}: ${String(e)}`);
        }
      },
    } as any);
  };
  const Id = Type.Object({ id: Type.String() });
  /** Форма снимка работы слота — одна и та же для отдельного инструмента,
   *  сдачи шага и блокировки, чтобы роль не разбиралась в трёх форматах. */
  const SNAPSHOT_SHAPE = Type.Object({
    done: Type.Optional(Type.String()),
    left: Type.Optional(Type.String()),
    blocker: Type.Optional(Type.String()),
    next_step: Type.Optional(Type.String()),
    artifacts: Type.Optional(Type.Array(Type.Any())),
  });

  let topicSends=0;
  const tools = [
    ...agentMessagingTools(role, {taskId,subtaskId,chatId:chatContext?.chatId,messageId:chatContext?.messageId}),
    T("taskflow_plan_request", PLAN_REQUEST_DESCRIPTION, PLAN_REQUEST_PARAMETERS, p => requestPlanStep(role,p,subtaskId)),
    T("taskflow_task_proposal", "По просьбе человека отправить настоящую карточку задачи для согласования. Для обычного упоминания используй текст со ссылкой. Доступно каждой роли.", Type.Object({chat_id:Type.String(),task_id:Type.String(),text:Type.String()}), async(p)=>asRole(role,"POST",`/api/chats/${p.chat_id}/messages`,{task_id:p.task_id,text:p.text,kind:"task_proposal",work_mode:"work"})),
    T("taskflow_topic_reply", "Ответить на конкретное сообщение темы своей задачи: message_id и короткий text. Сервер определяет автора вопроса и его этап; подходит для ответа человеку и коллеге.",Type.Object({message_id:Type.String(),text:Type.String()}),async(p)=>{
      if(!taskId)throw new ToolError("Нет текущей задачи");
      if(topicSends>=4)throw new ToolError("Лимит обращений в этом запуске исчерпан");
      const original=db.prepare("SELECT m.chat_id,m.from_user_id,m.subtask_id,c.task_id,u.name,u.role_key FROM chat_messages m JOIN chats c ON c.id=m.chat_id JOIN users u ON u.id=m.from_user_id WHERE m.id=? AND c.parent_chat_id IS NOT NULL").get(p.message_id) as {chat_id:string;from_user_id:string;subtask_id:string|null;task_id:string;name:string;role_key:string|null}|undefined;
      if(!original || (original.task_id!==taskId && (!branchMembership(taskId) || branchMembership(original.task_id)?.root_plan_id!==branchMembership(taskId)?.root_plan_id)))throw new ToolError("Сообщение не относится к согласованной ветке");
      if(original.from_user_id===roleUserId(role))throw new ToolError("Не отвечай сам себе");
      const recipient=original.subtask_id && original.role_key ? resolveTopicSlot(original.task_id,original.role_key,undefined,original.subtask_id)?.id : undefined;
      const source=subtaskId;
      topicSends++;
      return asRole(role,"POST",`/api/chats/${original.chat_id}/messages`,{text:`@${original.role_key ?? original.name} ${p.text}`,work_mode:"work",subtask_id:source,recipient_subtask_id:recipient,reply_to_message_id:p.message_id});
    }),
    T("taskflow_topic_read", "Прочитать состав, зависимости и последние сообщения темы текущей задачи.", Type.Object({task_id:Type.Optional(Type.String())}), async(p)=>{
      if(!taskId) throw new ToolError("Нет текущей задачи");
      const target=p.task_id??taskId;
      if(target!==taskId && (!branchMembership(taskId) || branchMembership(target)?.root_plan_id!==branchMembership(taskId)?.root_plan_id)) throw new ToolError("Тема вне согласованной ветки");
      return topicContext(target) || "У задачи пока нет темы";
    }),
    T("taskflow_topic_send", "Написать участнику текущей темы или темы task_id в общей согласованной ветке. to — role_key участника. Не запускает этап коллеги; максимум 4 обращения за этот запуск.", Type.Object({to:Type.String(),text:Type.String(),slot_key:Type.Optional(Type.String()),task_id:Type.Optional(Type.String()),reply_to_message_id:Type.Optional(Type.String())}), async(p)=>{
      if(!taskId) throw new ToolError("Нет текущей задачи");
      if(topicSends>=4) throw new ToolError("Лимит обращений в этом запуске исчерпан; зафиксируй блок или результат");
      const target=p.task_id??taskId;
      if(target!==taskId && (!branchMembership(taskId) || branchMembership(target)?.root_plan_id!==branchMembership(taskId)?.root_plan_id)) throw new ToolError("Тема вне согласованной ветки");
      const topic=db.prepare("SELECT id FROM chats WHERE task_id=? AND parent_chat_id IS NOT NULL").get(target) as {id:string}|undefined;
      if(!topic) throw new ToolError("У задачи пока нет темы");
      if(!ROLE_NAMES.includes(p.to)) throw new ToolError("Укажи доступную роль");
      if(p.to===role){
        const own=subtaskId ? db.prepare("SELECT plan_node_key FROM subtasks WHERE id=?").get(subtaskId) as {plan_node_key:string}|undefined : undefined;
        if(target===taskId && (!own || !p.slot_key || own.plan_node_key===p.slot_key)) throw new ToolError("Не адресуй сообщение своему слоту");
      }
      const targetSlots=db.prepare("SELECT n.slot_key FROM task_collaboration_plan_nodes n JOIN task_collaboration_plans p ON p.id=n.plan_id WHERE p.task_id=? AND p.status='approved' AND n.role_key=? AND n.skipped_at IS NULL").all(target,p.to) as {slot_key:string}[];
      if(!db.prepare("SELECT 1 FROM chat_members WHERE chat_id=? AND member_id=?").get(topic.id,roleUserId(p.to))) {
        // Участник утверждённого плана, которого не добавили в тему, — наш
        // рассинхрон, а не ошибка роли: добавляем (6 отказов за 18–19.10.2026).
        if(targetSlots.length) db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(topic.id,roleUserId(p.to));
        else {
          const members=(db.prepare("SELECT u.role_key FROM chat_members m JOIN users u ON u.id=m.member_id WHERE m.chat_id=? AND u.role_key IS NOT NULL").all(topic.id) as {role_key:string}[]).map(m=>m.role_key);
          throw new ToolError(`Роль ${p.to} не участвует в теме. Участники: ${members.join(", ")||"нет ролей"}.`);
        }
      }
      const pick=pickRecipientSlot(p.to,p.slot_key,targetSlots.map(t=>t.slot_key));
      if("refusal" in pick) throw new ToolError(pick.refusal);
      p.slot_key=pick.slot;
      if(p.reply_to_message_id) {
        const original=db.prepare("SELECT from_user_id FROM chat_messages WHERE id=? AND chat_id=?").get(p.reply_to_message_id,topic.id) as {from_user_id:string}|undefined;
        if(!original || original.from_user_id!==roleUserId(p.to)) throw new ToolError("Ответ адресуй автору исходного вопроса");
      }
      topicSends++;
      const result = await asRole(role,"POST",`/api/chats/${topic.id}/messages`,{text:`@${p.to} ${p.slot_key ? `[slot: ${p.slot_key}] ` : ""}${String(p.text)}`,work_mode:"work",subtask_id:subtaskId,recipient_subtask_id:resolveTopicSlot(target,p.to,p.slot_key)?.id,reply_to_message_id:p.reply_to_message_id});
      // Сообщение в теме — это фактическая активность роли, обновляем метку
      // для sweeper тишины. Иначе роль, которая 30 минут только пишет в чат,
      // будет ошибочно прервана (доработка MAK-66, critic 05.10.2026).
      touchTaskActivity(target);
      return result;
    }),
    T("taskflow_consult", "Получить второе мнение старшей модели по текущему рабочему слоту. Один совет на попытку; совет не меняет граф и приёмку.",Type.Object({question:Type.String(),context:Type.Optional(Type.Any()),task_id:Type.Optional(Type.String()),subtask_id:Type.Optional(Type.String())}),async(p)=>{
      if(subtaskId && ((p.task_id && p.task_id!==taskId)||(p.subtask_id && p.subtask_id!==subtaskId)))throw new ToolError("Консультация относится только к текущему слоту");
      return asRole(role,"POST","/api/consult",{question:p.question,context:p.context,task_id:taskId??p.task_id,subtask_id:subtaskId??p.subtask_id});
    }),
    T("taskflow_my_tasks", "Мои задачи (назначенные на эту роль). state: free | in_progress | review | blocked.",
      Type.Object({ state: Type.Optional(Type.String()), include_completed: Type.Optional(Type.Boolean()) }),
      async (p) => {
        const me = roleUserId(role);
        let tasks = (await asRole(role, "GET", "/api/tasks?include_children=true")) as any[];
        const ownSteps = db.prepare("SELECT * FROM subtasks WHERE agent_id=? AND done=0 AND collaboration_plan_id IN (SELECT id FROM task_collaboration_plans WHERE status='approved')").all(me) as any[];
        const stepTaskIds = new Set(ownSteps.map(s=>s.task_id));
        tasks = tasks.filter((t) => t.assignee_id === me || stepTaskIds.has(t.id));
        if (p.include_completed !== true) tasks = tasks.filter((t) => t.status === "active");
        if (p.state === "free") tasks = tasks.filter((t) => !t.agent_state);
        else if (p.state) tasks = tasks.filter((t) => t.agent_state === p.state || ownSteps.some(s=>s.task_id===t.id && s.agent_state===p.state));
        return { всего: tasks.length, задачи: tasks.map(t=>({...short(t), рабочие_слоты:ownSteps.filter(s=>s.task_id===t.id).map(s=>({id:s.id,состояние:s.agent_state,название:s.title}))})) };
      }),
    T("taskflow_task_daily", "Счёт по дням за период — готовые ячейки для heatmap и calendar_grid. bucket: due (сроки) | created (создано) | completed (закрыто). Считает сервер, роль складывает числа только сама.",
      Type.Object({ from: Type.String(), to: Type.String(), bucket: Type.Optional(Type.String()) }),
      async (p) => {
        const q = new URLSearchParams({ from: p.from, to: p.to });
        if (p.bucket) q.set("bucket", p.bucket);
        const d = await asRole(role, "GET", `/api/tasks/summary?${q.toString()}`);
        // Даты уже пришли валидными (маршрут их проверяет) — отдаём как есть.
        return { ...d, _подсказка: "каждый день периода приходит ячейкой, value — счётчик" };
      }),
    T("taskflow_calendar_events", "События календаря Google на дату (ГГГГ-ММ-ДД) или на период (from/to). Если календарь не подключён — придёт пустой список, это не ошибка.",
      Type.Object({ date: Type.Optional(Type.String()), from: Type.Optional(Type.String()), to: Type.Optional(Type.String()) }),
      async (p) => {
        const dates: string[] = [];
        if (p.from && p.to) {
          dates.push(...eachDate(p.from, p.to, 31)); // месяц за запрос — иначе блок не влезет
        } else if (p.date) {
          dates.push(p.date);
        } else {
          return { ошибка: "нужен date (ГГГГ-ММ-ДД) либо from и to" };
        }
        const byDate: Record<string, any[]> = {};
        for (const date of dates) {
          const d = (await asRole(role, "GET", `/api/integrations/google/calendar-events?date=${date}`)) as any;
          const events = (d?.events ?? []) as any[];
          // Дату события приводим к «ГГГГ-ММ-ДД»: Google отдаёт для
          // событий на весь день start.date, а для timed — дату со временем.
          for (const ev of events) {
            const day = String(ev.startDate ?? "").slice(0, 10);
            (byDate[day] ??= []).push({
              название: ev.title,
              начало: ev.startDate,
              конец: ev.endDate,
              весь_день: !!ev.allDay,
              где: ev.location,
              календарь: ev.calendarTitle,
            });
          }
        }
        return {
          дней: dates.length,
          событий_всего: Object.values(byDate).reduce((s, a) => s + a.length, 0),
          "по дням": byDate,
          _подсказка: "дни без событий в по дням не попадают — это нормально",
        };
      }),
    T("taskflow_archive", "Поместить карточку или проект в архив. Архивирование сохраняет данные; физическое удаление недоступно.", Type.Object({ kind: Type.Union([Type.Literal("task"), Type.Literal("project")]), id: Type.String({ minLength: 1 }) }), async (p) => {
      if (p.kind === "task") return asRole(role, "POST", "/api/tasks/" + encodeURIComponent(p.id) + "/archive", {});
      return asRole(role, "DELETE", "/api/projects/" + encodeURIComponent(p.id));
    }),
    T("taskflow_task", "Карточка задачи целиком: описание, шаги, лента.", Id, async (p) => {
      const d = await asRole(role, "GET", `/api/tasks/${p.id}`);
      const task = unwrap(d);
      void activity(role, p.id, "read", "карточке задачи");
      const feed = [
        ...(d.comments ?? []).map((c: any) => ({ когда: c.created_at, кто: c.user_name, комментарий: c.text })),
        ...(d.events ?? []).map((e: any) => ({
          когда: e.created_at, кто: e.actor_name ?? "Система", событие: e.kind, поле: e.field, стало: e.to_value,
        })),
      ].sort((a, b) => String(a.когда).localeCompare(String(b.когда)));
      return {
        ...short(task),
        описание: task.description,
        шаги: (d.subtasks ?? task.subtasks ?? []).map((s: any) => ({
          id: s.id, сделан: !!s.done, состояние: STEP_STATE_RU[s.agent_state ?? s.state] ?? "не в работе", название: s.title,
        })),
        лента: feed,
      };
    }),
    T("taskflow_claim", "Взять личную задачу в работу. В командном плане не захватывай карточку: работай через taskflow_subtask_work со своим утверждённым слотом.", Id, async (p) => {

      const resp = await asRole(role, "POST", `/api/tasks/${p.id}/claim`, { model, runner: "Pi" });
      void activity(role, p.id, "edit", "статус: взял задачу в работу");
      return { "взято в работу": short(unwrap(resp)), правила: resp.rules ?? undefined };
    }),
    T("taskflow_heartbeat", "Продлить аренду задачи. Сервер продлевает её и сам, пока идёт запуск.", Id, async (p) => {
      await asRole(role, "POST", subtaskId && p.id===taskId ? `/api/subtasks/${subtaskId}/work` : `/api/tasks/${p.id}/heartbeat`, {});
      return { "аренда продлена": p.id };
    }),
    T("taskflow_state", "Сменить состояние работы: review — сдать на проверку, blocked — упёрся и жду владельца, in_progress — вернуться. Для review и blocked комментарий обязателен. blocked принимается только с block_type: dependency (ждёт другой шаг и снимется сам), needs_input (нужно решение), capability (нет компетенции), transient (временное); для needs_input укажи changes_result=true, если это меняет «Результат», «Критерии приёмки» или «Границы». Перед blocked реши, может ли помочь другая роль или более сильная модель; если позвал — укажи help_attempt («кого звал, что ответили»), если никто не решит — help_skip_reason. Без этого сервер откажет.",
      Type.Object({ id: Type.String(), state: Type.String(), comment: Type.Optional(Type.String()), block_type: Type.Optional(Type.String()), changes_result: Type.Optional(Type.Boolean()), help_attempt: Type.Optional(Type.String()), help_skip_reason: Type.Optional(Type.String()) }),
      async (p) => {
        if(subtaskId && p.id===taskId && ["in_progress","blocked","review"].includes(p.state)) {
          await asRole(role,"POST",`/api/subtasks/${subtaskId}/work`,{state:p.state,...(p.comment ? {result:p.comment}:{}),...(p.block_type ? {block_type:p.block_type}:{}),...(p.changes_result ? {changes_result:p.changes_result}:{}),...(p.help_attempt ? {help_attempt:p.help_attempt}:{}),...(p.help_skip_reason ? {help_skip_reason:p.help_skip_reason}:{})});
          return {"состояние изменено":{task_id:taskId,subtask_id:subtaskId,состояние:p.state}};
        }
        const body: Json = { state: p.state };
        if (p.comment) body.comment = p.comment;
        if (p.block_type) body.block_type = p.block_type;
        if (p.changes_result) body.changes_result = p.changes_result;
        if (p.help_attempt) body.help_attempt = p.help_attempt;
        if (p.help_skip_reason) body.help_skip_reason = p.help_skip_reason;
        const resp = await asRole(role, "POST", `/api/tasks/${p.id}/state`, body);
        return { "состояние изменено": short(unwrap(resp)) };
      }),
    T("taskflow_review", "id — ID ВСЕЙ текущей задачи, не подзадачи. Единственный способ сдать работу критика: текст changes_requested в отчёте не оформляет возврат. Всегда вызови этот инструмент; не закрывай шаг через subtask_done или artifact. Вердикт по сданной задаче: approved или changes_requested (с комментарием). Только для проверяющего. Для возврата плана rework_steps — ключи первых дефектных этапов текущего цикла; несколько только для независимых параллельных веток. report_markdown — отчёт для владельца с разделами ## Результат, ## Что сделано, ## Проверки, ## Ограничения, ## Материалы; исключение: result_review/code_review используют короткий разовый формат из инструкции шаблона, без автоматической доработки. " + SUBMISSION_POLICY,
      Type.Object({ id: Type.String(), verdict: Type.String(), report_markdown: Type.Optional(Type.String()), findings: Type.Optional(Type.String()), rework_steps: Type.Optional(Type.Array(Type.String())) }),
      async (p) => {
        const step = db.prepare("SELECT task_id, agent_id FROM subtasks WHERE id=?").get(p.id) as
          { task_id: string; agent_id: string | null } | undefined;
        const reviewTaskId = taskId ? resolveReviewTaskId(p.id, taskId, roleUserId(role), step) : p.id;
        const versions = await asRole(role, "GET", `/api/tasks/${reviewTaskId}/versions`);
        let current = (versions.versions ?? []).find((v: any) => v.is_current);
        // Промежуточная проверка идёт до сдачи плана, версии результата ещё нет:
        // заводим её из уже сданных шагов, иначе вердикт сдать нечем.
        if (!current && subtaskId && openMidPlanCritic(reviewTaskId)?.subtaskId === subtaskId) {
          const done = db.prepare("SELECT title, result FROM subtasks WHERE task_id = ? AND done = 1 AND result IS NOT NULL ORDER BY position").all(reviewTaskId) as Array<{ title: string; result: string }>;
          if (done.length) {
            ensureResultVersionForReview(reviewTaskId, roleUserId(role), done.map(n => `${n.title}: ${n.result}`).join("\n"));
            current = ((await asRole(role, "GET", `/api/tasks/${reviewTaskId}/versions`)).versions ?? []).find((v: any) => v.is_current);
          }
        }
        if (!current) throw new ToolError("у задачи нет актуальной версии результата — проверять нечего");
        const findings = (p.findings ?? "").trim();
        const body: Json = {
          task_id: reviewTaskId, version_id: current.id, artifact_hash: current.artifact_hash,
          criteria_version: "1", task_revision: current.task_revision, verdict: p.verdict,
        };
        if (findings) body.findings = findings;
        if (p.report_markdown) body.report_markdown = p.report_markdown;
        if (p.rework_steps) body.rework_steps = p.rework_steps;
        if (p.verdict === "changes_requested") {
          if (!findings) throw new ToolError("для возврата нужен комментарий: что доработать");
          const review = await asRole(role, "POST", "/api/reviews", body);
          if (!review.handled_by_plan) await asRole(role, "POST", `/api/tasks/${reviewTaskId}/state`, { state: "in_progress", comment: findings });
          if(subtaskId && !review.submission_receipt) throw new ToolError("Сдача проверяющего не подтверждена основным TaskFlow");
          const receipt=review.submission_receipt ? requireSubmissionReceipt(await asRole(role,"GET", `/api/subtasks/${review.submission_receipt.subtask_id}/submission-receipt`),review.submission_receipt.subtask_id) : null;
          return { вердикт: "возвращено на доработку", комментарий: findings, ...(receipt ? {submission_receipt:receipt}: {}) };
        }
        const resp = await asRole(role, "POST", "/api/reviews", body);
        const receipt=resp.submission_receipt ? requireSubmissionReceipt(await asRole(role,"GET", `/api/subtasks/${resp.submission_receipt.subtask_id}/submission-receipt`),resp.submission_receipt.subtask_id) : null;
        if(subtaskId && !receipt) throw new ToolError("Сдача проверяющего не подтверждена основным TaskFlow");
        return { вердикт: resp.verdict, комментарий: resp.findings, ...(receipt ? {submission_receipt:receipt}: {}) };
      }),
    T("taskflow_comment", "Комментарий в ленту задачи.",
      Type.Object({ id: Type.String(), text: Type.String() }),
      async (p) => {
        await asRole(role, "POST", `/api/tasks/${p.id}/comments`, { text: p.text });
        void activity(role, p.id, "edit", "ленту задачи: оставил комментарий");
        // Комментарий в ленту — тоже признак движения роли; иначе долгие
        // дискуссии в ленте ошибочно истолкуются как тишина (доработка MAK-66).
        touchTaskActivity(p.id);
        return { "комментарий добавлен": p.id };
      }),
    T("taskflow_subtask_add", "Добавить шаг в задачу.",
      Type.Object({ task_id: Type.String(), title: Type.String(), after_id: Type.Optional(Type.String()) }),
      async (p) => {
        const body: Json = { title: p.title };
        if (p.after_id) body.after_id = p.after_id;
        const s = await asRole(role, "POST", `/api/tasks/${p.task_id}/subtasks`, body);
        return { "шаг добавлен": s.title, id: s.id };
      }),
    T("taskflow_work_plan", subtaskId ? WORK_PLAN_INSTRUCTION + "\nПрочитать или обновить свой внутренний рабочий чек-лист. Без items — чтение. Для записи: весь список items {id,title,state: pending|in_progress|done} и base_revision из последнего ответа. Обычно 3–7 конкретных этапов; только один in_progress. Сохраняй id этапов при обновлении. Это отображение твоего плана, оно не меняет состояние и сдачу подзадачи. В ЧАТЕ (без слота) план — на эту сессию чата и виден владельцу над полем ввода: заводи его только для многошаговой работы, на простой ответ или вопрос — не нужен. Когда все этапы done, план закрыт и из полоски пропадает; на следующее поручение заводи новый план — его можно записать поверх закрытого без base_revision." : "Чек-лист одной роли в чате. Без items — прочитай сохранённый план. Для работы заведи один пункт, если результат простой, или несколько законченных результатов; на короткий вопрос план не нужен. Для записи передавай полный список items {id,title,state} с устойчивыми id и base_revision последнего ответа. Текущий пункт и состояния определяет сервер: не меняй done вручную, сдай текущий результат через taskflow_work_item_submit. Следующий пункт доступен только после успешной сдачи текущего; ответ submit содержит следующий пункт. Начатый пункт нельзя удалить, переименовать или обойти перестановкой. Дополняй план только нужными результатами. Остановленный план продолжать нельзя; новый план — только по новому поручению владельца.",
      Type.Object({base_revision:Type.Optional(Type.Number()), items:Type.Optional(Type.Array(Type.Object({id:Type.String(),title:Type.String(),state:Type.Union([Type.Literal("pending"),Type.Literal("in_progress"),Type.Literal("done")])})))}),
      async (p) => {
        // Без слота, но в чате — чек-лист этой чатовой сессии роли (21.10.2026).
        const planPath = subtaskId ? `/api/subtasks/${subtaskId}/work-plan`
          : chatContext?.chatId ? `/api/chats/${chatContext.chatId}/work-plan` : null;
        if (!planPath) throw new ToolError("Рабочий план относится к текущему слоту подзадачи или к чату");
        return await asRole(role, p.items === undefined ? "GET" : "PUT", planPath,
          p.items === undefined ? undefined : {base_revision:p.base_revision,items:p.items,...(!subtaskId && chatContext?.messageId ? {message_id:chatContext.messageId} : {})});
      }),
    T("taskflow_work_item_submit", "Сдать текущий пункт чатового чек-листа: result — 1–2 предложения, что сделано. Сервер отметит пункт и только после этого выдаст следующий. Пункт — законченный результат, а не вызов инструмента; пункт вне очереди не принимается. Пункт заблокирован — outcome blocked и block_type (dependency | needs_input | capability | transient).",
      Type.Object({item_id:Type.String(),result:Type.Optional(Type.String()),outcome:Type.Optional(Type.Union([Type.Literal("done"),Type.Literal("blocked")])),block_type:Type.Optional(Type.String()),reason:Type.Optional(Type.String()),role:Type.Optional(Type.String({description:"Ключ вызванной тобой роли (taskflow_call_role): сдать или заблокировать пункт её плана по её результату"}))}),
      async (p) => {
        if (!chatContext?.chatId) throw new ToolError("Сдача пункта относится к чатовому ходу: в карточке шаг сдают через taskflow_subtask_done");
        const body: Json = { item_id: p.item_id, outcome: p.outcome ?? "done" };
        if (p.result !== undefined) body.result = p.result;
        if (p.block_type) body.block_type = p.block_type;
        if (p.reason) body.reason = p.reason;
        if (p.role) body.role = p.role;
        // Ключ идемпотентности и поколение выводит сервер из доставки: модель
        // не придумывает ключи и не может подделать повтор.
        if (chatContext.messageId) body.message_id = chatContext.messageId;
        return await asRole(role, "POST", `/api/chats/${chatContext.chatId}/work-plan/submit`, body);
      }),
    T("taskflow_subtask_work", "Состояние шага: in_progress перед началом, blocked с причиной; result — итог. blocked принимается только с block_type: dependency | needs_input | capability | transient; для needs_input укажи changes_result=true, если меняет «Результат», «Критерии приёмки» или «Границы». При blocked приложи snapshot: что сделано, что осталось, блок и следующий шаг — сервер сохранит это ДО смены состояния. Перед blocked по решаемой причине укажи help_attempt (кого звал, что ответили) или help_skip_reason (почему никто не решит). Пока работа идёт, технический снимок сервер пишет сам; при прогрессе и сдаче снимок от тебя не нужен.",
      Type.Object({ id: Type.String(), state: Type.Optional(Type.String()), result: Type.Optional(Type.String()), block_type: Type.Optional(Type.String()), changes_result: Type.Optional(Type.Boolean()), snapshot: Type.Optional(SNAPSHOT_SHAPE), help_attempt: Type.Optional(Type.String()), help_skip_reason: Type.Optional(Type.String()) }),
      async (p) => {
        const body: Json = {};
        if (p.state !== undefined) body.state = p.state;
        if (p.result !== undefined) body.result = p.result;
        if (p.block_type) body.block_type = p.block_type;
        if (p.changes_result) body.changes_result = p.changes_result;
        if (p.snapshot) body.snapshot = p.snapshot;
        if (p.help_attempt) body.help_attempt = p.help_attempt;
        if (p.help_skip_reason) body.help_skip_reason = p.help_skip_reason;
        const row = await asRole(role, "POST", `/api/subtasks/${p.id}/work`, body);
        if (p.state === "in_progress" && row.task_id) void activity(role, row.task_id, "edit", `шаг «${row.title ?? ""}»: начал`);
        // Сдача и перевод шага — фактическая активность, обновляем метку для
        // sweeper (доработка MAK-66, critic 05.10.2026).
        if (row?.task_id) touchTaskActivity(row.task_id);
        return { подзадача: row.title, состояние: STEP_STATE_RU[row.state] ?? "не в работе", итог: row.result ?? "—" };
      }),
    T("taskflow_slot_snapshot", "Записать, где остановилась работа по текущему слоту: done (сделано), left (что осталось), blocker (текущий блок), next_step (следующий шаг), artifacts (ссылки на артефакты). Нужен при блокировке: сфотографировал, на чём встал, — и засыпаешь. Пока ход идёт, технический снимок сервер пишет сам, без модели: при прогрессе и сдаче звать не нужно. Это запись о работе: прав и статусов не даёт.",
      SNAPSHOT_SHAPE, async (p) => {
        if (!subtaskId) throw new ToolError("Снимок относится к слоту — работать без узла плана нельзя");
        const result = await asRole(role, "POST", `/api/subtasks/${subtaskId}/snapshot`, { ...p, reason: "progress" });
        // Снимок слота — тоже признак работы роли (доработка MAK-66).
        if (taskId) touchTaskActivity(taskId);
        return result;
      }),
    T("taskflow_subtask_done", "Закрыть шаг с итогом (result — одно-два предложения, не длиннее 400 символов: длиннее сервер отклонит, подробности — в комментарий). Сервер сам сохранит технический снимок при сдаче — отдельный snapshot не нужен. Если шаг — узел плана с контрактом на структурный артефакт (feature_spec и т.п.), передай artifact вместо простого закрытия галочкой: summary, payload (объект с required_fields) и evidence. report_markdown — отчёт для владельца с разделами ## Результат, ## Что сделано, ## Проверки, ## Ограничения, ## Материалы; правила отчёта — в системной инструкции. contract_v1 — необязательный конверт роли (ok, output, artifacts, error, next_hint, needs_human): сервер проверит его и возьмёт output как result, если result не передан; result, report_markdown и artifact работают как раньше. " + SUBMISSION_POLICY,
      Type.Object({
        id: Type.String(),
        result: Type.Optional(Type.String()),
        report_markdown: Type.Optional(Type.String()),
        done: Type.Optional(Type.Boolean()),
        snapshot: Type.Optional(SNAPSHOT_SHAPE),
        contract_v1: Type.Optional(Type.Object({
          ok: Type.Boolean(),
          output: Type.String(),
          artifacts: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
          error: Type.Optional(Type.String()),
          next_hint: Type.Optional(Type.String()),
          needs_human: Type.Optional(Type.Boolean()),
        })),
        artifact: Type.Optional(Type.Object({ summary: Type.String(), payload: Type.Any(), report_markdown: Type.String(), evidence: Type.Optional(Type.Array(Type.Any())) })),
      }),
      async (p) => {
        if (p.artifact) {
          const row = await asRole(role, "POST", `/api/subtasks/${p.id}/artifact`, p.artifact);
          void activity(role, row.subtask?.task_id ?? "", "edit", `шаг «${row.subtask?.title ?? ""}»: сдал артефакт`);
          // Сдача артефакта — тоже движение роли (доработка MAK-66).
          if (row.subtask?.task_id) touchTaskActivity(row.subtask.task_id);
          if(!row.artifact?.id) throw new ToolError("Сдача не подтверждена: сервер не вернул ID артефакта");
          const receipt=requireSubmissionReceipt(await asRole(role,"GET", `/api/subtasks/${p.id}/submission-receipt`),p.id,row.artifact?.id);
          return { "артефакт сдан": p.id, версия: row.artifact?.version_no, submission_receipt:receipt };
        }
        const done = p.done ?? true;
        const body: Json = { done };
        if (p.result) body.result = p.result;
        if (p.report_markdown) body.report_markdown = p.report_markdown;
        if (p.contract_v1) body.contract_v1 = p.contract_v1;
        if (p.snapshot) body.snapshot = p.snapshot;
        const row = await asRole(role, "PATCH", `/api/subtasks/${p.id}`, body);
        if (done && row.task_id) void activity(role, row.task_id, "edit", `шаг «${row.title ?? ""}»: закрыл`);
        const receipt=done ? requireSubmissionReceipt(await asRole(role,"GET", `/api/subtasks/${p.id}/submission-receipt`),p.id) : null;
        return { [done ? "шаг отмечен" : "отметка снята"]: p.id, ...(receipt ? {submission_receipt:receipt} : {}) };
      }),
    T("taskflow_rules", "Правила ведения учёта.", Type.Object({}), async () => ({ правила: effectiveRules(role) })),
    T("taskflow_tool_request", "Попросить инструмент, закрытый твоей ролью. Нужен, когда discover показал нужное действие с available:false и без него работа невозможна: не обходи ограничение и не делай вид, что задача не в этом. tool — имя действия из каталога (например taskflow_subtask_add), why — зачем оно нужно в этой работе, attempted — что ты пыталась сделать вместо него. Заявку смотрит владелец; ответ придёт в карточку.",
      Type.Object({ tool: Type.String({ minLength: 3, maxLength: 100 }), why: Type.String({ minLength: 10, maxLength: 1000 }), attempted: Type.Optional(Type.String({ maxLength: 1000 })) }),
      async (p) => {
        const resp = await asRole(role, "POST", "/api/role-tool-requests", {
          tool: p.tool, why: p.why, attempted: p.attempted, task_id: taskId, subtask_id: subtaskId,
        });
        return { "заявка отправлена": short(unwrap(resp)) };
      }),
    T("taskflow_projects", "Проекты.", Type.Object({}), async () => ({
      проекты: ((await asRole(role, "GET", "/api/projects")) as any[]).map((p) => ({
        id: p.id, название: p.name, документация: p.notes_folder_id ? "есть" : "не заведена",
      })),
    })),
    T("taskflow_docs", "Документация проекта: список заметок.",
      Type.Object({ project_id: Type.String() }),
      async (p) => {
        const d = await asRole(role, "GET", `/api/projects/${p.project_id}/docs`);
        if (!d.folder) return { документация: "папка не заведена" };
        return {
          папка: d.folder.name,
          заметки: (d.notes ?? []).map((n: any) => ({ id: n.id, название: n.title || "без названия", начало: n.preview })),
        };
      }),
    T("taskflow_doc_read", "Прочитать заметку документации целиком.", Id, async (p) => {
      const n = await asRole(role, "GET", `/api/notes/${p.id}?format=markdown`);
      return { название: n.title || "без названия", текст: n.markdown ?? "" };
    }),
    T("taskflow_doc_write", "Записать в документацию: новая заметка (project_id, library_subfolder или taskId) или дописать в существующую (id).",
      Type.Object({
        markdown: Type.String(),
        id: Type.Optional(Type.String()),
        project_id: Type.Optional(Type.String()),
        library_subfolder: Type.Optional(Type.String()),
      }),
      async (p) => {
        if (!String(p.markdown).trim()) throw new ToolError("нечего записывать: markdown пуст");
        if (p.id) {
          const cur = await asRole(role, "GET", `/api/notes/${p.id}?format=markdown`);
          const merged = `${String(cur.markdown ?? "").trimEnd()}\n\n${p.markdown}`.trim();
          const n = await asRole(role, "PATCH", `/api/notes/${p.id}`, { markdown: merged });
          if (taskId) recordTaskDocument(taskId, n.id, roleUserId(role));
          return { готово: "заметка обновлена", id: n.id, material: {kind:"document",title:n.title || "Документ",ref:`note://${n.id}`}, подсказка:"Для чтения в чате отправь через taskflow_chat_share_material. В materials/artifacts используй material, не голый ID." };
        }
        let folderId: number;
        if(taskId) folderId=ensureTaskArtifactFolder(taskId);
        else if (p.library_subfolder) {
          const lib = await asRole(role, "GET", "/api/library") as any;
          const sub = (lib?.subfolders ?? []).find((s: any) => s.name === p.library_subfolder);
          if (!sub) throw new ToolError(`в Library нет подпапки «${p.library_subfolder}»; есть: ${(lib?.subfolders ?? []).map((s: any) => s.name).join(", ")}`);
          folderId = sub.id;
        }
        else {
          if (!p.project_id) throw new ToolError("нужна задача, project_id, library_subfolder или id заметки");
          const d=await asRole(role,"GET",`/api/projects/${p.project_id}/docs`);
          if(!d.folder) throw new ToolError("у проекта нет папки документации");
          folderId=d.folder.id;
        }
        const n = await asRole(role, "POST", "/api/notes", { markdown: p.markdown, folder_id: folderId });
        if (taskId) recordTaskDocument(taskId, n.id, roleUserId(role));
        return { готово: "заметка создана", id: n.id, material: {kind:"document",title:n.title || "Документ",ref:`note://${n.id}`}, подсказка:"Для чтения в чате отправь через taskflow_chat_share_material. В materials/artifacts используй material, не голый ID." };
      }),
    T("taskflow_kb_search", "Поиск по внутренней базе знаний TaskFlow: заметки и документация всех проектов. Отвечает отрывками с id заметки; целиком заметку читает taskflow_doc_read. Не нашлось — повтори короче, ключевыми словами.",
      Type.Object({ query: Type.String(), top_k: Type.Optional(Type.Number()) }),
      async (p) => ({ запрос: p.query, куски: searchNotes(String(p.query ?? ""), p.top_k ?? 5).map((r) => ({ название: r.title, папка: r.folder, обновлена: r.updated_at, текст: r.text, id_заметки: r.id })) })),
    // Разметка базы знаний — то, ради чего очередь разбора и живёт.
    //
    // Пишем прямо в user_notes, а не через PATCH /api/notes/:id: HTTP-правка
    // переписывает автора и дату любой заметки, а «срез по роли» строится по
    // автору (runtime/roleSlice.ts). Разметка — служебная работа, авторства
    // у неё нет, поэтому трогаются только колонки категорий. Побочно снимается
    // временная метка: оставленная метка вернула бы заметку в следующий разбор.
    T("taskflow_kb_categorize", "Разметить заметку базы знаний. С note_id и category — поставить одну из пяти постоянных категорий (Workflows, Norms, Roles, Knowledge Base, Исследования) и снять временную метку. С note_id и mark — поставить пометку «мусор», если заметка одноразовая, или mark «снять», чтобы убрать метку без пометки. Без note_id — список заметок, ждущих разбора. Текст, название, автор и дата правки заметки не меняются; удалять заметки инструмент не умеет. Повторный вызов по той же заметке безопасен.",
      Type.Object({
        note_id: Type.Optional(Type.String()),
        category: Type.Optional(Type.String()),
        mark: Type.Optional(Type.String()),
      }),
      async (p) => {
        const id = p.note_id ? String(p.note_id).trim() : "";
        if (!id) {
          const pending = db.prepare(
            "SELECT id, title, kb_temp_category AS mark, kb_category AS category, updated_at FROM user_notes WHERE kb_temp_category IS NOT NULL ORDER BY updated_at DESC LIMIT 50",
          ).all() as any[];
          const total = (db.prepare("SELECT COUNT(*) AS n FROM user_notes WHERE kb_temp_category IS NOT NULL").get() as { n: number }).n;
          return {
            ждут_разбора: total,
            показано: pending.length,
            заметки: pending.map((n) => ({ id: n.id, название: n.title || "без названия", пометка: n.mark, категория: n.category, обновлена: n.updated_at })),
          };
        }
        const note = db.prepare("SELECT id, title, kb_category, kb_temp_category, updated_by, updated_at FROM user_notes WHERE id = ?").get(id) as any;
        if (!note) throw new ToolError(`заметка ${id} не найдена`);
        const category = p.category ? String(p.category).trim() : "";
        const mark = p.mark ? String(p.mark).trim() : "";
        if (!category && !mark) throw new ToolError("скажи, что поставить: category — одна из пяти категорий, mark — «мусор» или «снять»");
        if (category && !KB_CATEGORIES.includes(category))
          throw new ToolError(`неизвестная категория «${category}»; можно: ${KB_CATEGORIES.join(", ")}`);
        if (mark && mark !== KB_DROP_MARK && mark !== "снять")
          throw new ToolError(`неизвестная пометка «${mark}»; можно: «${KB_DROP_MARK}» или «снять»`);
        if (category && mark === KB_DROP_MARK)
          throw new ToolError("категория и пометка «мусор» противоречат друг другу: выбери одно");
        if (mark === "снять") {
          db.prepare("UPDATE user_notes SET kb_temp_category = NULL WHERE id = ?").run(id);
        } else if (category) {
          db.prepare("UPDATE user_notes SET kb_category = ?, kb_temp_category = NULL WHERE id = ?").run(category, id);
        } else {
          db.prepare("UPDATE user_notes SET kb_category = NULL, kb_temp_category = ? WHERE id = ?").run(mark, id);
        }
        const after = db.prepare("SELECT kb_category, kb_temp_category, updated_by, updated_at FROM user_notes WHERE id = ?").get(id) as any;
        return {
          готово: id,
          категория: after.kb_category,
          пометка: after.kb_temp_category,
          автор_не_менялся: after.updated_by === note.updated_by && after.updated_at === note.updated_at,
        };
      }),
    T("taskflow_library", "Корневая библиотека знаний TaskFlow: список подпапок (Roles, Workflows, Norms, Knowledge Base, Projects) и заметок в каждой.",
      Type.Object({ subfolder: Type.Optional(Type.String()) }),
      async (p) => {
        const lib = await asRole(role, "GET", "/api/library") as any;
        if (!lib?.subfolders) return { ошибка: "Library не инициализирована" };
        if (p.subfolder) {
          const notes = await asRole(role, "GET", `/api/notes?folder_id=${encodeURIComponent(p.subfolder)}`);
          return { папка: p.subfolder, заметки: (notes?.notes ?? []).map((n: any) => ({ id: n.id, название: n.title })) };
        }
        return {
          корень: lib.root?.name,
          подпапки: lib.subfolders.map((s: any) => ({ название: s.name, заметок: s.notes_count })),
        };
      }),
  ];

  // Веб-поиск и чтение страницы — Исследователю и Помощнику владельца
  // (владелец 19.10.2026: «у него нет инструмента для веб-поиска, сделай
  // ему его»). Остальные инструменты исследования — только Исследователю:
  // они не нужны помощнику и не были для него заведены.
  //
  // Карточка e11eae7a (пункт 3): Помощница владельца отвечает на глубокое
  // исследование САМА и отвечает своим именем — исследователь ей не нужен.
  // Поэтому ей подключается тот же набор исследователя (web_search, web_get,
  // ocr, youtube, local_model) через тот же загрузчик и тот же код
  // research_server.py. Карточный taskflow_report остаётся только у
  // Исследователя: документ с выводами Помощница пишет сама.
  if (role === "researcher" || role === "secretary") {
    tools.push(
      T("web_search", "Найти в интернете: сначала Tavily, при недоступности — Brave. Возвращает список результатов со ссылками и выжимками. Текст страницы потом бери через web_get.",
        Type.Object({ query: Type.String(), max_results: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("web_search", p, role)),
      T("web_get", "Скачать страницу и вернуть её основное содержимое чистым markdown — без меню, рекламы и скриптов. Для PDF и сканов — ocr.",
        Type.Object({ url: Type.String(), max_chars: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("web_get", p, role)),
    );
  }
  if (role === "researcher" || role === "secretary") {
    tools.push(
      T("ocr", "Распознать текст из изображения или PDF (в том числе скан без текстового слоя), русский+английский. Источник — attachment_id вложения задачи или path файла на машине.",
        Type.Object({ attachment_id: Type.Optional(Type.String()), path: Type.Optional(Type.String()), langs: Type.Optional(Type.String()), max_chars: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("ocr", p, role)),
      T("youtube", "Транскрипт видео YouTube в текст (сначала ручные субтитры, иначе авто). Источник-видео для исследования.",
        Type.Object({ url: Type.String(), langs: Type.Optional(Type.String()), max_chars: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("youtube", p, role)),
      T("local_model", "ЛОКАЛЬНАЯ модель на сервере (Ollama, бесплатно, без интернета). Этап «синтез»: отдай собранные фрагменты и задание — вернёт связный черновик или сводку.",
        Type.Object({ prompt: Type.String(), system: Type.Optional(Type.String()), max_tokens: Type.Optional(Type.Number()), num_ctx: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("local_model", p, role)),
    );
  }
  if (role === "researcher") {
    tools.push(
      T("taskflow_report", "Собрать отчёт по задаче: markdown → HTML и PDF, зеркало в документации проекта и секция «Отчёты» карточки.",
        Type.Object({ task_id: Type.String(), title: Type.Optional(Type.String()), markdown: Type.String() }),
        async (p) => asRole(role,"POST",`/api/tasks/${p.task_id}/reports`,{title:p.title ?? "Отчёт",markdown:p.markdown})),
    );
  }

  const chatOperations = chatTools(role, chatContext, taskId);
  // Один и тот же инструмент может прийти из обоих наборов: перезапуск слота
  // есть и в чате (chatTools), и среди инструментов управления планом
  // (orchestratorTools — только при orchestrate). Дубль ломает ход целиком:
  // реестр отказывается строить «taskflow» («Duplicate operation»), роль не
  // отвечает ни на что. Исключение знали только для секретаря — оркестратор
  // молчал в чате с 17.10.2026. Оставляем чатовую копию: действие у них одно,
  // а в чате у неё есть контекст сообщения.
  const chatOperationNames = new Set(chatOperations.map((tool) => tool.name));
  const managementOperations = orchestratorTools(role, T).filter((tool) => !chatOperationNames.has(tool.name));
  const all = [...tools, ...chatOperations, ...managementOperations, ...teamReadTools(role, T), ...(role === "secretary" ? [...secretaryMailTools(T), ...secretaryThings3Tools({role,subtaskId}), ...secretaryAppleTools({role,subtaskId})] : [])];
  if (unscoped) return all;
  return all.filter(t => roleToolAllowed(role, t.name) && (!subtaskId || t.name !== "taskflow_claim"));
}

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

let knownTools: Set<string> | null = null;
/** Все инструменты, какие есть хоть у одной роли, — для журнала нехватки. */
function knownToolNames(): Set<string> {
  if (!knownTools) {
    const names = new Set<string>(BUILTIN_TOOLS);
    for (const r of allRoles()) for (const t of taskflowToolsUnscoped(r.key)) names.add(t.name);
    knownTools = names;
  }
  return knownTools;
}
const HEARTBEAT_MS = 90_000;

/** Что агент роли получает на заходе внутри сервера — для экрана «Команда». */
export function inProcessToolNames(role = ""): string[] {
  return [...BUILTIN_TOOLS, "taskflow"];
}

function rolePrompt(role: string): string {
  return rolePromptText(role) ?? "";
}

function taskForLaunchContext(taskId: string): Record<string, unknown> {
  const task = db.prepare(
    "SELECT id, title, description, project_id, priority, due_date FROM tasks WHERE id = ?",
  ).get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("карточка больше не существует");
  const comments = db.prepare(`
    SELECT COALESCE(u.name, c.user_id) AS author, c.text, c.created_at
      FROM comments c
 LEFT JOIN users u ON u.id = c.user_id
     WHERE c.task_id = ?
  ORDER BY c.created_at DESC, c.rowid DESC
     LIMIT 10
  `).all(taskId);
  return { ...task, comments };
}

/** Задание по умолчанию — когда вызывающий не собрал своё (ручной запуск). */
export function defaultTaskPrompt(taskId: string, role: string): string {
  const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title?: string } | undefined;
  return renderInstruction(role, "task.start", { roleTitle: roleTitle(role), taskId, title: task?.title ?? "", rules: effectiveRules(role).map(r => `- ${r}`).join("\n") });
}

/**
 * Задание для роли, запущенной на конкретном узле collaboration plan
 * (владелец 29.09.2026, DESIGN.md «Роли плана — это подзадачи»). В отличие
 * от бывших slot-запусков — инструменты и видимость карточки ПОЛНЫЕ, те же,
 * что у обычного запуска: изоляция была осознанно снята (решение №2).
 * `taskflow_claim` здесь не нужен — узел плана уже назначен этой роли
 * (`agent_id`) и уже in_progress, работа начинается сразу с самого шага.
 */
/** Контракт результата шага — прямо в задании, чтобы роль не угадывала поля. */
function artifactContractNote(subtaskId: string): string {
  const row = db.prepare(`SELECT n.output_artifact_json AS json FROM subtasks s
      JOIN task_collaboration_plan_nodes n ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
     WHERE s.id = ?`).get(subtaskId) as { json?: string | null } | undefined;
  let contract: { key?: string; required_fields?: string[] } | null = null;
  try { contract = row?.json ? JSON.parse(row.json) : null; } catch { contract = null; }
  if (!contract?.key) return "- У этого шага нет контракта результата: artifact не передавай.";
  const fields = (contract.required_fields ?? []).join(", ");
  return [
    `- У этого шага контракт результата «${contract.key}»: вместо отдельного report_markdown передай artifact.`,
    "- artifact: {summary — строка, payload — объект, evidence — массив, report_markdown — отчёт внутри artifact}.",
    `- В payload обязательны непустые поля: ${fields}.`,
    "- evidence: до 8 записей, каждая — строка-путь либо объект с path / doc_id / document_ref / url.",
  ].join("\n");
}

/** Final review jobs belong to the card and do not carry subtaskId. Recover
 * their marked active slot explicitly so they retain the same template packet. */
export function stageInstructionsForRun(taskId:string,role:string,subtaskId?:string,mode?:string):string|null {
  if(subtaskId) return (db.prepare(`SELECT n.instructions FROM subtasks s
    JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
    WHERE s.id=? AND s.task_id=? AND n.role_key=?`).get(subtaskId,taskId,role) as {instructions:string|null}|undefined)?.instructions ?? null;
  if(role!=="critic_verifier" || mode!=="review") return null;
  return (db.prepare(`SELECT n.instructions FROM subtasks s
    JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
    JOIN task_collaboration_plans p ON p.id=n.plan_id
    WHERE s.task_id=? AND s.done=0 AND s.agent_state IN ('todo','in_progress')
      AND n.role_key='critic_verifier' AND p.status='approved' AND n.instructions LIKE '[taskflow:final-review]%'
    ORDER BY s.position DESC LIMIT 1`).get(taskId) as {instructions:string|null}|undefined)?.instructions ?? null;
}

export function planSubtaskPrompt(taskId: string, role: string, subtaskId: string): string {
  const subtask = db.prepare("SELECT title FROM subtasks WHERE id = ?").get(subtaskId) as { title?: string } | undefined;
  // Режим «Оркестратор»: два его шага получают регламент координации вместо
  // инструкции исполнителя («делай свой шаг сам»).
  const orch = db.prepare(`SELECT p.id AS plan_id, s.plan_node_key AS slot FROM subtasks s
      JOIN task_collaboration_plans p ON p.id = s.collaboration_plan_id
     WHERE s.id = ? AND p.profile = 'orchestrated'`).get(subtaskId) as { plan_id: string; slot: string } | undefined;
  if (orch && (orch.slot === ORCHESTRATE_SLOT || orch.slot === ORCHESTRATE_ASSEMBLE_SLOT)) {
    const rules = effectiveRules(role).map(r => `- ${r}`).join("\n");
    return orch.slot === ORCHESTRATE_SLOT
      ? renderInstruction(role, "task.orchestrate", { roleTitle: roleTitle(role), taskId, subtaskId, planId: orch.plan_id, selfSlot: ORCHESTRATE_SLOT, assembleSlot: ORCHESTRATE_ASSEMBLE_SLOT, rules })
      : renderInstruction(role, "task.orchestrate_assemble", { roleTitle: roleTitle(role), taskId, subtaskId, planId: orch.plan_id, rules });
  }
  return renderInstruction(role, "task.plan", { roleTitle: roleTitle(role), taskId, subtaskId, subtaskTitle: subtask?.title ?? "", artifactContract: artifactContractNote(subtaskId), rules: effectiveRules(role).map(r => `- ${r}`).join("\n") });
}

// ── Папка проекта, справка, продолжение разговора (этап C3) ──────────────

const RUNS_BASE = process.env.TASKFLOW_RUNS_DIR || path.join(os.homedir(), ".local", "state", "taskflow-runs");
/**
 * Блок «твоё состояние» для промта роли. Заметки задачи исключаются: срез
 * это прошлое, настоящее роль берёт из контекста хода. Любая ошибка здесь
 * не должна ронять запуск роли — при неисправности блок просто не вставится.
 */
function roleSliceBlock(role: string, taskId: string): string | null {
  try {
    const exclude: string[] = [];
    const row = db
      .prepare("SELECT artifact_folder_id AS f FROM tasks WHERE id = ?")
      .get(taskId) as { f: number | null } | undefined;
    if (row?.f) {
      const notes = db
        .prepare("SELECT id FROM user_notes WHERE folder_id = ?")
        .all(row.f) as Array<{ id: string }>;
      for (const n of notes) exclude.push(n.id);
    }
    const actorId = role.startsWith("role_") ? role : `role_${role}`;
    const slice = collectRoleSlice(actorId, exclude);
    return buildRoleSliceText(slice, roleTitle(role)) || null;
  } catch {
    return null;
  }
}


/** Репозиторий проекта карточки — из того же файла, что читала Система
 *  (прежняя внешняя автоматика).
 *  (scripts/task-context-projects.json); не сопоставлен — репозиторий TaskFlow. */
/** Справка для агента: ветка и незакоммиченные файлы — только чтение git. */
function repoNote(cwd: string): string {
  try {
    const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 5000 }).trim();
    const dirty = execFileSync("git", ["-C", cwd, "status", "--short"], { encoding: "utf8", timeout: 5000 })
      .split("\n").filter((l) => l.trim()).slice(0, 20);
    return [
      `Рабочая папка: ${cwd}, ветка ${branch}.`,
      dirty.length ? `Незакоммиченные файлы (чужая работа — не трогай без нужды):\n${dirty.join("\n")}` : "Незакоммиченных файлов нет.",
    ].join("\n");
  } catch {
    return `Рабочая папка: ${cwd}.`;
  }
}

/** Разговор агента хранится на пару «задача + роль» и продолжается при
 *  следующем заходе — после ответа владельца, паузы или повтора. */
export function slotWorkspace(taskId:string):string {return roleWorkspace(taskId,projectRepo(taskId));}

function sessionDir(taskId: string, role: string, subtaskId?: string): string {
  return path.join(RUNS_BASE, "sessions", `${taskId}-${role}-${subtaskId ?? "main"}`);
}

function hasSession(taskId: string, role: string, subtaskId?: string): boolean {
  try {
    return fs.readdirSync(sessionDir(taskId, role, subtaskId)).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

function resumePrompt(taskId: string, role = "builder"): string {
  return renderInstruction(role, "task.resume", { taskId });
}

/** Сколько раз подряд агент вышел посреди работы — для повторного захода. */
const chainCount = new Map<string, number>();
const MAX_CHAIN = 3;
/** Меньше стольких вызовов инструментов за ход — прогресса нет (роль ответила и закончила). */
const STALLED_NODE_MIN_ACTIVITY = 3;

function progressMark(taskId: string): string {
  const steps = (db.prepare("SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ? AND done = 1").get(taskId) as { n: number }).n;
  const comments = (db.prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?").get(taskId) as { n: number }).n;
  return `${steps}:${comments}`;
}

/** Время последней фактической активности роли в запуске (tool call,
 *  snapshot, комментарий в ленту). Отдельно от lease-heartbeat (тот
 *  продлевается таймером): sweeper сравнивает это поле с now и прерывает
 *  заход, если роль зависла, не двигаясь. Владелец 05.10.2026, п.9 части II
 *  taskflow-flow.md. */
type ActiveInProcessRun = { runId: string; taskId: string; role: string; subtaskId?: string; abort: () => Promise<void>; steer: (text:string)=>Promise<void>; lastActivityAt: number ; /** Сколько раз роль проявила активность (вызовы инструментов): отличает ход с работой от пустого. */ activityCount: number; messengerMessages:Set<string>; unacknowledgedMessengerMessages:Set<string>; replacementRequested?: boolean; completion?: Promise<void>};
const activeRuns = new Map<string, ActiveInProcessRun>();

/** Сколько минут тишины (без tool call / snapshot / комментария) сервер
 *  ждёт, прежде чем прервать заход. Предложено владельцем 05.10.2026
 *  (taskflow-flow.md, п.9 части II). Переопределяется через ENV, чтобы
 *  тесты могли ускорять. Читаем динамически — тесты меняют ENV после
 *  импорта модуля, и старое «при импорте» их ломало. */
function readStaleRunMinutes(): number {
  return Math.max(1, Math.floor(Number(process.env.STALE_RUN_MINUTES ?? 30)) || 30);
}

/** Коснуться «фактической активности» запуска — вызывается из подписчика
 *  событий SDK и из других точек, где видно, что роль двигается. Чистый
 *  lease-heartbeat (в BEAT) сюда не пишем: это продление аренды, а не
 *  признак работы. */
export function touchRunActivity(runId: string): void {
  const run = activeRuns.get(runId);
  if (run) {
    run.lastActivityAt = Date.now();
    run.activityCount += 1;
  }
}

/** Коснуться активности для всех запусков указанной задачи — у роли может
 *  быть только один активный заход на карточку, поэтому из taskflow-инструментов
 *  удобнее звать это (им известен taskId), а не искать по runId. */
export function touchTaskActivity(taskId: string): void {
  const now = Date.now();
  for (const run of activeRuns.values()) {
    if (run.taskId === taskId) {
      run.lastActivityAt = now;
      run.activityCount += 1;
    }
  }
}

/** Pass a message to the existing SDK session. Never launches a task or slot. */
export async function deliverTopicToWork(taskId:string,role:string,messageId:string,text:string,slotKey?:string):Promise<"queued"|"idle"|"busy"|"working"> {
  const runs=[...activeRuns.values()].filter(r=>r.taskId===taskId && r.role===role && (!slotKey || (r.subtaskId && !!db.prepare("SELECT 1 FROM subtasks WHERE id=? AND plan_node_key=?").get(r.subtaskId,slotKey))));
  if(runs.length>1) return "busy";
  if(runs.length===1){
    const chat=(db.prepare("SELECT chat_id FROM chat_messages WHERE id=?").get(messageId) as {chat_id:string|null}|undefined)?.chat_id ?? taskId;
    return deliverChatToWork(role,chat,messageId,text,runs[0].subtaskId,runs[0].runId);
  }
  const starting=db.prepare("SELECT 1 FROM subtasks WHERE task_id=? AND agent_id=? AND agent_state='in_progress' AND done=0 AND (? IS NULL OR plan_node_key=?)").get(taskId,roleUserId(role),slotKey??null,slotKey??null);
  if(starting){
    const target=resolveTopicSlot(taskId,role,slotKey);
    if(target)db.prepare("INSERT OR IGNORE INTO slot_topic_inbox(message_id,subtask_id) VALUES(?,?)").run(messageId,target.id);
    return "busy";
  }
  return "idle";
}

/** Deliver to the addressed work run without starting another executor.
 * A queued SDK input is acknowledged only on its user message event.
 */
export async function deliverChatToWork(role:string,chatId:string,messageId:string,text:string,recipientSubtaskId?:string,runId?:string,fromOwner=false):Promise<"queued"|"idle"|"busy"|"working"> {
  const runs=[...activeRuns.values()].filter(r=>r.role===role && (!recipientSubtaskId || r.subtaskId===recipientSubtaskId) && (!runId || r.runId===runId));
  if(runs.length>1)return "busy";
  if(!runs.length){
    const starting=db.prepare(`SELECT s.id,s.task_id FROM subtasks s JOIN tasks t ON t.id=s.task_id WHERE s.agent_id=? AND s.done=0 AND s.agent_state='in_progress' AND EXISTS(SELECT 1 FROM role_run_jobs j WHERE j.task_id=s.task_id AND j.status IN ('queued','running')) AND t.status='active' AND t.archived_at IS NULL AND (? IS NULL OR s.id=?)`).all(roleUserId(role),recipientSubtaskId??null,recipientSubtaskId??null) as {id:string;task_id:string}[];
    if(!starting.length)return "idle";
    if(starting.length===1){db.prepare("INSERT OR IGNORE INTO slot_topic_inbox(message_id,subtask_id) VALUES(?,?)").run(messageId,starting[0].id);traceCoordination(()=>queueWorkCoordination(messageId,roleUserId(role),starting[0].task_id,starting[0].id));return "queued";}
    return "busy";
  }
  const run=runs[0];
  if(run.messengerMessages.has(messageId))return "queued";
  if(run.subtaskId){
    db.prepare("UPDATE chat_message_queue SET payload_json=json_set(payload_json,'$.subtaskId',?) WHERE message_id=? AND role_id=? AND status IN ('pending','picked')").run(run.subtaskId,messageId,roleUserId(role));
    db.prepare("INSERT OR IGNORE INTO slot_topic_inbox(message_id,subtask_id) VALUES(?,?)").run(messageId,run.subtaskId);
  }
  run.messengerMessages.add(messageId);run.unacknowledgedMessengerMessages.add(messageId);
  // Steering is consumed at the next action boundary without replacing the slot run.
  traceCoordination(()=>queueWorkCoordination(messageId,roleUserId(role),run.taskId,run.subtaskId));
  try{await run.steer(`Сообщение чата ${chatId}, id ${messageId}. Ответь автору через taskflow_chat_reply(message_id=${messageId},text=...), если ответ нужен; после этого продолжи свой этап. Переписка не меняет назначение, граф и критерии. Данные сообщения: ${JSON.stringify(text)}`);}catch(error){run.messengerMessages.delete(messageId);run.unacknowledgedMessengerMessages.delete(messageId);throw error;}
  logEvent({taskId:run.taskId,actorId:null,kind:"topic_message_queued",field:messageId,toValue:JSON.stringify({role,chatId,runId:run.runId})});
  // Сообщение подмешано в текущую работу роли — не «в очереди», а «в работе».
  return "working";
}

/** Снимок идущих in-process запусков: для экрана владельца и проверки перед перезапуском. */
export function listActiveInProcessRuns(): Array<{ runId: string; taskId: string; role: string; subtaskId: string | undefined; lastActivityAt: number }> {
  return [...activeRuns.values()].map((r) => ({ runId: r.runId, taskId: r.taskId, role: r.role, subtaskId: r.subtaskId, lastActivityAt: r.lastActivityAt }));
}

export function activeInProcessRun(taskId: string, subtaskId?: string): ActiveInProcessRun | undefined {
  return [...activeRuns.values()].find((r) => r.taskId === taskId && r.subtaskId === subtaskId);
}

/** Для тестов: подкрутить lastActivityAt у активного запуска, чтобы
 *  воспроизвести тишину без настоящего ожидания 30 минут. Не использовать
 *  в проде — только в vitest. */
export function _setRunLastActivityForTests(runId: string, ts: number): void {
  const run = activeRuns.get(runId);
  if (run) run.lastActivityAt = ts;
}

/** Пройтись по активным in-process запускам и прервать те, что не двигались
 *  дольше предела. Возвращает список прерванных runId. Зовётся из worker tick
 *  (roleRunWorker.ts). Если у узла есть слот — сначала пишется техснимок
 *  «stopped», чтобы продолжение начиналось с фактов; сам continueOrHandOff
 *  идёт через finally в runRoleInProcess, поэтому тут только запускаем
 *  abort и даём finally отработать. Владелец 05.10.2026, п.9 части II
 *  taskflow-flow.md. */
export async function sweepStaleInProcessRuns(now = Date.now()): Promise<string[]> {
  const staleMs = readStaleRunMinutes() * 60_000;
  const stale: ActiveInProcessRun[] = [];
  for (const run of activeRuns.values()) {
    if (now - run.lastActivityAt >= staleMs) stale.push(run);
  }
  const ids: string[] = [];
  for (const run of stale) {
    const minutes = Math.round((now - run.lastActivityAt) / 60_000);
    logEvent({ taskId: run.taskId, actorId: null, kind: "plan_subtask_stale_timeout", field: run.subtaskId ?? null, toValue: `тишина ${minutes} мин` });
    if (run.subtaskId) {
      try {
        technicalSlotSnapshot(run.subtaskId, "stopped", {
          blocker: `тишина ${minutes} мин без движения роли — ход прерван`,
        });
      } catch (error) {
        // Снимок не должен ронять сам abort, но ошибку проглатывать молча —
        // тоже плохо: иначе сломанную БД не увидим. Логируем и идём дальше.
        console.warn(`[sweepStaleInProcessRuns] снимок для ${run.subtaskId} не записался:`, error);
      }
    }
    try {
      await run.abort();
      ids.push(run.runId);
    } catch (error) {
      console.warn(`[sweepStaleInProcessRuns] abort ${run.runId} не удался:`, error);
    }
  }
  return ids;
}

/** Для тестов: дождаться окончания всех фоновых запусков. */
const pending = new Set<Promise<void>>();
export async function _settleInProcessRunsForTests(): Promise<void> {
  // A completion can schedule a successor at the next action boundary.
  // Drain that preparation too, not only the first snapshot of work promises.
  do {
    await Promise.all([...pending]);
    await new Promise<void>(resolve => setImmediate(resolve));
  } while (pending.size || preparingRuns.size);
}

/** Сколько ждём резюме роли при остановке хода. Остановка не должна зависать
 *  в ожидании модели (владелец 04.10.2026): не ответила — пишем техснимок.
 *  MAK-95: значения из реестра `serverSettings`, подписка обновляет без
 *  перезапуска процесса. */
import { getSetting, onChange } from "../lib/serverSettings.js";
let STOP_SUMMARY_MS = getSetting("slot_stop_summary_ms");
let STOP_SUMMARY_ON = getSetting("slot_stop_summary");
onChange("slot_stop_summary_ms", (v) => {
  STOP_SUMMARY_MS = v;
});
onChange("slot_stop_summary", (v) => {
  STOP_SUMMARY_ON = v;
});

/** Разбор короткого резюме, которое роль пишет в конце хода. Терпимый к
 *  формулировкам: годятся строки «Сделано:», «Осталось:», «Блок:»,
 *  «Следующий шаг:», «Артефакты:» — с любой пунктуацией и лишними словами
 *  вокруг двоеточия. */
function parseStopSummary(text: string): {
  done?: string; left?: string; blocker?: string; nextStep?: string; artifacts?: unknown[];
} {
  const out: { done?: string; left?: string; blocker?: string; nextStep?: string; artifacts?: unknown[] } = {};
  const artifacts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s\-*•—–]+/, "").trim();
    const m = line.match(/^(сделано|осталось|блок|блокер|следующий шаг|дальше|артефакты|артефакт)\s*[:—-]\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (!value || /^(нет|нету|—|-|пусто|не знаю|неизвестно)$/i.test(value)) continue;
    if (key === "сделано") out.done = value;
    else if (key === "осталось" || key === "дальше") out.left = value;
    else if (key === "блок" || key === "блокер") out.blocker = value;
    else if (key === "следующий шаг") out.nextStep = value;
    else artifacts.push(value);
  }
  if (artifacts.length) out.artifacts = artifacts;
  return out;
}

/**
 * Попытка снять короткое резюме у роли ДО закрытия сессии (пункт 2 плана
 * владельца 04.10.2026: «при обычной остановке — попытаться получить короткое
 * резюме»). Один ход, без инструментов, с жёстким потолком по времени; при
 * таймауте ход прерывается и возвращается null — дальше пишет техснимок.
 *
 * Спрашиваем только когда слот НЕ сдан: при сдаче снимок уже записан на
 * пути `/artifact` или `taskflow_subtask_done`, и второй раз спрашивать
 * модель о том же — платный шум.
 */
async function askStopSummary(
  session: any,
  subtaskId: string,
  role: string,
  slotTitle: string,
): Promise<ReturnType<typeof parseStopSummary> | null> {
  if (!STOP_SUMMARY_ON) return null;
  const ask =
    "Твой рабочий ход по этому этапу заканчивается, сессия сейчас закроется. " +
    "Ответь ОДНИМ сообщением, без инструментов и без рассуждений, максимум 8 строк, строго факты о работе:\n" +
    "Сделано: …\nОсталось: …\nБлок: … (если есть)\nСледующий шаг: …\nАртефакты: … (названия или ссылки)\n" +
    "Если блока нет — напиши «Блок: нет». Оценок и объяснений не нужно.";
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      session.prompt(ask),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("резюме не пришло вовремя")), STOP_SUMMARY_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Модель не ответила или ответила ошибкой: ход прерываем, чтобы не
    // остался висеть, и отдаём null — техснимок напишет сервер.
    void session.abort().catch(() => {});
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const answer = [...(session.state?.messages ?? [])].reverse().find((m: any) => m?.role === "assistant");
  if (!answer || answer.stopReason === "error") return null;
  const text = (answer.content ?? [])
    .filter((part: any) => part.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("\n")
    .trim();
  if (!text) return null;
  const parsed = parseStopSummary(text);
  const empty = !parsed.done && !parsed.left && !parsed.blocker && !parsed.nextStep && !parsed.artifacts?.length;
  return empty ? null : parsed;
}

/**
 * Запустить роль на задаче внутри сервера. Возвращается сразу; работа идёт
 * в фоне. Аренду держит сервер, пока агент работает; действия встроенных
 * инструментов (чтение, правка, команды) видны в карточке. Сбой — карточка
 * заблокирована с причиной.
 */
// activeRuns is populated only after asynchronous preparation. Reserve the
// same window while preparing, so concurrent entrypoints cannot create two
// sessions or treat a legitimate slow preparation as a lost slot lease.
function assertRunTaskAvailable(taskId: string): void {
  if (!db.prepare("SELECT 1 FROM tasks WHERE id=? AND archived_at IS NULL").get(taskId))
    throw new Error("Карточка удалена или архивирована — запуск отменён");
}
const preparingRuns = new Set<string>();
const preparationKey = (input: { taskId: string; subtaskId?: string }) =>
  JSON.stringify([input.taskId, input.subtaskId ?? null]);
async function prepareInProcessRun(input: Parameters<typeof runRoleInProcessUnserialized>[0]) {
  const key = preparationKey(input);
  if (preparingRuns.has(key) || activeInProcessRun(input.taskId, input.subtaskId))
    throw new Error("по этому окну агент уже работает");
  preparingRuns.add(key);
  try { assertRunTaskAvailable(input.taskId); return await runRoleInProcessUnserialized(input); }
  finally { preparingRuns.delete(key); }
}
export async function interruptOwnerRun(taskId:string,subtaskId?:string):Promise<void> {
  for(const run of [...activeRuns.values()].filter(r=>r.taskId===taskId && (!subtaskId || r.subtaskId===subtaskId))) {
    run.replacementRequested=true;
    await run.abort();
    await run.completion?.catch(()=>{});
  }
}
export async function runRoleInProcess(input:Parameters<typeof runRoleInProcessUnserialized>[0]):Promise<{runId:string;completion:Promise<void>}> {
  const review=input.role==="critic_verifier" && (input.mode ?? "review")==="review";
  if(!review)return runRoleInProcessSerialized(input);
  if(preparingRuns.has(preparationKey(input)) || activeInProcessRun(input.taskId,input.subtaskId))throw new Error("по этому окну агент уже работает");
  const ticket=reserveReviewRun(input.taskId, input.ownerStartActorId);
  assertReviewRunAllowed(ticket);
  let result: Awaited<ReturnType<typeof runRoleInProcessUnserialized>>;
  try {result=await runRoleInProcessSerialized(input);}
  catch(error){finishReviewRun(ticket,error);throw error;}
  const completion=result.completion.then(
    () => finishReviewRun(ticket),
    error => {finishReviewRun(ticket,error);throw error;},
  );
  void completion.catch(()=>{});
  return {...result,completion};
}
async function runRoleInProcessSerialized(input:Parameters<typeof runRoleInProcessUnserialized>[0]):Promise<{runId:string;completion:Promise<void>}> {
  if(!input.subtaskId)return prepareInProcessRun(input);
  const release=await acquireSlotSession(input.subtaskId,undefined,()=>preparingRuns.has(preparationKey(input)) || !!activeInProcessRun(input.taskId,input.subtaskId));
  try {
    const result=await prepareInProcessRun(input);
    void result.completion.then(release,release);
    return result;
  } catch(error){release();throw error;}
}
async function runRoleInProcessUnserialized(input: {
  taskId: string;
  role: string;
  prompt?: string;
  ownerStartActorId?: string;
  cwd?: string;
  model?: string;
  /** work — работа по задаче (с повторами), reply — только ответ владельцу,
   *  review — вердикт Критика. */
  mode?: "work" | "reply" | "review";
  /** Автоматический worker пишет следующий after_run в durable queue.
   *  Прямой ручной/тестовый запуск сохраняет немедленный handoff. */
  durableHandoff?: boolean;
  /** Число уже выполненных C3 continuation-заходов durable chain. */
  chainDepth?: number;
  /** Узел collaboration plan — запуск роли на конкретной подзадаче плана,
   *  а не на задаче целиком (изолированный сеанс/сессия на этот узел). */
  subtaskId?: string;
  freshSession?: boolean;
  /** Сколько раз ход уже переехал на запасную модель из-за лимита провайдера. */
  failoverDepth?: number;
}): Promise<{ runId: string; completion: Promise<void> }> {
  const { taskId, role } = input;
  if (!ROLE_NAMES.includes(role)) throw new Error(`роли «${role}» нет или она отключена`);
  if (activeInProcessRun(taskId, input.subtaskId)) throw new Error("по этому окну агент уже работает");

  const routing = loadRoleRouting();
  // MAK-77: модель может быть записана как «провайдер/модель» (opencode-go/qwen3.8-flash);
  // запись без префикса работает по-старому.
  // Внешний агент (участник с roles.runtime ≠ pi) работает на своей модели:
  // ни routing ролей, ни каталог Pi его не касаются.
  const external = externalRuntime(role);
  const modelRef = external ? `${external}/default` : pickStartModel(routing, role, input.model);
  const { provider: modelProvider, id: modelId } = external ? { provider: external, id: "default" } : parseModelRef(modelRef);
  const runtime: any = await getModelRuntime();
  const model = external
    ? { id: modelId, provider: external, name: roleTitle(role), reasoning: false }
    : runtime.getModel?.(modelProvider, modelId) ??
      ((await runtime.getAvailable?.()) ?? []).find((m: any) => m.id === modelId);
  if (!model) throw new Error(`модель «${modelRef}» недоступна`);
  try {
    recordAttemptModel({ taskId, subtaskId: input.subtaskId, modelId, provider: modelProvider });
  } catch (error) {
    console.warn("[attemptModel] не записалась:", error);
  }


  // Репозиторий самого сервера — только в отдельной копии: сохранение файла
  // в живой перезапустило бы сервер вместе с этим ходом (roleWorkspace.ts).
  // Машина роли: null — работаем на .110 как всегда. Назначенная машина
  // проверяется ДО создания копии: молча уехав на .110, роль отчиталась бы о
  // работе в папке, которую никто не откроет.
  const host = resolveRoleHost(taskId, input.subtaskId, role);
  let cwd = input.cwd
    ?? (host
      ? await remoteRoleWorkspace(host, projectRepo(taskId), taskId)
      : roleWorkspace(taskId, projectRepo(taskId)));
  const mode = input.mode ?? (role === "critic_verifier" ? "review" : "work");
  // Свежий старт (замена исполнителя) — не продолжение: прежняя переписка
  // не подхватывается, поэтому resumed честно false, а выжимка прежней сессии
  // уходит новому агенту в задание (16.10.2026).
  const previousDigest = input.freshSession && input.subtaskId ? previousSessionDigest(taskId, role, input.subtaskId) : null;
  const resumed = !input.freshSession && hasSession(taskId, role, input.subtaskId);
  const dependencyContext = buildDependencyContext(taskId);
  if (dependencyContext.status === "ok" && dependencyContext.dependencies.length) {
    logEvent({
      taskId,
      actorId: null,
      kind: "dependency_context_used",
      field: "dependencies",
      toValue: JSON.stringify({ version: dependencyContext.version, dependencies: dependencyContext.dependencies.map((d) => d.task_id) }),
    });
  }
  const collaborationContext = input.subtaskId ? buildCollaborationPlanContext(input.subtaskId) : undefined;
  if (collaborationContext && collaborationContext.status === "ok") {
    logEvent({
      taskId,
      actorId: null,
      kind: "collaboration_context_used",
      field: collaborationContext.slot_key ?? input.subtaskId ?? "",
      toValue: JSON.stringify({
        plan_id: collaborationContext.plan_id,
        revision: collaborationContext.revision,
        artifacts: collaborationContext.predecessor_artifacts.map((a) => a.slot_key + ":" + a.artifact_key),
      }),
    });
  }
  const launchContext = await buildInProcessTaskContext({
    task: taskForLaunchContext(taskId),
    actor: { id: roleUserId(role), name: roleTitle(role) },
    dependency_context: dependencyContext,
    collaboration_context: collaborationContext,
    // «Что уже было по этой карточке» (владелец 06.10.2026): сводка прошлых
    // ходов собирается сервером без модели и входит в задание каждого шага.
    task_history: buildTaskHistory({ taskId, subtaskId: input.subtaskId ?? null }),
  });
  assertRunTaskAvailable(taskId);
  if (mode === "work" && !resumed) {
    try {
      await asRole(role, "POST", `/api/tasks/${taskId}/comments`, { text: launchContext.summary });
    } catch (error) {
      console.warn(`контекст для ${taskId} собран, но сводка не записана:`, error);
    }
  }
  fs.mkdirSync(sessionDir(taskId, role, input.subtaskId), { recursive: true });
  const manager=input.subtaskId ? openSlotSession(taskId,role,input.subtaskId,cwd,input.freshSession) : SessionManager.continueRecent(cwd,sessionDir(taskId,role));
  cwd=manager.getCwd();
  const systemPrompt = [
    // Общий шаблон + AGENTS.md роли — один источник (20.10.2026).
    rolePrompt(role)
      || `Ты — ${roleTitle(role)} в трекере TaskFlow.`,
    teamStructureText(role),
    clockLine(),
    roleToolInstruction(),
    (role==="critic_verifier" ? oneShotReviewInstruction(taskId) : null) ?? ROLE_REPORT_INSTRUCTION,
    ...(input.subtaskId ? [planRoleHelpPolicy(), SUBMISSION_POLICY] : []),
    // Срез знаний роли (шаг 4 схемы базы знаний, заметка cfa5cdcd): чтобы
    // роль не просыпалась в вакуум. Только заметки с постоянной категорией
    // и без текущей задачи; пустой срез не вставляется.
    roleSliceBlock(role, taskId),
    renderPromptAddendum("task", role, ensureRoleHome(role)),
  ].join("\n\n");
  // Карточка и текущий шаг — для галочки «Навыки под задачу» (раздел JEV).
  const workCard = db.prepare("SELECT title, description FROM tasks WHERE id = ?").get(taskId) as { title: string; description: string | null } | undefined;
  const workStep = input.subtaskId ? (db.prepare("SELECT title FROM subtasks WHERE id = ?").get(input.subtaskId) as { title: string } | undefined)?.title ?? null : null;
  const stageInstructions = stageInstructionsForRun(taskId,role,input.subtaskId,input.mode);
  const resourceLoader = await createTaskResourceLoader(role, cwd, systemPrompt, workCard ? { ...workCard, step: workStep, stageInstructions } : undefined);

  // Снимок фактического system prompt, который модель получит в этом запуске.
// Записывается в tasks.composed_prompt_snapshot — это «что видела модель»,
// доступное владельцу и iOS для прозрачности (дизайн §8).
try {
  db.prepare(
    "UPDATE tasks SET composed_prompt_snapshot = ? WHERE id = ?",
  ).run(systemPrompt, taskId);
} catch {
  // колонка появится только после миграции 081; до неё молча.
}

  // Composio (Exa, GitHub) тоже не обязателен: 28.10.2026 он не поднялся, и шаги
  // разработчика падали на старте, хотя задаче он не нужен. Не поднялся — роль
  // работает без его инструментов.
  const composio = await connectRoleComposio(role, mode, input.subtaskId ?? taskId).catch(error => { console.warn(`[composio] ${role}: ${error instanceof Error ? error.message : error}`); return { tools: [] as any[], close: async () => {} }; });
  if(db.prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id=? AND status='approved'").get(taskId)) ensurePlanTopic(taskId);
  // Инфрапанель не обязательна для хода: не поднялась — роль работает без неё.
  const infra = await connectRoleMcp(role, cwd).catch(error => { console.warn(`[infra-panel] ${role}: ${error instanceof Error ? error.message : error}`); return { tools: [] as any[], close: async () => {} }; });
  const toolCatalog = buildRoleToolCatalog({role,model:model.id??modelId,taskId,subtaskId:input.subtaskId,mode:"work",runId:manager.getSessionId()}, [...composio.tools,...infra.tools]);
  const customTools = toolCatalog.customTools;
  // На удалённой машине инструменты те же, но исполняются через шлюз:
  // у каждого в pi подключаемые операции (createCodingTools принимает
  // operations). Имена инструментов и промпты роли при этом не меняются.
  // Операции — ПО ИНСТРУМЕНТАМ ({ bash: { operations } } и т. д.): общее поле
  // { operations } движок молча игнорирует. До 16.10.2026 так и было, и роль
  // «на маке» исполняла bash на .110 (а на мак лезла по ssh в обход хоста).
  const поИнструментам = (o: any) => ({
    bash: { operations: o.bash }, read: { operations: o.read }, write: { operations: o.write },
    edit: { operations: o.edit }, grep: { operations: o.grep }, find: { operations: o.find }, ls: { operations: o.ls },
  });
  const runId = `inproc_${crypto.randomUUID()}`;
  const processLease = !host && roleIsolationEnabled() ? new RoleProcessLease(ROLE_USER, {runId, taskId, role, subtaskId:input.subtaskId}) : undefined;
  const операции = host
    ? поИнструментам(hostOperations(host, cwd))
    : roleIsolationEnabled() ? поИнструментам(isolatedLocalOperations(cwd, processLease)) : undefined;
  // Тесты ролям запрещены (владелец 02.11.2026) — обёртка ВОТ ТЕПЕРЬ
  // подключена: раньше `withTestRunBudget` только импортировался и никогда не
  // вызывался, поэтому правило не действовало.
  const builtinTools = withHostToolExecution(host, cwd,
    [...createCodingTools(cwd, операции), ...createReadOnlyTools(cwd, операции)]
  ).map((tool) => withRoleBashKillGuard(withTestCommandGuard(tool, { role, taskId })));
  // На удалённой машине встроенные инструменты CLI исполнялись бы на .110, а не там:
  // запуск внешнего агента через хост — отдельный этап (операция agent_spawn в host/).
  if (external && host) throw new Error("внешний агент пока запускается только на .110, не через хост");
  registerProviderSession(manager.getSessionId(), {role, task_id:taskId, subtask_id:input.subtaskId, run_id:runId, origin:"card"});
  const { session } = await (external
    ? (() => {
        const command = agentBinary(external);
        if (!command) throw new Error(`внешний агент «${roleTitle(role)}» не найден на машине — нажми «Обновить» в списке агентов`);
        // Операции TaskFlow — те же обёртки шлюза, что у ролей (права и лента — от учётки
        // участника); агент получает их инструментами MCP-сервера taskflow_run.
        const operations = customTools.filter((t: any) => t.name !== "taskflow");
        const token = roleRunToken(role);
        return createExternalAgentSession(external, {
          cwd, command, env: token ? { TASKFLOW_TOKEN: token } : undefined,
          // Только буст и задание (в первом сообщении): правила внутренних ролей не передаются.
          systemPrompt: externalAgentBoost(roleTitle(role), operations, "card"),
          runTools: token ? { runId, userId: ROLE_USER, token, tools: operations } : undefined,
        }).then(s => ({ session: s as any }));
      })()
    : createAgentSession({
    cwd,
    model,
    thinkingLevel: resolveThinkingLevel(model as any, role) ?? undefined,
    modelRuntime: runtime,
    resourceLoader,
    // `tools` у SDK — список ИМЁН. Раньше сюда шли объекты, и роль на задаче
    // оставалась без единого инструмента (владелец 02.10.2026). Встроенные с
    // описаниями владельца — через customTools: одноимённый перекрывает.
    tools: [...builtinTools.map(t=>t.name), ...toolCatalog.registeredNames],
    customTools: [...builtinTools, ...customTools],
    sessionManager: manager,
    // Явные пределы выжимки: короткий ответ (Pi берёт 0.8*reserveTokens) и
    // небольшой оставленный хвост — иначе summarization-запрос раздувается.
    settingsManager: SettingsManager.inMemory({ compaction: { ...COMPACTION_SETTINGS }, retry: { enabled: true, maxRetries: 2 } }),
  } as any)).catch(async error => { resourceLoader.disposeResources(); await composio.close(); await infra.close(); throw error; });

  observeProviderRetries(session, manager.getSessionId());
  installNativeToolSchemas(session, toolCatalog);
  // Активно только ядро операций: остальное подключает taskflow_tools по
  // требованию (setActiveToolsByName). Реестр сессии полный — подключать можно
  // всё, что роль имеет право вызывать.
  installNativeToolCore(session, toolCatalog, builtinTools.map((t:any)=>t.name));

  installSteeringBoundary(session);
  const roleThinking = resolveThinkingLevel(model as any, role);
  if (roleThinking && (session as any).thinkingLevel !== roleThinking && typeof (session as any).setThinkingLevel === "function") {
    (session as any).setThinkingLevel(roleThinking);
  }

  db.prepare("UPDATE tasks SET composed_prompt_snapshot=? WHERE id=?").run((session as any).systemPrompt ?? systemPrompt, taskId);
  // Компактинг при возобновлении (владелец 24.10.2026): resumed-сессия грузит
  // сырую историю вместе с прежними размышлениями — роль перечитывает их и
  // закапывается ещё глубже. Сжимаем историю в выжимку ДО первого промпта,
  // чтобы ход начинался с сути, а не с прошлого монолога.
  if (resumed) {
    // Тяжёлая история (25.10.2026): запрос выжимки уходит одним большим текстом
    // и падает по таймауту провайдера («Request timed out.») — раньше мы тогда
    // шли дальше на сырой истории, и ход роли умирал уже на запросе к модели.
    // Теперь историю ужимаем, а если выжимка не вышла — режем локально и
    // продолжаем ход на небольшой истории.
    await compactSessionSafely(session, {
      label: `${role} ${taskId}`,
      log: message => console.warn(message),
    });
  }
  // Манифест — в справочник по содержимому (instructionManifestStore), а в
  // событие кладём ссылку: полный манифест в каждом событии раздувал
  // task_events до 48 МБ (2 831 событие × 18 КБ при 530 уникальных
  // манифестах). Аудит «какая версия правил ушла в модель» сохранён —
  // манифест восстанавливается по ссылке (аудит 24.10.2026).
  logEvent({
    taskId,
    actorId: roleUserId(role),
    kind: "instruction_snapshot",
    field: runId,
    toValue: instructionSnapshotValue({
      mode: input.subtaskId ? "subtask" : mode,
      resumed,
      manifest: instructionManifest(
        role,
        input.subtaskId
          ? "subtask"
          : resumed
            ? "resume"
            : mode === "work"
              ? "work"
              : mode,
      ),
    }),
  });
  const before = progressMark(taskId);
  const thrash = new ThrashGuard();
  // Повторяющиеся рассуждения: подсказка «план есть — действуй»
  // (владелец 02.11.2026).
  const thinkingGuard = new ThinkingGuard();
  const memoryConsultation = new MemoryConsultationGuard();
  const runControl: ActiveInProcessRun = { runId, taskId, role, subtaskId: input.subtaskId, abort: () => session.abort(), steer: (text:string) => session.steer(text), lastActivityAt: Date.now(), activityCount: 0, messengerMessages:new Set(),unacknowledgedMessengerMessages:new Set() };
  activeRuns.set(runId, runControl);
  const liveTurn = beginTaskLiveTurn({
    taskId, subtaskId: input.subtaskId, runId, userId: roleUserId(role), name: roleTitle(role),
    publish: snapshot => {
      const task = db.prepare("SELECT creator_id, assignee_id FROM tasks WHERE id=?").get(taskId) as any;
      if (task) broadcastToUsers([task.creator_id, task.assignee_id], { type: "tasks:live", ...snapshot });
    },
    publishDelta: event => {
      const task = db.prepare("SELECT creator_id, assignee_id FROM tasks WHERE id=?").get(taskId) as any;
      if (task) broadcastToUsers([task.creator_id, task.assignee_id], event);
    },
  });

  // Действия встроенных инструментов — строкой в карточке, как раньше делало
  // расширение Pi taskflow-activity.ts.
  const KIND: Record<string, string> = {
    read: "read", grep: "search", find: "search", ls: "read", edit: "edit", write: "write", bash: "run",
  };
  const availableToolNames = new Set<string>([...builtinTools.map((t: any) => t.name), ...customTools.map((t: any) => t.name)]);
  const missingLogged = new Set<string>();
  let lastAssistantThought = "";
  // Разбор мыслей (JEV, владелец 27.10.2026): каждые REVIEW_EVERY ответов
  // последние рассуждения уходят оценщику; непонимание, круг или уход в
  // сторону получают конкретную подсказку прямо в ход. Не чаще раза за
  // NUDGE_COOLDOWN ответов и без параллельных разборов.
  // Владелец 01.11.2026: REVIEW_EVERY поднят до 10 — разбор был 54% всех
  // вызовов JEV. Круг при этом ловится сразу, локальной проверкой текста.
  const recentThoughts: string[] = [];
  let thoughtCount = 0, lastNudgeAt = -NUDGE_COOLDOWN, reviewing = false;
  const reviewRoleThoughts = (text: string) => {
    recentThoughts.push(text);
    if (recentThoughts.length > 4) recentThoughts.shift();
    thoughtCount++;
    const looped = looksLikeLoop(text, recentThoughts.slice(0, -1));
    if (reviewing || (thoughtCount % REVIEW_EVERY && !looped) || thoughtCount - lastNudgeAt < NUDGE_COOLDOWN) return;
    reviewing = true;
    const about = db.prepare("SELECT title, description FROM tasks WHERE id = ?").get(taskId) as { title?: string; description?: string | null } | undefined;
    const step = input.subtaskId ? ((db.prepare("SELECT title FROM subtasks WHERE id = ?").get(input.subtaskId) as { title?: string } | undefined)?.title ?? "") : "";
    const task = [about?.title, about?.description].filter(Boolean).join("\n");
    void reviewThoughts({ taskId, task, step, thoughts: [...recentThoughts] })
      .then((state) => {
        const nudge = state ? thoughtNudge(state, { task: about?.title ?? "", step }) : null;
        if (!nudge) return;
        lastNudgeAt = thoughtCount;
        return runControl.steer(nudge);
      })
      .catch(() => {})
      .finally(() => { reviewing = false; });
  };
  /**
 * Спасти сделанное: последний текст роли (её вывод или сводка) уходит в
 * ленту карточки, даже если финальный запрос не дошёл.
 *
 * Владелец 02.11.2026: «нужно всегда сохранять всю работу… каждое действие,
 * которое что-то сделалось, сразу же её записывать». Текст роли лежит в
 * живом ходе (`liveTurn.snapshot().items`), поэтому он доступен даже тогда,
 * когда запрос к модели оборвался.
 */
  const salvageRunText = (reason: string): void => {
    try {
      const items = (liveTurn as any)?.snapshot?.()?.items ?? [];
      let text = "";
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item?.kind === "text" && typeof item.text === "string" && item.text.trim()) {
          text = item.text.trim();
          break;
        }
      }
      if (!text) return;
      const steps = items.filter((i: any) => i?.kind === "step").length;
      roleNote(
        taskId,
        role,
        `Ход оборвался (${reason.slice(0, 120)}), но сделанное сохранено. Итог роли:\n\n${text.slice(0, 4000)}` +
          (steps ? `\n\nШагов в ходе: ${steps}.` : ""),
      );
    } catch {
      /* спасение не должно ронять ход */
    }
  };

  const unsubscribeLive = session.subscribe((event: any) => {
    liveTurn.onEvent(event);
    if(event?.type==="message_start" && event.message?.role==="user"){
      const content=event.message.content;
      const text=typeof content==="string"?content:(content??[]).filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");
      for(const id of runControl.unacknowledgedMessengerMessages){
        if((text.includes(`Сообщение чата `) || text.includes(`Сообщение темы задачи ${taskId}, id ${id}.`)) && text.includes(`, id ${id}.`))traceCoordination(()=>markDeliveredToWork(id,roleUserId(role)));
      }
    }
    if (event?.type === "message_end" && event.message?.role === "assistant" && Array.isArray(event.message.content)) {
      const text = event.message.content
        .map((c: any) => c?.type === "thinking" ? c.thinking : c?.type === "text" ? c.text : "")
        .filter(Boolean).join("\n").trim();
      if (text) {
        lastAssistantThought = text;
        reviewRoleThoughts(text);
        const thinkingNudge = thinkingGuard.observe(text);
        if (thinkingNudge) void runControl.steer(thinkingNudge).catch(() => {});
      }
    }
    if(event?.type==="message_end" && runControl.unacknowledgedMessengerMessages.size){
      queueMicrotask(()=>{
        try{
          const file=manager.getSessionFile();
          if(!file || !fs.existsSync(file))return;
          const persisted=fs.readFileSync(file,"utf8");
          for(const messageId of runControl.unacknowledgedMessengerMessages){
            if(!persisted.includes(`id ${messageId}.`))continue;
            db.prepare("UPDATE slot_topic_inbox SET delivered_at=datetime('now') WHERE message_id=? AND subtask_id=?").run(messageId,input.subtaskId??null);
            // A returned answer requires no reciprocal acknowledgement message.
            // Questions remain pending until the role writes a linked reply.
            const q=db.prepare(`SELECT q.id,q.session_generation,q.chat_id FROM chat_message_queue q JOIN chat_messages m ON m.id=q.message_id WHERE q.message_id=? AND q.role_id=? AND q.status='pending' AND m.reply_to_message_id IS NOT NULL`).get(messageId,roleUserId(role)) as {id:string;session_generation:number;chat_id:string}|undefined;
            if(q){if(currentChatGeneration(q.chat_id,roleUserId(role))>q.session_generation)fenceMessageDelivery(q.id);else{claimMessageDelivery(q.id);finishMessageDelivery(q.id,true);}}
            runControl.unacknowledgedMessengerMessages.delete(messageId);
          }
        }catch(error){console.warn("[messenger] persistence acknowledgement failed",error instanceof Error?error.message:String(error));}
      });
    }
    if (event?.type !== "tool_execution_start") return;
    // Сторож топтания (владелец 23.10.2026): повторы и серии чтений без
    // изменений получают указание прямо в текущий заход.
    {
      const memoryNudge = memoryConsultation.observe(String(event.toolName ?? ""), event.args);
      const thrashNudge = thrash.observe({ tool: String(event.toolName ?? ""), argsDigest: stepDigest((event as any).args) });
      const nudge = [memoryNudge, thrashNudge].filter(Boolean).join("\n\n");
      if (nudge) void runControl.steer(nudge).catch(() => {});
    }
    // Журнал нехватки (14.10.2026): роль позвала инструмент, которого у неё
    // нет, — по этим записям возвращаем убранное точечно.
    if (event.toolName && !availableToolNames.has(event.toolName) && !missingLogged.has(event.toolName)) {
      missingLogged.add(event.toolName);
      // Зачем звала: аргументы вызова и последняя мысль роли перед ним —
      // по ним видно, тупит роль или инструмент ей правда нужен.
      // «removed» — инструмент есть у других ролей, этой его не дали;
      // «absent» — его нет ни у кого: кандидат на новый инструмент.
      const missing = knownToolNames().has(event.toolName) ? "removed" : "absent";
      const why = JSON.stringify({ missing, args: event.args ?? null, thought: lastAssistantThought.slice(-1200) }).slice(0, 3000);
      try { logEvent({ taskId, actorId: roleUserId(role), kind: "role_tool_missing", field: role, fromValue: why, toValue: String(event.toolName).slice(0, 100) }); } catch {}
    }
    const kind=KIND[event.toolName] ?? (event.toolName?.startsWith("mcp__xcode__") ? (event.toolName.includes("write") ? "write" : event.toolName.includes("read") ? "read" : event.toolName.includes("test") ? "test" : "run") : undefined);
    if(!kind) return;
    const a = event.args ?? {};
    const target = String(a.path ?? a.file_path ?? a.command ?? a.pattern ?? event.toolName).slice(0, 200);
    void postActivity(role, taskId, kind, target, input.subtaskId);
    // Любой реальный вызов инструмента — фактическая активность роли,
    // обновляем метку для sweeper тишины (taskflow-flow.md, п.9 части II).
    touchRunActivity(runId);
  });

  const beat = setInterval(() => {
    const heartbeatPath = input.subtaskId ? `/api/subtasks/${input.subtaskId}/work` : `/api/tasks/${taskId}/heartbeat`;
    void asRole(role, "POST", heartbeatPath, {}).catch(() => {});
  }, HEARTBEAT_MS);

  let runFailure: Error | null = null;
  /** Ход упёрся в лимит провайдера: перезапустим на запасной модели вместо блока. */
  let limitHit: string | null = null;
  let stalledSettle: { subtaskId: string; madeProgress: boolean; failure: string | null } | null = null;
  const work = (async () => {
    try {
      const baseTask = input.prompt ?? (input.subtaskId
        ? planSubtaskPrompt(taskId, role, input.subtaskId)
        : (resumed ? resumePrompt(taskId, role) : defaultTaskPrompt(taskId, role)));
      const task = previousDigest
        ? `Прежний исполнитель этого шага заменён. Ниже — выжимка его сессии: не повторяй уже проверенное, но его выводы сверь на месте, прежде чем на них опираться.\n\n${previousDigest}\n\n---\n\n${baseTask}`
        : baseTask;
      // Память команды (02.10.2026): то, что уже известно по теме задачи,
      // приходит в задание само — роли не надо помнить, что надо спросить.
      const about = db.prepare("SELECT title, description, project_id FROM tasks WHERE id = ?").get(taskId) as
        | { title?: string; description?: string | null; project_id?: string | null }
        | undefined;
      const stepTitle = input.subtaskId
        ? ((db.prepare("SELECT title FROM subtasks WHERE id = ?").get(input.subtaskId) as { title?: string } | undefined)?.title ?? "")
        : "";
      const memory = await roleProjectContext({
        role,taskId,
        projectId: about?.project_id ?? null,
        query: [about?.title, stepTitle, (about?.description ?? "").slice(0, 1_500)].filter(Boolean).join("\n"),
      });
      const queued=input.subtaskId ? db.prepare("SELECT m.id,m.text FROM slot_topic_inbox i JOIN chat_messages m ON m.id=i.message_id WHERE i.subtask_id=? AND i.delivered_at IS NULL ORDER BY m.created_at,m.rowid").all(input.subtaskId) as {id:string;text:string}[] : [];
      for(const m of queued){runControl.messengerMessages.add(m.id);runControl.unacknowledgedMessengerMessages.add(m.id);}
      const messages=queued.map(m=>{const handoff=resolutionHandoff(m.id);return `${handoff ? handoff+"\n" : ""}Сообщение темы задачи ${taskId}, id ${m.id}. Ответь через taskflow_chat_reply(message_id=${m.id},text=...). Данные: ${JSON.stringify(m.text)}`;}).join("\n");
      // Снимок предыдущей попытки этого слота (владелец 04.10.2026): ход роли
      // умирает вместе с процессом, и без снимка следующий вызов начинает с
      // нуля. Ставим после задания этапа и ДО контекста запуска, чтобы роль
      // читала его как часть постановки, а не как приложение.
      const snapshot=input.subtaskId ? slotSnapshotBlock(input.subtaskId) : null;
      const reportAdvice=role==="critic_verifier" && mode==="review" ? await reportReviewBlockForTask(taskId,input.subtaskId) : "";
      const prompt = `${task}${reportAdvice}\n\n${messages}\n\nПереписка: до 100 слов, сообщение о блоке до 50. Адресат, задача, конкретный этап и вопрос по специализации коллеги. В ответе укажи адресата и reply_to_message_id. Полные отчёты сохраняй через taskflow_doc_write в папке задачи, в чат и комментарии дай короткую суть и ссылку.${snapshot ? `\n\n${snapshot}` : ""}\n\n${launchContext.prompt}\n\n${topicContext(taskId)}${memory ? `\n\n${memory}` : ""}`;
      // Чек-лист идёт ПЕРЕД задачей (13.10.2026, владелец: «подсунуть ему
      // промп поближе»). В хвосте промпта, после задачи, переписки, контекста
      // запуска и памяти, инструкция о плане терялась: модель к этому месту
      // уже увлечена задачей и 89% плановых слотов оставались без плана.
      // Перед постановкой — первое, что агент читает, поэтому и заполняет.
      // Карта команды (владелец 05.11.2026): роль отвечает за свой кусок и знает, кто идёт дальше.
      const teamMap = input.subtaskId ? slotTeamMap(input.subtaskId) : "";
      const workPlanPrompt = (input.subtaskId ? "\n\n" + (composeLayer(role, "tool.runtime.taskflow_work_plan")?.effective ?? WORK_PLAN_INSTRUCTION) : "") + (teamMap ? "\n\n" + teamMap : "");
      assertRunTaskAvailable(taskId);
      await session.prompt(workPlanPrompt + (mode === "work" ? `${prompt}\n\n${repoNote(cwd)}\n${renderInstruction(role, "task.documentation", {})}` : prompt));
      // Лимит провайдера библиотека не бросает: ход молча кончается ответом с ошибкой 429
      // (находка А36). Ловим здесь и уходим на запасную модель.
      limitHit = lastAssistantLimitError(session);
      // Пустой ответ модели (content без текста, расход 0/0, ошибки нет) —
      // тоже сбой хода, а не успешный ход с тишиной (21.10.2026: 13 молчащих
      // ответов подряд у critic_verifier). Ловим здесь: попытка закрывается
      // failed с причиной, шаг видно в ленте, сторож не списывает его потом
      // как auto_restarted.
      if (!limitHit && lastAssistantError(session)) throw new Error(lastAssistantError(session)!);
      if (!limitHit) {
        const emptyAnswer = lastAssistantEmptyAnswer(session);
        if (emptyAnswer) {
          runFailure = new Error(emptyAnswer);
          // Попытку закрываем сами: пустой ответ — провал хода, а не тишина,
          // которую потом добьёт сторож (21.10.2026).
          const attemptId = input.subtaskId
            ? (
                db
                  .prepare("SELECT current_attempt_id FROM subtasks WHERE id = ?")
                  .get(input.subtaskId) as { current_attempt_id: string | null } | undefined
              )?.current_attempt_id
            : (
                db
                  .prepare("SELECT current_attempt_id FROM tasks WHERE id = ?")
                  .get(taskId) as { current_attempt_id: string | null } | undefined
              )?.current_attempt_id;
          if (attemptId) {
            db.prepare(
              "UPDATE attempts SET ended_at = datetime('now'), outcome = 'failed', reason = ? WHERE id = ? AND ended_at IS NULL",
            ).run(emptyAnswer, attemptId);
          }
          // Карточка без шага плана: блокировать нечего — гасим саму карточку
          // с причиной, иначе ход висит как успешный (тот же путь, что при
          // сорванном запуске).
          if (!input.subtaskId && mode !== "review") {
            try {
              await asRole(role, "POST", `/api/tasks/${taskId}/state`, {
                state: "blocked",
                block_type: "transient",
                comment: `Запуск прервался: ${emptyAnswer}`,
                help_skip_reason: "провайдер вернул пустой ответ — другая роль его не повторит",
              });
            } catch {
              // карточка могла и не быть взята — тогда блокировать нечего
            }
          }
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Замер сорванного хода (владелец 27.10.2026, «Request timed out»).
      console.warn(`[run] ход шага сорвался task=${taskId} role=${role}: ${reason.slice(0, 200)}`, JSON.stringify(liveTurn.diagnostics()));
      if (isProviderLimitText(reason)) limitHit = reason;
      else runFailure = error instanceof Error ? error : new Error(reason);
      // Обрыв сети — не провал роли (владелец 02.11.2026): карточку не
      // блокируем, шаг уйдёт в повтор через settleStalledPlanNode.
      const network = isNetworkFailure(classifyFailureReason(reason));
      // Сделанное не теряем: итог хода — в ленту карточки.
      if (network || runFailure) salvageRunText(reason);
      if (mode !== "review" && !limitHit && !runControl.replacementRequested && !network) try {
        await asRole(role, "POST", `/api/tasks/${taskId}/state`, {
          state: "blocked",
          block_type: "transient",
          comment: `Запуск прервался: ${reason.slice(0, 300)}`,
          // Технический сбой среды — не то, что снимет другая роль
          // (карточка cd10bf34). Скажем это явно, а не полагаемся на слова.
          help_skip_reason: "технический сбой запуска — другая роль его не снимет",
        });
      } catch {
        // карточку могли и не взять — тогда блокировать нечего
      }
    } finally {
      clearInterval(beat);
      unsubscribeLive();
      liveTurn.finish();
      const runActivity = activeRuns.get(runId)?.activityCount ?? 0;
      activeRuns.delete(runId);
      // Снимок остановки (владелец 04.10.2026, пункт 2 и 3 плана). Слот не
      // сдан — значит работа не закончилась, и следующему вызову роли без
      // следа не продолжить. Сначала пробуем спросить саму роль (короткий
      // ход с потолком по времени), иначе пишем техснимок сами: остановка не
      // должна ждать модель и не должна оставлять пустоту.
      if (input.subtaskId && mode === "work" && !limitHit) {
        try {
          const closed = (db.prepare("SELECT done FROM subtasks WHERE id = ?").get(input.subtaskId) as { done: number } | undefined)?.done === 1;
          if (closed) {
            // Слот сдан: снимок уже записан на пути сдачи, второй раз не пишем.
          } else if (runControl.replacementRequested) {
            technicalSlotSnapshot(input.subtaskId, "stopped", { blocker: "владелец запросил свежую попытку в том же слоте" });
          } else if (runFailure) {
            technicalSlotSnapshot(input.subtaskId, "failed", {
              blocker: (runFailure as Error).message.slice(0, 300),
            });
          } else {
            const slotTitle = (db.prepare("SELECT title FROM subtasks WHERE id = ?").get(input.subtaskId) as { title?: string } | undefined)?.title ?? "";
            const summary = await askStopSummary(session, input.subtaskId, role, slotTitle);
            if (summary) {
              saveSlotSnapshot({ subtaskId: input.subtaskId, reason: "stopped", ...summary });
            } else {
              technicalSlotSnapshot(input.subtaskId, "stopped", { blocker: "ход остановлен без резюме роли" });
            }
          }
        } catch (error) {
          // Снимок не должен ронять ход: ошибка здесь — повод записать
          // техснимок, а не причина срывать работу слота.
          try {
            technicalSlotSnapshot(input.subtaskId, "stopped", { blocker: "снимок не записался: " + String(error).slice(0, 120) });
          } catch {
            // базы нет — молча
          }
        }
      }
      if(input.subtaskId)rememberSlotSession(input.subtaskId,manager);
      try { session.dispose(); }
      finally { await processLease?.dispose().catch(error => console.warn("[roleProcesses] run cleanup failed; guard will retry", String(error))); }
      resourceLoader.disposeResources();
      await composio.close().catch(() => {});
      await infra.close().catch(() => {});
      // Шаг плана закончил ход без сдачи: сервер сам продолжает его при прогрессе
      // (до 3 раз) или видимо блокирует. Раньше такой шаг молча оставался
      // «в работе» без запуска (находка А30, 06.10.2026).
      // Только запоминаем: settle запускается после completion. Внутри хода
      // его ждать нельзя — продолжение берёт замок слота (acquireSlotSession),
      // а runRoleInProcess отпускает его лишь по completion этого же хода.
      // Взаимная блокировка: попытка-продолжение создана, хода нет (с 06.10.2026
      // каждое продолжение вытаскивал только сторож; шаг 38e1e969, 19.10.2026).
      if (input.subtaskId && mode === "work" && !limitHit && !runControl.replacementRequested) {
        stalledSettle = {
          subtaskId: input.subtaskId,
          madeProgress: runActivity >= STALLED_NODE_MIN_ACTIVITY,
          failure: runFailure ? (runFailure as Error).message : null,
        };
      }
      // Сдал на проверку — дальше Критик (если включена автопроверка).
      // После самого Критика не будим: при сбое он будил бы себя по кругу.
      if (mode === "work" && !input.subtaskId && !limitHit) {
        void continueOrHandOff(
          taskId,
          role,
          before,
          input.durableHandoff ?? false,
          input.chainDepth ?? 0,
          runId,
        );
      }
    }
  })();
  pending.add(work);
  void work.finally(() => pending.delete(work));

  const completion = work.then(() => {
    if (limitHit && !runControl.replacementRequested) scheduleProviderFailover();
    if (runFailure) throw runFailure;
  });
  runControl.completion = completion;
  // Замок слота отпускается обработчиком completion в runRoleInProcess; settle
  // идёт следующим макрозадачей и уже не держит этот ход.
  void completion.catch(() => {}).then(() => {
    const params = stalledSettle;
    if (!params) return;
    setImmediate(() => {
      const settled = import("./planSubtaskAdmission.js")
        .then(({ settleStalledPlanNode }) => settleStalledPlanNode(params))
        .then(() => {}, (error) => console.warn("[plan] продолжение/блокировка шага не удалась:", error));
      pending.add(settled);
      void settled.finally(() => pending.delete(settled));
    });
  });
  /** Лимит: помечаем провайдера, берём следующую модель цепочки и перезапускаем ход. */
  function scheduleProviderFailover(): void {
    const depth = input.failoverDepth ?? 0;
    const reason = limitHit ?? "provider limit";
    const next = depth < 3 ? pickFailoverModel(routing, role, modelRef, reason) : null;
    if (!next) {
      // Запасных нет — прежнее поведение: шаг виден заблокированным, причина в ленте.
      if (input.subtaskId && mode === "work") {
        void import("./planSubtaskAdmission.js").then(({ settleStalledPlanNode }) =>
          settleStalledPlanNode({ subtaskId: input.subtaskId!, madeProgress: false, failure: `лимит провайдера, запасных моделей нет: ${reason.slice(0, 100)}`, failureCode: "provider_quota_limit" }),
        ).catch(() => {});
      }
      return;
    }
    logStepOutcome({ taskId, actorId: null, subtaskId: input.subtaskId ?? null, role, outcome: "failed", error: reason, message: `переключение модели ${modelRef} → ${next}: ${reason.slice(0, 120)}` });
    void (async () => {
      try {
        if (input.subtaskId && mode === "work") {
          // Шаг плана: закрыть неудачную попытку, записать модель шага и стартовать заново.
          const row = db.prepare("SELECT current_attempt_id FROM subtasks WHERE id = ?").get(input.subtaskId) as { current_attempt_id: string | null } | undefined;
          if (row?.current_attempt_id) {
            db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'failed', reason = ? WHERE id = ? AND ended_at IS NULL")
              .run(`provider_limit → ${next}`, row.current_attempt_id);
          }
          db.prepare("UPDATE subtasks SET model = ?, agent_state = NULL, current_attempt_id = NULL WHERE id = ?").run(next, input.subtaskId);
          const { startPlanSubtaskRun } = await import("./planSubtaskAdmission.js");
          const started = await startPlanSubtaskRun(input.subtaskId, roleUserId(role));
          if (!started.ok) console.warn("[failover] шаг не перезапущен:", started.error);
        } else {
          await runRoleInProcess({ ...input, ownerStartActorId: undefined, model: next, failoverDepth: depth + 1 });
        }
      } catch (error) {
        console.warn("[failover] перезапуск на запасной модели не удался:", error);
      }
    })();
  }
  // Прямые ручные вызовы исторически не обязаны await completion. Worker
  // await-ит её и видит reject; этот handler предотвращает unhandled rejection
  // у совместимых fire-and-forget callers, не меняя исходную Promise.
  void completion.catch(() => {});
  return { runId, completion };
}

// ── Кто и когда будит роль (этап C2, 23.09.2026) ───────────────────────────
//
// Те же решения, что принимала Система (decide), но в сервере:
// он и так видит каждое изменение карточки. При включённом флаге
// TASKFLOW_ROLES_IN_SERVER=1 карточки ролей больше не берёт.

export type KickReason = "assigned" | "commented" | "review" | "after_run";

export function reviewPromptFor(taskId: string): string {
  const once=oneShotReviewInstruction(taskId);
  if(once)return once;
  const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title?: string } | undefined;
  return renderInstruction("critic_verifier", "task.review", { roleTitle: roleTitle("critic_verifier"), taskId, title: task?.title ?? "", rules: effectiveRules("critic_verifier").map(r => `- ${r}`).join("\n") });
}

function replyPrompt(taskId: string, role: string): string {
  const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title?: string } | undefined;
  return renderInstruction(role, "task.reply", { roleTitle: roleTitle(role), taskId, title: task?.title ?? "", rules: effectiveRules(role).map(r => `- ${r}`).join("\n") });
}

function reviewerPending(taskId: string): boolean {
  const reviewerFirst = (
    db.prepare("SELECT reviewer_first_default FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as
      | { reviewer_first_default?: number }
      | undefined
  )?.reviewer_first_default;
  if ((reviewerFirst ?? 1) !== 1) return false;
  const current = db
    .prepare("SELECT id FROM artifact_versions WHERE task_id = ? ORDER BY version_no DESC LIMIT 1")
    .get(taskId) as { id?: string } | undefined;
  if (!current?.id) return true;
  const verdict = db
    .prepare("SELECT 1 FROM reviews WHERE task_id = ? AND version_id = ? LIMIT 1")
    .get(taskId, current.id);
  return !verdict;
}

/**
 * Разбудить роль по карточке, если есть повод. Никогда не бросает: это
 * следствие чужого действия, а не его часть. Работает, только когда
 * включена «Система» (тот же выключатель, что и раздача).
 */
export type KickRoleTaskResult =
  | { outcome: "started"; runId: string; completion: Promise<void> }
  | { outcome: "skipped"; reason: string }
  | { outcome: "deferred"; reason: string; delaySeconds: number };

/**
 * Проверить актуальное состояние карточки и начать run. В отличие от
 * kickRoleTask, ошибки не проглатываются: durable worker обязан записать
 * retry/dead, а не считать технический сбой успешной обработкой job.
 */
export async function kickRoleTaskStrict(
  taskId: string,
  reason: KickReason,
  actorId?: string | null,
  options?: { durableHandoff?: boolean; chainDepth?: number; manualStart?: boolean },
): Promise<KickRoleTaskResult> {
  // Журнал серверных событий (карточка e87cd93f): одна операция —
  // один operation_id, терминальное событие пишется всегда. Ловим и
  // нештатные сбои, и обычные «skipped» — без терминального события
  // цепочка рвётся, и по operation_id нельзя понять, чем кончилось.
  const op = recordServerOperation({
    scope: "role_run",
    kind: "role_run",
    actorId: actorId ?? null,
    taskId,
    message: `kick role task: ${reason}`,
    data: {
      reason,
      chain_depth: options?.chainDepth ?? 0,
      manual_start: options?.manualStart === true ? 1 : 0,
    },
  });
  let result: KickRoleTaskResult;
  try {
    result = await kickRoleTaskStrictImpl(taskId, reason, actorId, options);
  } catch (kickErr) {
    const norm = normalizeServerError(kickErr, "role_run_failed");
    op.err({
      taskId,
      message: `kickRoleTaskStrict: ${norm.message || norm.code}`,
      errorCode: norm.code,
      errorMessage: norm.message,
    });
    throw kickErr;
  }
  // Перевод исхода в финальное событие. Результат функции не зависит
  // от того, что мы тут записали: durable worker всё равно движется
  // по своему контракту.
  const skipReason =
    "reason" in result && typeof result.reason === "string" ? result.reason : null;
  if (result.outcome === "started") {
    op.ok({ taskId, message: skipReason ? `started: ${skipReason}` : "started" });
  } else if (result.outcome === "skipped") {
    op.cancel({ taskId, message: skipReason ? `skipped: ${skipReason}` : "skipped" });
  } else {
    // 'deferred' — отдельный путь: worker сам сделает новую попытку.
    op.cancel({
      taskId,
      message: skipReason ? `deferred: ${skipReason}` : "deferred",
      data: { delay_seconds: result.delaySeconds ?? null },
    });
  }
  return result;
}

/** Внутренняя реализация kickRoleTaskStrict — без журнала, ради чистого
 *  flow с return'ами. Обвязка журналом живёт в kickRoleTaskStrict выше. */
async function kickRoleTaskStrictImpl(
  taskId: string,
  reason: KickReason,
  actorId?: string | null,
  options?: { durableHandoff?: boolean; chainDepth?: number; manualStart?: boolean },
): Promise<KickRoleTaskResult> {
  // В тестах живых агентов не зовём — только там, где тест это разрешил явно.
  if (process.env.VITEST && process.env.TASKFLOW_KICK_IN_TESTS !== "1") {
    return {
      outcome: "deferred",
      reason: "role runs are disabled in tests",
      delaySeconds: 30,
    };
  }
  const { unitState } = await import("../routes/agent-service.js");
  const explicitOwnerStart = options?.manualStart === true && (reason === "assigned" || reason === "review") && Boolean(actorId && isOwner(actorId));
  if (!(await unitState()).active && !explicitOwnerStart) {
    return {
      outcome: "deferred",
      reason: "autonomous system is disabled",
      delaySeconds: 30,
    };
  }
  if (activeInProcessRun(taskId)) {
    return {
      outcome: "deferred",
      reason: "task already has an active in-process run",
      delaySeconds: 5,
    };
  }
  const task = db
    .prepare("SELECT id, status, assignee_id, agent_state, ready_for_pickup FROM tasks WHERE id = ?")
    .get(taskId) as
    | { id: string; status: string; assignee_id: string | null; agent_state: string | null; ready_for_pickup: number | null }
    | undefined;
  if (!task || task.status !== "active") {
    return { outcome: "skipped", reason: "task is absent or no longer active" };
  }
  const assignee = task.assignee_id ?? "";
  const role = assignee.startsWith("role_") ? assignee.slice("role_".length) : "";

  // Сдано на проверку — Критик, если автопроверка включена и вердикта ещё нет.
  if (task.agent_state === "review" && (reason === "review" || reason === "after_run")) {
    if (ROLE_NAMES.includes("critic_verifier") && (hasPendingPlanFinalReview(taskId) || reviewerPending(taskId))) {
      markPlanFinalReviewerStarted(taskId);
      const run = await runRoleInProcess({
        taskId,
        role: "critic_verifier",
        prompt: `${reviewPromptFor(taskId)}\n\n${planReviewRouteContext(taskId)}\n\n${oneShotReviewInstruction(taskId) ? "Разовая проверка: не передавай rework_steps; замечания завершают проверку." : "Для доработки плана передай rework_steps: slot_key первого дефектного рабочего этапа. Несколько slot_key разрешены только для независимых параллельных веток. Сервер повторит затронутую цепочку и итоговую проверку."}`,
        mode: "review",
        ownerStartActorId: explicitOwnerStart ? actorId ?? undefined : undefined,
      }).catch(error => { markPlanFinalReviewerWaiting(taskId); throw error; });
      logEvent({ taskId, actorId: null, kind: "reviewer_sent", toValue: roleTitle("critic_verifier") });
      return { outcome: "started", ...run };
    }
    return { outcome: "skipped", reason: "reviewer is disabled or verdict already exists" };
  }
  if (!role || !ROLE_NAMES.includes(role)) {
    return { outcome: "skipped", reason: "task has no enabled role assignee" };
  }

  if (reason === "after_run" && task.agent_state === "in_progress") {
    const chainDepth = options?.chainDepth ?? 0;
    if (chainDepth > MAX_CHAIN) {
      return { outcome: "skipped", reason: "continuation chain limit reached" };
    }
    const run = await runRoleInProcess({
      taskId,
      role,
      prompt: resumePrompt(taskId, role),
      durableHandoff: options?.durableHandoff ?? false,
      chainDepth,
    });
    return { outcome: "started", ...run };
  }

  // Владелец написал по сданной карточке — роль только отвечает.
  if (task.agent_state === "review" && reason === "commented" && actorId && actorId !== assignee) {
    const run = await runRoleInProcess({ taskId, role, prompt: replyPrompt(taskId, role), mode: "reply" });
    return { outcome: "started", ...run };
  }
  if (task.agent_state === "blocked") {
    return { outcome: "skipped", reason: "task is blocked and awaits owner action" };
  }
  // Работа не начата (или снята с агента после ответа владельцу) — выполнить.
  if (!task.agent_state && reason !== "after_run") {
    chainCount.delete(taskId);
    const run = await runRoleInProcess({
      taskId,
      role,
      durableHandoff: options?.durableHandoff ?? false,
    });
    return { outcome: "started", ...run };
  }
  return { outcome: "skipped", reason: "job is stale for the current task state" };
}

export async function kickRoleTask(taskId: string, reason: KickReason, actorId?: string | null): Promise<void> {
  try {
    await kickRoleTaskStrict(taskId, reason, actorId);
  } catch (err) {
    console.warn(`роль по карточке ${taskId} не разбужена:`, err);
  }
}

/**
 * Карточки на ревью, которые Критик так и не посмотрел, потому что в
 * момент их сдачи роль `critic_verifier` была выключена: `kickRoleTaskStrict`
 * тогда возвращает терминальный "skipped" (не "deferred" — это не про
 * выключенную «Систему», attempts не сохраняются), и job в очереди больше
 * не перезапускается сам. Включение роли обратно должно значить «пошёл
 * смотреть», а не «жди следующего повода» — владелец 30.09.2026, тот же
 * принцип, что у тумблера «Система» (`sweepStragglers` в agent-service.ts).
 * Безопасно звать и для карточек, которым ревью не нужно прямо сейчас —
 * kickRoleTaskStrict сам проверяет reviewerPending и no-op'ает.
 */
export async function sweepPendingReviews(actorId: string): Promise<void> {
  const pending = db
    .prepare(`SELECT id FROM tasks WHERE status = 'active' AND agent_state = 'review' ORDER BY updated_at ASC`)
    .all() as Array<{ id: string }>;
  for (const { id } of pending) {
    await kickRoleTaskStrict(id, "review", actorId);
  }
}

/**
 * После захода по работе: сдал — дальше Критик (kickRoleTask); вышел посреди
 * работы, но продвинулся — ещё заход, до трёх подряд, в том же разговоре.
 * Без продвижения не зовём: крутиться впустую нельзя.
 */
async function continueOrHandOff(
  taskId: string,
  role: string,
  before: string,
  durableHandoff: boolean,
  chainDepth: number,
  runId: string,
): Promise<void> {
  const task = db.prepare("SELECT status, agent_state FROM tasks WHERE id = ?").get(taskId) as
    | { status: string; agent_state: string | null }
    | undefined;
  if (task?.status === "active" && task.agent_state === "in_progress") {
    const n = durableHandoff
      ? chainDepth + 1
      : (chainCount.get(taskId) ?? 0) + 1;
    const madeProgress = progressMark(taskId) !== before;
    if (n > MAX_CHAIN || !madeProgress) {
      // Лимит продолжений исчерпан или прогресса нет: сервер блокирует
      // карточку, чтобы владелец решил, как двигаться дальше.
      // Владелец 05.10.2026, п.9 части II taskflow-flow.md.
      chainCount.delete(taskId);
      const reason = !madeProgress
        ? `Заход роли не продвинул карточку (сделано шагов/комментариев: ${before.split(":").join("/")}). Дальше без владельца не иду.`
        : `Достигнут лимит продолжений (${MAX_CHAIN}) — карточка заблокирована, требуется решение владельца.`;
      try {
        await asRole(role, "POST", `/api/tasks/${taskId}/state`, {
          state: "blocked",
          block_type: "needs_input",
          comment: reason.slice(0, 400),
          help_skip_reason: "нужно решение владельца — задача не продвигается без него",
        });
      } catch (error) {
        console.warn(`продолжение по ${taskId} не заблокировано:`, error);
      }
      return;
    }
    if (n <= MAX_CHAIN && madeProgress) {
      if (durableHandoff) {
        enqueueRoleRunJob({
          taskId,
          reason: "after_run",
          dedupeKey: `after-run:${runId}`,
          chainDepth: n,
        });
        return;
      }
      chainCount.set(taskId, n);
      try {
        await runRoleInProcess({ taskId, role, prompt: resumePrompt(taskId, role) });
      } catch (err) {
        console.warn(`повторный заход по ${taskId} не начат:`, err);
      }
    }
    return;
  }
  chainCount.delete(taskId);
  if (!durableHandoff) await kickRoleTask(taskId, "after_run");
}
