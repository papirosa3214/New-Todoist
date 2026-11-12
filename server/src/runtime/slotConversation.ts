import {registerProviderSession, observeProviderRetries} from "./providerDiagnostics.js";
import { roleInstructionText } from "./roleHome.js";
import {connectRoleMcp} from "./graftMcp.js";
import { buildRoleToolCatalog, installNativeToolCore, installNativeToolSchemas, roleToolInstruction } from "./roleToolCatalog.js";
import { secretaryThings3Tools } from "./secretaryThings3Tools.js";
import crypto from "node:crypto";
import { createAgentSession,createCodingTools,createReadOnlyTools,SettingsManager } from "@earendil-works/pi-coding-agent";
import { acquireDiscussionSession,acquireSlotSession,openDiscussionSession,openSlotSession,rememberSlotSession,resolveTopicSlot,topicSlots } from "./slotSession.js";
import { TASK_CHAT_FILE_TOOLS,TASK_CHAT_MODE,isTaskChatRestrictedRole } from "./taskChatTools.js";
import { deliverTopicToWork,slotWorkspace } from "./inProcessRun.js";
import { getModelRuntime, resolveThinkingLevel } from "./PiRuntimeAdapter.js";
import { createTaskResourceLoader } from "./instructionResources.js";
import { composeLayer } from "../lib/roleContextResolver.js";
import { loadRoleRouting,roleTitle,roleUserId } from "../roleRouting.js";
import { findRuntimeModel } from "../lib/attemptModel.js";
import db from "../db.js";

type ConversationInput={taskId:string;subtaskId:string;role:string;chatId:string;messageId:string;prompt:string;onEvent?:(event:unknown)=>void;onStep?:(tool:string)=>void};
const active=new Map<string,{chatId:string;roleId:string;abort:()=>Promise<void>}>();
// Помощник владельца остаётся на прежнем пути: его дела нужны в любом разговоре.
const isScoped=isTaskChatRestrictedRole;
export const conversationMode=(role:string)=>isScoped(role) ? TASK_CHAT_MODE : "discussion";
const SLOT_CHAT_SESSION="chat";
export function slotConversationTools(role:string,model:string,taskId:string,subtaskId:string){
  return buildRoleToolCatalog({role,model,taskId,subtaskId,mode:conversationMode(role),runId:"discussion"}).customTools;
}
export async function cancelSlotConversationsFor(chatId:string,roleId?:string):Promise<number>{
  const runs=[...active.values()].filter(run=>run.chatId===chatId && (!roleId || run.roleId===roleId));
  await Promise.all(runs.map(run=>run.abort()));return runs.length;
}
/** Saved stage history supplements the common role/project context; no automatic admission or handoff. */
export async function startSlotConversation(input:ConversationInput):Promise<{sessionId:string|null;text:string;forwarded?:boolean}> {
  let release=()=>{};
  const controller=new AbortController();
  let cancelled=false;
  let infra:{tools:any[];close:()=>Promise<any>}|undefined;
  let resources:Awaited<ReturnType<typeof createTaskResourceLoader>>|undefined;
  let session:any;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const runId="slotchat_"+crypto.randomUUID();
  active.set(runId,{chatId:input.chatId,roleId:roleUserId(input.role),abort:async()=>{
    cancelled=true;
    controller.abort(Object.assign(new Error("Обсуждение остановлено"),{code:"CHAT_RUN_CANCELLED"}));
    await session?.abort();
  }});
  try {
    const scoped=isScoped(input.role);
    // Своя сессия чата не трогает рабочий файл, поэтому и работу не держит.
    release=scoped ? await acquireDiscussionSession(`slotchat:${input.subtaskId}`,controller.signal) : await acquireSlotSession(input.subtaskId,controller.signal);
    const slot=resolveTopicSlot(input.taskId,input.role,undefined,input.subtaskId);
    if(!slot)throw new Error("Этап больше не относится к утверждённому плану");
    // Work could have acquired the writer while this turn was queued. Do not fork.
    const delivery=await deliverTopicToWork(input.taskId,input.role,input.messageId,input.prompt,slot.plan_node_key);
    if(delivery!=="idle")return {sessionId:null,text:"",forwarded:true};
    const modelId=loadRoleRouting().models[input.role];
    const runtime:any=await getModelRuntime();
    const model=await findRuntimeModel(runtime,modelId);
    if(!model)throw new Error(`модель «${modelId}» недоступна`);
    // Владелец 05.11.2026: выводы инструментов в разговор не лезут. Чату своя
    // короткая сессия, в рабочий файл слота он не заходит и ничего не дописывает.
    const manager=scoped ? openDiscussionSession(input.taskId,input.role,input.subtaskId,SLOT_CHAT_SESSION,slotWorkspace(input.taskId)) : openSlotSession(input.taskId,input.role,input.subtaskId,slotWorkspace(input.taskId));
    const cwd=manager.getCwd();
    const policy=roleToolInstruction()+"\n\n"+ (scoped ? "Сейчас чат задачи: ты отчитываешься владельцу по выжимке своей работы, рабочей истории здесь нет. Нужны подробности — читай файлы и документы задачи. Менять ничего нельзя: ни файлы, ни статусы, ни план. До 100 слов; блок до 50." : "Сейчас разговорный ход того же рабочего этапа. Отвечай с учётом сохранённой истории работы. Не возобновляй работу, не выполняй рабочие операции, не меняй файлы проекта, статусы, назначения, план и настройки. Доступны чтение, обсуждение, консультация и чтение документов. Для записи нужен рабочий ход. До 100 слов; блок до 50. Полный отчёт не повторяй, ссылайся на документы. Предыдущие рабочие команды истории в этом ходе не выполняй.");
    // AGENTS.md роли подключает сам загрузчик — сюда только общий шаблон.
    resources=await createTaskResourceLoader(input.role,cwd,[roleInstructionText(input.role,{withAgents:false}),policy].join("\n\n"));
    // Тот же полный набор, что в работе (владелец 07.11.2026).
    const builtin=[...new Map([...createCodingTools(cwd), ...createReadOnlyTools(cwd)].map((tool) => [tool.name, tool])).values()];
    infra=await connectRoleMcp(input.role,cwd).catch(()=>({tools:[],close:async()=>{}}));
    // Дела владельца нужны и в обсуждении: вопрос «что у меня в Things3» —
  // обычный разговорный вопрос, а не рабочая задача.
  const secretary=input.role==="secretary"?secretaryThings3Tools({role:input.role,taskId:input.taskId,subtaskId:input.subtaskId,chatId:input.chatId,messageId:input.messageId}):[];
  const catalog=buildRoleToolCatalog({role:input.role,model:model.id??modelId,taskId:input.taskId,subtaskId:input.subtaskId,chatId:input.chatId,messageId:input.messageId,mode:conversationMode(input.role),runId},[...infra.tools,...secretary]);
    const custom=catalog.customTools;
    registerProviderSession(manager.getSessionId(), {role:input.role, task_id:input.taskId, subtask_id:input.subtaskId, chat_id:input.chatId, run_id:runId, origin:"slot_conversation"});
    ({session}=await createAgentSession({cwd,model,thinkingLevel:resolveThinkingLevel(model as any, input.role) ?? undefined,modelRuntime:runtime,resourceLoader:resources,
      tools:[...builtin.map(tool=>tool.name),...catalog.registeredNames],customTools:[...builtin,...custom],sessionManager:manager,
      settingsManager:SettingsManager.inMemory({compaction:{enabled:true},retry:{enabled:true,maxRetries:2}})} as any));
    observeProviderRetries(session, manager.getSessionId());
    installNativeToolSchemas(session, catalog);
    // Активно только ядро операций: остальное подключает taskflow_tools по
    // требованию (setActiveToolsByName). Реестр сессии полный — подключать можно
    // всё, что роль имеет право вызывать.
    installNativeToolCore(session, catalog, builtin.map((t:any)=>t.name));

    const roleThinking = resolveThinkingLevel(model as any, input.role);
    if (roleThinking && session.thinkingLevel !== roleThinking && typeof session.setThinkingLevel === "function") {
      session.setThinkingLevel(roleThinking);
    }
    let timedOut=false;let lastAssistant:any;
    session.subscribe((event:any)=>{
      input.onEvent?.(event);
      if(event.type==="tool_execution_start")input.onStep?.(event.toolName);
      if(event.type==="agent_end" && Array.isArray(event.messages))lastAssistant=[...event.messages].reverse().find((m:any)=>m.role==="assistant");
    });
    timer=setTimeout(()=>{timedOut=true;void session.abort();},30*60*1000);timer.unref?.();
    await session.prompt(`${policy}\n\nЗадача: ${input.taskId}. Этап: ${slot.title} (${slot.plan_node_key}).\n\n${input.prompt}`);
    if(!scoped)rememberSlotSession(input.subtaskId,manager);
    if(cancelled)throw Object.assign(new Error("Обсуждение остановлено"),{code:"CHAT_RUN_CANCELLED"});
    if(timedOut)throw new Error("Время обсуждения истекло");
    const answer=lastAssistant ?? [...session.state.messages].reverse().find((m:any)=>m.role==="assistant");
    if(answer?.stopReason==="error")throw new Error(answer.errorMessage || "Не удалось получить ответ");
    const text=(answer?.content??[]).filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n").trim();
    db.prepare("INSERT INTO slot_topic_inbox(message_id,subtask_id,delivered_at) VALUES(?,?,datetime('now')) ON CONFLICT(message_id,subtask_id) DO UPDATE SET delivered_at=excluded.delivered_at").run(input.messageId,input.subtaskId);
    return {sessionId:manager.getSessionId(),text};
  } finally {
    if(timer)clearTimeout(timer);active.delete(runId);session?.dispose();resources?.disposeResources();await infra?.close().catch(()=>{});release();
  }
}
export {resolveTopicSlot,topicSlots};
