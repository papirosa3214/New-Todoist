import { acquireSlotSession,openSlotSession,rememberSlotSession,resolveTopicSlot } from "./slotSession.js";
import { connectBuilderXcode } from "./builderXcode.js";
import { branchMembership } from "./branchPlan.js";
import { ensurePlanTopic, topicContext } from "../lib/projectTopics.js";
import { markPlanFinalReviewerStarted, markPlanFinalReviewerWaiting, hasPendingPlanFinalReview, planReviewRouteContext } from "./planReviewLifecycle.js";
import { instructionResources, createTaskResourceLoader } from "./instructionResources.js";
import { ensureRoleHome } from "./roleHome.js";
import { connectRoleComposio } from "./composioRuntime.js";
import { roleProjectContext,roleProjectSnapshot } from "./roleProjectContext.js";
import { saveSlotSnapshot, slotSnapshotBlock, technicalSlotSnapshot } from "./slotWorkSnapshot.js";
import { buildTaskHistory } from "./taskHistoryContext.js";
import { INSTRUCTION_DEFAULTS } from "./instructionDefaults.js";
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
import { getModelRuntime } from "./PiRuntimeAdapter.js";
import { parseModelRef, recordAttemptModel } from "../lib/attemptModel.js";
import { enqueueRoleRunJob } from "./roleRunQueue.js";
import { buildInProcessTaskContext } from "./taskContextBridge.js";
import { buildDependencyContext } from "./dependencyContext.js";
import { buildCollaborationPlanContext } from "./collaborationPlanContext.js";
import { roleWorkspace } from "./roleWorkspace.js";
import { ensureTaskArtifactFolder } from "../lib/taskArtifactFolder.js";
import { recordTaskDocument } from "../lib/taskOutcome.js";
import { isProviderLimitText, lastAssistantLimitError, pickFailoverModel, pickStartModel } from "./providerFailover.js";
import { logStepOutcome } from "./stepOutcome.js";

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

/** Подключается при старте сервера (index.ts). */
export function setInProcessApp(instance: FastifyInstance): void {
  app = instance;
}

type Json = Record<string, unknown>;

export class ToolError extends Error {}

/** Внутренний вызов маршрута от имени роли. Подпись живёт в памяти сервера
 *  на один вызов: наружу не уходит, храниться нигде не нужно. */
export async function asRole(
  role: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<any> {
  if (!app) throw new ToolError("сервер ещё не поднят");
  const token = app.jwt.sign({ id: roleUserId(role) }, { expiresIn: "5m" });
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
    throw new ToolError(`${method} ${url} → ${res.statusCode}: ${data?.error ?? raw.slice(0, 200)}`);
  }
  return data;
}

export function unwrap(d: any): any {
  return d && typeof d === "object" && "task" in d ? d.task : d;
}

export function short(t: any): Json {
  return {
    id: t?.id,
    название: t?.title,
    статус: t?.status,
    работа: t?.agent_state ?? "не взята",
  };
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
async function activity(role: string, taskId: string, kind: string, target: string): Promise<void> {
  try {
    await asRole(role, "POST", `/api/tasks/${taskId}/activity`, { kind, target });
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
async function callResearchTool(name: string, args: unknown): Promise<unknown> {
  let stdout: string;
  try {
    // execFile (промисифицированный) не понимает опцию input, как
    // execFileSync — аргументы пишем в stdin самого child вручную, до
    // ожидания результата (PromiseWithChild даёт доступ к процессу через
    // .child, не дожидаясь await).
    const home = ensureRoleHome("researcher");
    const pending = execFileAsync("python3", [path.join(home.scripts, "research_server.py"), "--call", name], {
      cwd: home.workspace,
      timeout: RESEARCH_TOOL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        // Ролевой ключ — НЕ общий TASKFLOW_AGENT_TOKEN (он сознательно
        // отозван, см. CLAUDE.md §5.1), а свой, для собственных запросов
        // роли к API (например, скачать вложение задачи под ocr).
        TASKFLOW_VAULT_KEY: "TASKFLOW_AGENT_TOKEN_RESEARCHER",
      },
    });
    pending.child.stdin?.end(JSON.stringify(args ?? {}));
    const result = await pending;
    stdout = result.stdout;
  } catch (err: any) {
    // execFile бросает и на ненулевой exit code — наш --call всегда пишет
    // JSON в stdout ДО exit(1), так что содержательная ошибка обычно там же.
    stdout = err?.stdout ?? "";
    if (!stdout) throw new ToolError(`research-инструмент ${name} не запустился: ${err?.message ?? String(err)}`);
  }
  let parsed: { result?: unknown; error?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ToolError(`research-инструмент ${name} вернул не JSON: ${stdout.slice(0, 500)}`);
  }
  if (parsed.error) throw new ToolError(parsed.error);
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
export function taskflowTools(role: string, model: string | null, taskId?: string, subtaskId?:string) {
  const T = (
    name: string,
    description: string,
    parameters: any,
    run: (p: any) => Promise<unknown>,
  ) => {
    const key = "tool.runtime." + name;
    registerInstructionBlock({key,title:name,group:"Возможности",scope:"command",modes:["work","resume","reply","review","subtask"],sourceKind:"code",originRef:"inProcessRun.ts:taskflowTools:"+name,readOnly:false,
      ...(["web_search","web_get","ocr","youtube","local_model","taskflow_report"].includes(name)?{roles:["researcher"]}:{})},description);
    return defineTool({
      name,
      label: name,
      description: composeLayer(role,key)!.effective,
      parameters,
      execute: async (_id: string, params: any) => {
        try {
          if(subtaskId && ["taskflow_subtask_work","taskflow_subtask_done"].includes(name) && params.id!==subtaskId)throw new ToolError("Работай только в назначенном текущем слоте");
          if(subtaskId && ["taskflow_state","taskflow_heartbeat"].includes(name) && params.id!==taskId)throw new ToolError("Состояние относится только к текущему слоту");
          return asText(await run(params));
        } catch (e) {
          const msg = e instanceof ToolError ? e.message : `сбой инструмента ${name}: ${String(e)}`;
          throw new Error(msg);
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
      if(!db.prepare("SELECT 1 FROM chat_members WHERE chat_id=? AND member_id=?").get(topic.id,roleUserId(p.to))) throw new ToolError("Роль не участвует в теме");
      if(p.slot_key && !db.prepare(`SELECT 1 FROM task_collaboration_plan_nodes n JOIN task_collaboration_plans p ON p.id=n.plan_id WHERE p.task_id=? AND p.status='approved' AND n.role_key=? AND n.slot_key=? AND n.skipped_at IS NULL`).get(target,p.to,p.slot_key)) throw new ToolError("Слот не относится к текущему участнику");
      const targetSlots=db.prepare("SELECT n.slot_key FROM task_collaboration_plan_nodes n JOIN task_collaboration_plans p ON p.id=n.plan_id WHERE p.task_id=? AND p.status='approved' AND n.role_key=? AND n.skipped_at IS NULL").all(target,p.to) as {slot_key:string}[];
      if(!p.slot_key) {
        if(targetSlots.length!==1) throw new ToolError("Укажи конкретный слот адресата");
        p.slot_key=targetSlots[0].slot_key;
      }
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
    T("taskflow_consult", "Получить второе мнение старшей модели по текущему рабочему слоту. Один совет на попытку; совет не меняет граф и приёмку.",Type.Object({question:Type.String(),context:Type.Optional(Type.Any())}),async(p)=>{
      if(!taskId) throw new ToolError("Нет текущей задачи");
      return asRole(role,"POST","/api/consult",{question:p.question,context:p.context,task_id:taskId,subtask_id:subtaskId});
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
    T("taskflow_state", "Сменить состояние работы: review — сдать на проверку, blocked — упёрся и жду владельца, in_progress — вернуться. Для review и blocked комментарий обязателен. Перед blocked реши, может ли помочь другая роль или более сильная модель; если позвал — укажи help_attempt («кого звал, что ответили»), если никто не решит — help_skip_reason. Без этого сервер откажет 409 по решаемой причине (нужен владелец/доступ/секрет проходят без него).",
      Type.Object({ id: Type.String(), state: Type.String(), comment: Type.Optional(Type.String()), help_attempt: Type.Optional(Type.String()), help_skip_reason: Type.Optional(Type.String()) }),
      async (p) => {
        if(subtaskId && p.id===taskId && ["in_progress","blocked","review"].includes(p.state)) {
          await asRole(role,"POST",`/api/subtasks/${subtaskId}/work`,{state:p.state,...(p.comment ? {result:p.comment}:{}),...(p.help_attempt ? {help_attempt:p.help_attempt}:{}),...(p.help_skip_reason ? {help_skip_reason:p.help_skip_reason}:{})});
          return {"состояние изменено":{task_id:taskId,subtask_id:subtaskId,состояние:p.state}};
        }
        const body: Json = { state: p.state };
        if (p.comment) body.comment = p.comment;
        if (p.help_attempt) body.help_attempt = p.help_attempt;
        if (p.help_skip_reason) body.help_skip_reason = p.help_skip_reason;
        const resp = await asRole(role, "POST", `/api/tasks/${p.id}/state`, body);
        return { "состояние изменено": short(unwrap(resp)) };
      }),
    T("taskflow_review", "Вердикт по сданной задаче: approved или changes_requested (с комментарием). Только для проверяющего. Для возврата плана rework_steps — ключи первых дефектных этапов текущего цикла; несколько только для независимых параллельных веток.",
      Type.Object({ id: Type.String(), verdict: Type.String(), findings: Type.Optional(Type.String()), rework_steps: Type.Optional(Type.Array(Type.String())) }),
      async (p) => {
        const versions = await asRole(role, "GET", `/api/tasks/${p.id}/versions`);
        const current = (versions.versions ?? []).find((v: any) => v.is_current);
        if (!current) throw new ToolError("у задачи нет актуальной версии результата — проверять нечего");
        const findings = (p.findings ?? "").trim();
        const body: Json = {
          task_id: p.id, version_id: current.id, artifact_hash: current.artifact_hash,
          criteria_version: "1", task_revision: current.task_revision, verdict: p.verdict,
        };
        if (findings) body.findings = findings;
        if (p.rework_steps) body.rework_steps = p.rework_steps;
        if (p.verdict === "changes_requested") {
          if (!findings) throw new ToolError("для возврата нужен комментарий: что доработать");
          const review = await asRole(role, "POST", "/api/reviews", body);
          if (!review.handled_by_plan) await asRole(role, "POST", `/api/tasks/${p.id}/state`, { state: "in_progress", comment: findings });
          return { вердикт: "возвращено на доработку", комментарий: findings };
        }
        const resp = await asRole(role, "POST", "/api/reviews", body);
        return { вердикт: resp.verdict, комментарий: resp.findings };
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
    T("taskflow_subtask_work", "Состояние шага: in_progress перед началом, blocked с причиной; result — итог. При blocked приложи snapshot: что сделано, что осталось, блок и следующий шаг — сервер сохранит это ДО смены состояния. Перед blocked по решаемой причине укажи help_attempt (кого звал, что ответили) или help_skip_reason (почему никто не решит). Пока работа идёт, технический снимок сервер пишет сам; при прогрессе и сдаче снимок от тебя не нужен.",
      Type.Object({ id: Type.String(), state: Type.Optional(Type.String()), result: Type.Optional(Type.String()), snapshot: Type.Optional(SNAPSHOT_SHAPE), help_attempt: Type.Optional(Type.String()), help_skip_reason: Type.Optional(Type.String()) }),
      async (p) => {
        const body: Json = {};
        if (p.state !== undefined) body.state = p.state;
        if (p.result !== undefined) body.result = p.result;
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
    T("taskflow_subtask_done", "Закрыть шаг с итогом (result — одно-два предложения). Сервер сам сохранит технический снимок при сдаче — отдельный snapshot не нужен. Если шаг — узел плана с контрактом на структурный артефакт (feature_spec и т.п.), передай artifact вместо простого закрытия галочкой: summary, payload (объект с required_fields) и evidence.",
      Type.Object({
        id: Type.String(),
        result: Type.Optional(Type.String()),
        done: Type.Optional(Type.Boolean()),
        snapshot: Type.Optional(SNAPSHOT_SHAPE),
        artifact: Type.Optional(Type.Object({ summary: Type.String(), payload: Type.Any(), evidence: Type.Optional(Type.Array(Type.Any())) })),
      }),
      async (p) => {
        if (p.artifact) {
          const row = await asRole(role, "POST", `/api/subtasks/${p.id}/artifact`, p.artifact);
          void activity(role, row.subtask?.task_id ?? "", "edit", `шаг «${row.subtask?.title ?? ""}»: сдал артефакт`);
          // Сдача артефакта — тоже движение роли (доработка MAK-66).
          if (row.subtask?.task_id) touchTaskActivity(row.subtask.task_id);
          return { "артефакт сдан": p.id, версия: row.artifact?.version_no };
        }
        const done = p.done ?? true;
        const body: Json = { done };
        if (p.result) body.result = p.result;
        if (p.snapshot) body.snapshot = p.snapshot;
        const row = await asRole(role, "PATCH", `/api/subtasks/${p.id}`, body);
        if (done && row.task_id) void activity(role, row.task_id, "edit", `шаг «${row.title ?? ""}»: закрыл`);
        return { [done ? "шаг отмечен" : "отметка снята"]: p.id };
      }),
    T("taskflow_rules", "Правила ведения учёта.", Type.Object({}), async () => ({ правила: effectiveRules(role) })),
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
    T("taskflow_doc_write", "Записать в документацию проекта: новая заметка (project_id) или дописать в существующую (id).",
      Type.Object({ markdown: Type.String(), id: Type.Optional(Type.String()), project_id: Type.Optional(Type.String()) }),
      async (p) => {
        if (!String(p.markdown).trim()) throw new ToolError("нечего записывать: markdown пуст");
        if (p.id) {
          const cur = await asRole(role, "GET", `/api/notes/${p.id}?format=markdown`);
          const merged = `${String(cur.markdown ?? "").trimEnd()}\n\n${p.markdown}`.trim();
          const n = await asRole(role, "PATCH", `/api/notes/${p.id}`, { markdown: merged });
          if (taskId) recordTaskDocument(taskId, n.id, roleUserId(role));
          return { готово: "заметка обновлена", id: n.id };
        }
        let folderId: number;
        if(taskId) folderId=ensureTaskArtifactFolder(taskId);
        else {
          if (!p.project_id) throw new ToolError("нужна задача, project_id или id заметки");
          const d=await asRole(role,"GET",`/api/projects/${p.project_id}/docs`);
          if(!d.folder) throw new ToolError("у проекта нет папки документации");
          folderId=d.folder.id;
        }
        const n = await asRole(role, "POST", "/api/notes", { markdown: p.markdown, folder_id: folderId });
        if (taskId) recordTaskDocument(taskId, n.id, roleUserId(role));
        return { готово: "заметка создана", id: n.id };
      }),
    T("taskflow_kb_search", "Поиск по документации проектов.",
      Type.Object({ query: Type.String(), top_k: Type.Optional(Type.Number()) }),
      async (p) => {
        const d = await asRole(role, "GET", `/api/knowledge/search?q=${encodeURIComponent(p.query)}&top_k=${p.top_k ?? 5}`);
        return { запрос: p.query, куски: (d.results ?? []).map((r: any) => ({ текст: String(r.text ?? "").slice(0, 1500), id_заметки: r.doc_id })) };
      }),
  ];

  // Пять специальных инструментов Исследователя — см. callResearchTool выше.
  // Только для этой роли: другим они не нужны и не были для них заведены
  // (researcher.json, сервер research — владелец 21.09.2026: «это НЕ общие
  // инструменты TaskFlow»).
  if (role === "researcher") {
    tools.push(
      T("web_search", "Найти в интернете: сначала Tavily, при недоступности — Brave. Возвращает список результатов со ссылками и выжимками. Текст страницы потом бери через web_get.",
        Type.Object({ query: Type.String(), max_results: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("web_search", p)),
      T("web_get", "Скачать страницу и вернуть её основное содержимое чистым markdown — без меню, рекламы и скриптов. Для PDF и сканов — ocr.",
        Type.Object({ url: Type.String(), max_chars: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("web_get", p)),
      T("ocr", "Распознать текст из изображения или PDF (в том числе скан без текстового слоя), русский+английский. Источник — attachment_id вложения задачи или path файла на машине.",
        Type.Object({ attachment_id: Type.Optional(Type.String()), path: Type.Optional(Type.String()), langs: Type.Optional(Type.String()), max_chars: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("ocr", p)),
      T("youtube", "Транскрипт видео YouTube в текст (сначала ручные субтитры, иначе авто). Источник-видео для исследования.",
        Type.Object({ url: Type.String(), langs: Type.Optional(Type.String()), max_chars: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("youtube", p)),
      T("local_model", "ЛОКАЛЬНАЯ модель на сервере (Ollama, бесплатно, без интернета). Этап «синтез»: отдай собранные фрагменты и задание — вернёт связный черновик или сводку.",
        Type.Object({ prompt: Type.String(), system: Type.Optional(Type.String()), max_tokens: Type.Optional(Type.Number()), num_ctx: Type.Optional(Type.Number()) }),
        (p) => callResearchTool("local_model", p)),
      T("taskflow_report", "Собрать отчёт по задаче: markdown → HTML и PDF, зеркало в документации проекта и секция «Отчёты» карточки.",
        Type.Object({ task_id: Type.String(), title: Type.Optional(Type.String()), markdown: Type.String() }),
        async (p) => asRole(role,"POST",`/api/tasks/${p.task_id}/reports`,{title:p.title ?? "Отчёт",markdown:p.markdown})),
    );
  }

  return subtaskId ? tools.filter(t => t.name !== "taskflow_claim") : tools;
}

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const HEARTBEAT_MS = 90_000;

/** Что агент роли получает на заходе внутри сервера — для экрана «Команда». */
export function inProcessToolNames(): string[] {
  return [...BUILTIN_TOOLS, ...taskflowTools("", null).map((t) => t.name)];
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
function planSubtaskPrompt(taskId: string, role: string, subtaskId: string): string {
  const subtask = db.prepare("SELECT title FROM subtasks WHERE id = ?").get(subtaskId) as { title?: string } | undefined;
  return renderInstruction(role, "task.plan", { roleTitle: roleTitle(role), taskId, subtaskId, subtaskTitle: subtask?.title ?? "", rules: effectiveRules(role).map(r => `- ${r}`).join("\n") });
}

// ── Папка проекта, справка, продолжение разговора (этап C3) ──────────────

const PROJECTS_CONFIG = path.join(process.cwd(), "scripts", "task-context-projects.json");
const RUNS_BASE = process.env.TASKFLOW_RUNS_DIR || path.join(os.homedir(), ".local", "state", "taskflow-runs");
export { LOCAL_EXECUTION_POLICY } from "./instructionDefaults.js";
const LOCAL_EXECUTION_POLICY = INSTRUCTION_DEFAULTS.local_policy;

/** Репозиторий проекта карточки — из того же файла, что читала Система
 *  (прежняя внешняя автоматика).
 *  (scripts/task-context-projects.json); не сопоставлен — репозиторий TaskFlow. */
function projectRepo(taskId: string): string {
  const fallback = path.resolve(process.cwd(), "..");
  try {
    const projectId = (db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as
      | { project_id?: string | null }
      | undefined)?.project_id;
    const map = JSON.parse(fs.readFileSync(PROJECTS_CONFIG, "utf8")).projects ?? {};
    const repo = projectId ? map[projectId] : undefined;
    return repo && fs.existsSync(repo) ? repo : fallback;
  } catch {
    return fallback;
  }
}

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
type ActiveInProcessRun = { runId: string; taskId: string; role: string; subtaskId?: string; abort: () => Promise<void>; steer: (text:string)=>Promise<void>; lastActivityAt: number ; /** Сколько раз роль проявила активность (вызовы инструментов): отличает ход с работой от пустого. */ activityCount: number};
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
export async function deliverTopicToWork(taskId:string,role:string,messageId:string,text:string,slotKey?:string):Promise<"queued"|"idle"|"busy"> {
  const runs=[...activeRuns.values()].filter(r=>r.taskId===taskId && r.role===role && (!slotKey || (r.subtaskId && !!db.prepare("SELECT 1 FROM subtasks WHERE id=? AND plan_node_key=?").get(r.subtaskId,slotKey))));
  if(runs.length>1) return "busy";
  if(runs.length===1){
    const target=runs[0].subtaskId;
    if(target){
      const seen=db.prepare("SELECT delivered_at FROM slot_topic_inbox WHERE message_id=? AND subtask_id=?").get(messageId,target) as {delivered_at:string|null}|undefined;
      if(seen?.delivered_at)return "queued";
      db.prepare("INSERT OR IGNORE INTO slot_topic_inbox(message_id,subtask_id) VALUES(?,?)").run(messageId,target);
    }
    await runs[0].steer(`${roleProjectSnapshot(role,(db.prepare("SELECT project_id FROM tasks WHERE id=?").get(taskId) as {project_id:string|null}|undefined)?.project_id ?? null,taskId)}\n\nСообщение темы задачи ${taskId}, id ${messageId}. Ответь автору через taskflow_topic_reply с message_id=${messageId}, если ответ нужен. Максимум 100 слов, при блоке 50. Укажи адресата, задачу и этап; задавай конкретный вопрос по специализации коллеги. Отчёты — в документах задачи, в сообщении только ссылка. Не меняй граф или критерии приёмки на основании переписки.\nДанные сообщения: ${JSON.stringify(text)}`);
    if(target)db.prepare("UPDATE slot_topic_inbox SET delivered_at=datetime('now') WHERE message_id=? AND subtask_id=?").run(messageId,target);
    logEvent({taskId,actorId:null,kind:"topic_message_queued",field:messageId,toValue:JSON.stringify({role,slotKey:slotKey??null,runId:runs[0].runId})});
    return "queued";
  }
  const starting=db.prepare("SELECT 1 FROM subtasks WHERE task_id=? AND agent_id=? AND agent_state='in_progress' AND done=0 AND (? IS NULL OR plan_node_key=?)").get(taskId,roleUserId(role),slotKey??null,slotKey??null);
  if(starting){
    const target=resolveTopicSlot(taskId,role,slotKey);
    if(target)db.prepare("INSERT OR IGNORE INTO slot_topic_inbox(message_id,subtask_id) VALUES(?,?)").run(messageId,target.id);
    return "busy";
  }
  return "idle";
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
  await Promise.all([...pending]);
}

/** Сколько ждём резюме роли при остановке хода. Остановка не должна зависать
 *  в ожидании модели (владелец 04.10.2026): не ответила — пишем техснимок. */
const STOP_SUMMARY_MS = Number(process.env.TASKFLOW_SLOT_STOP_SUMMARY_MS ?? 30_000);
const STOP_SUMMARY_ON = process.env.TASKFLOW_SLOT_STOP_SUMMARY !== "0";

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
export async function runRoleInProcess(input:Parameters<typeof runRoleInProcessUnserialized>[0]):Promise<{runId:string;completion:Promise<void>}> {
  if(!input.subtaskId)return runRoleInProcessUnserialized(input);
  const release=await acquireSlotSession(input.subtaskId);
  try {
    const result=await runRoleInProcessUnserialized(input);
    void result.completion.then(release,release);
    return result;
  } catch(error){release();throw error;}
}
async function runRoleInProcessUnserialized(input: {
  taskId: string;
  role: string;
  prompt?: string;
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
  /** Сколько раз ход уже переехал на запасную модель из-за лимита провайдера. */
  failoverDepth?: number;
}): Promise<{ runId: string; completion: Promise<void> }> {
  const { taskId, role } = input;
  if (!ROLE_NAMES.includes(role)) throw new Error(`роли «${role}» нет или она отключена`);
  if (activeInProcessRun(taskId, input.subtaskId)) throw new Error("по этому окну агент уже работает");

  const routing = loadRoleRouting();
  // MAK-77: модель может быть записана как «провайдер/модель» (opencode-go/qwen3.8-flash);
  // запись без префикса работает по-старому.
  const modelRef = pickStartModel(routing, role, input.model);
  const { provider: modelProvider, id: modelId } = parseModelRef(modelRef);
  const runtime: any = await getModelRuntime();
  const model =
    runtime.getModel?.(modelProvider, modelId) ??
    ((await runtime.getAvailable?.()) ?? []).find((m: any) => m.id === modelId);
  if (!model) throw new Error(`модель «${modelRef}» недоступна`);
  try {
    recordAttemptModel({ taskId, subtaskId: input.subtaskId, modelId, provider: modelProvider });
  } catch (error) {
    console.warn("[attemptModel] не записалась:", error);
  }


  // Репозиторий самого сервера — только в отдельной копии: сохранение файла
  // в живой перезапустило бы сервер вместе с этим ходом (roleWorkspace.ts).
  let cwd = input.cwd ?? roleWorkspace(taskId, projectRepo(taskId));
  const mode = input.mode ?? (role === "critic_verifier" ? "review" : "work");
  const resumed = hasSession(taskId, role, input.subtaskId);
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
  if (mode === "work" && !resumed) {
    try {
      await asRole(role, "POST", `/api/tasks/${taskId}/comments`, { text: launchContext.summary });
    } catch (error) {
      console.warn(`контекст для ${taskId} собран, но сводка не записана:`, error);
    }
  }
  fs.mkdirSync(sessionDir(taskId, role, input.subtaskId), { recursive: true });
  const manager=input.subtaskId ? openSlotSession(taskId,role,input.subtaskId,cwd) : SessionManager.continueRecent(cwd,sessionDir(taskId,role));
  cwd=manager.getCwd();
  const systemPrompt = [
    composeLayer(role, "role.prompt")?.effective
      || rolePrompt(role)
      || `Ты — ${roleTitle(role)} в трекере TaskFlow.`,
    composeLayer(role, "local_policy")?.effective ?? LOCAL_EXECUTION_POLICY,
  ].join("\n\n");
  const resourceLoader = await createTaskResourceLoader(role, cwd, systemPrompt);

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

  const composio = await connectRoleComposio(role, mode, input.subtaskId ?? taskId);
  if(db.prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id=? AND status='approved'").get(taskId)) ensurePlanTopic(taskId);
  const xcode = await connectBuilderXcode(role, mode).catch(async error => { resourceLoader.disposeResources(); await composio.close(); throw error; });
  const customTools = [...taskflowTools(role, model.id ?? modelId, taskId,input.subtaskId), ...composio.tools, ...xcode.tools];
  const builtinTools = [...new Map([...createCodingTools(cwd),...createReadOnlyTools(cwd)].map(t=>[t.name,t])).values()].filter(t=>BUILTIN_TOOLS.includes(t.name)).map(t=>({...t,description:composeLayer(role,"tool.builtin."+t.name)?.effective ?? t.description}));
  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: "off",
    modelRuntime: runtime,
    resourceLoader,
    // `tools` у SDK — список ИМЁН. Раньше сюда шли объекты, и роль на задаче
    // оставалась без единого инструмента (владелец 02.10.2026). Встроенные с
    // описаниями владельца — через customTools: одноимённый перекрывает.
    tools: [...builtinTools.map(t=>t.name), ...customTools.map((t: any)=>t.name)],
    customTools: [...builtinTools, ...customTools],
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
  } as any).catch(async error => { resourceLoader.disposeResources(); await composio.close(); await xcode.close(); throw error; });

  const runId = `inproc_${crypto.randomUUID()}`;
  db.prepare("UPDATE tasks SET composed_prompt_snapshot=? WHERE id=?").run((session as any).systemPrompt ?? systemPrompt, taskId);
  logEvent({taskId,actorId:roleUserId(role),kind:"instruction_snapshot",field:runId,toValue:JSON.stringify({mode: input.subtaskId ? "subtask" : mode, resumed, manifest:instructionManifest(role,input.subtaskId ? "subtask" : (resumed ? "resume" : mode === "work" ? "work" : mode))})});
  const before = progressMark(taskId);
  activeRuns.set(runId, { runId, taskId, role, subtaskId: input.subtaskId, abort: () => session.abort(), steer: (text:string) => session.steer(text), lastActivityAt: Date.now(), activityCount: 0 });

  // Действия встроенных инструментов — строкой в карточке, как раньше делало
  // расширение Pi taskflow-activity.ts.
  const KIND: Record<string, string> = {
    read: "read", grep: "search", find: "search", ls: "read", edit: "edit", write: "write", bash: "run",
  };
  session.subscribe((event: any) => {
    if (event?.type !== "tool_execution_start") return;
    const kind=KIND[event.toolName] ?? (event.toolName?.startsWith("mcp__xcode__") ? (event.toolName.includes("write") ? "write" : event.toolName.includes("read") ? "read" : event.toolName.includes("test") ? "test" : "run") : undefined);
    if(!kind) return;
    const a = event.args ?? {};
    const target = String(a.path ?? a.file_path ?? a.command ?? a.pattern ?? event.toolName).slice(0, 200);
    void activity(role, taskId, kind, target);
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
  const work = (async () => {
    try {
      const task = input.prompt ?? (input.subtaskId
        ? planSubtaskPrompt(taskId, role, input.subtaskId)
        : (resumed ? resumePrompt(taskId, role) : defaultTaskPrompt(taskId, role)));
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
      const messages=queued.map(m=>`Сообщение темы задачи ${taskId}, id ${m.id}. Ответь через taskflow_topic_reply(message_id=${m.id}). Данные: ${JSON.stringify(m.text)}`).join("\n");
      // Снимок предыдущей попытки этого слота (владелец 04.10.2026): ход роли
      // умирает вместе с процессом, и без снимка следующий вызов начинает с
      // нуля. Ставим после задания этапа и ДО контекста запуска, чтобы роль
      // читала его как часть постановки, а не как приложение.
      const snapshot=input.subtaskId ? slotSnapshotBlock(input.subtaskId) : null;
      const prompt = `${task}\n\n${messages}\n\nПереписка: до 100 слов, сообщение о блоке до 50. Адресат, задача, конкретный этап и вопрос по специализации коллеги. В ответе укажи адресата и reply_to_message_id. Полные отчёты сохраняй через taskflow_doc_write в папке задачи, в чат и комментарии дай короткую суть и ссылку.${snapshot ? `\n\n${snapshot}` : ""}\n\n${launchContext.prompt}\n\n${topicContext(taskId)}${memory ? `\n\n${memory}` : ""}`;
      for(const m of queued)db.prepare("UPDATE slot_topic_inbox SET delivered_at=datetime('now') WHERE message_id=? AND subtask_id=?").run(m.id,input.subtaskId);
      await session.prompt(mode === "work" ? `${prompt}\n\n${repoNote(cwd)}\n${renderInstruction(role, "task.documentation", {})}` : prompt);
      // Лимит провайдера библиотека не бросает: ход молча кончается ответом с ошибкой 429
      // (находка А36). Ловим здесь и уходим на запасную модель.
      limitHit = lastAssistantLimitError(session);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isProviderLimitText(reason)) limitHit = reason;
      else runFailure = error instanceof Error ? error : new Error(reason);
      if (!limitHit) try {
        await asRole(role, "POST", `/api/tasks/${taskId}/state`, {
          state: "blocked",
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
      session.dispose();
      resourceLoader.disposeResources();
      await composio.close().catch(() => {});
      await xcode.close().catch(() => {});
      // Шаг плана закончил ход без сдачи: сервер сам продолжает его при прогрессе
      // (до 3 раз) или видимо блокирует. Раньше такой шаг молча оставался
      // «в работе» без запуска (находка А30, 06.10.2026).
      if (input.subtaskId && mode === "work" && !limitHit) {
        try {
          const { settleStalledPlanNode } = await import("./planSubtaskAdmission.js");
          await settleStalledPlanNode({
            subtaskId: input.subtaskId,
            madeProgress: runActivity >= STALLED_NODE_MIN_ACTIVITY,
            failure: runFailure ? (runFailure as Error).message : null,
          });
        } catch (error) {
          console.warn("[plan] продолжение/блокировка шага не удалась:", error);
        }
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
    if (limitHit) scheduleProviderFailover();
    if (runFailure) throw runFailure;
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
          settleStalledPlanNode({ subtaskId: input.subtaskId!, madeProgress: false, failure: `лимит провайдера, запасных моделей нет: ${reason.slice(0, 100)}` }),
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
          await runRoleInProcess({ ...input, model: next, failoverDepth: depth + 1 });
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
  // В тестах живых агентов не зовём — только там, где тест это разрешил явно.
  if (process.env.VITEST && process.env.TASKFLOW_KICK_IN_TESTS !== "1") {
    return {
      outcome: "deferred",
      reason: "role runs are disabled in tests",
      delaySeconds: 30,
    };
  }
  const { unitState } = await import("../routes/agent-service.js");
  const explicitOwnerStart = options?.manualStart === true && reason === "assigned" && Boolean(actorId && isOwner(actorId));
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
        prompt: `${reviewPromptFor(taskId)}\n\n${planReviewRouteContext(taskId)}\n\nДля доработки плана передай rework_steps: slot_key первого дефектного рабочего этапа. Несколько slot_key разрешены только для независимых параллельных веток. Сервер повторит затронутую цепочку и итоговую проверку.`,
        mode: "review",
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
