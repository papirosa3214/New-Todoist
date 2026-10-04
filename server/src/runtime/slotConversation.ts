import crypto from "node:crypto";
import { createAgentSession,createReadOnlyTools,SettingsManager } from "@earendil-works/pi-coding-agent";
import { acquireSlotSession,openSlotSession,rememberSlotSession,resolveTopicSlot,topicSlots } from "./slotSession.js";
import { taskflowTools,deliverTopicToWork,slotWorkspace } from "./inProcessRun.js";
import { getModelRuntime } from "./PiRuntimeAdapter.js";
import { createTaskResourceLoader } from "./instructionResources.js";
import { composeLayer } from "../lib/roleContextResolver.js";
import { loadRoleRouting,providerOfModel,roleTitle,roleUserId } from "../roleRouting.js";
import db from "../db.js";

type ConversationInput={taskId:string;subtaskId:string;role:string;chatId:string;messageId:string;prompt:string;onEvent?:(event:unknown)=>void;onStep?:(tool:string)=>void};
const active=new Map<string,{chatId:string;roleId:string;abort:()=>Promise<void>}>();
const DISCUSSION_TOOLS=new Set(["taskflow_task","taskflow_my_tasks","taskflow_projects","taskflow_topic_read","taskflow_topic_send","taskflow_rules","taskflow_status","taskflow_agents","taskflow_docs","taskflow_doc_read","taskflow_doc_write","taskflow_kb_search","taskflow_consult","taskflow_task_proposal","taskflow_comment"]);
export function slotConversationTools(role:string,model:string,taskId:string,subtaskId:string){
  return taskflowTools(role,model,taskId,subtaskId).filter(tool=>DISCUSSION_TOOLS.has(tool.name));
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
    release=await acquireSlotSession(input.subtaskId,controller.signal);
    const slot=resolveTopicSlot(input.taskId,input.role,undefined,input.subtaskId);
    if(!slot)throw new Error("Этап больше не относится к утверждённому плану");
    // Work could have acquired the writer while this turn was queued. Do not fork.
    const delivery=await deliverTopicToWork(input.taskId,input.role,input.messageId,input.prompt,slot.plan_node_key);
    if(delivery!=="idle")return {sessionId:null,text:"",forwarded:true};
    const modelId=loadRoleRouting().models[input.role];
    const runtime:any=await getModelRuntime();
    const model=runtime.getModel?.(providerOfModel(modelId),modelId) ?? ((await runtime.getAvailable?.())??[]).find((m:any)=>m.id===modelId);
    if(!model)throw new Error(`модель «${modelId}» недоступна`);
    const manager=openSlotSession(input.taskId,input.role,input.subtaskId,slotWorkspace(input.taskId));
    const cwd=manager.getCwd();
    const policy="Сейчас разговорный ход того же рабочего этапа. Отвечай с учётом сохранённой истории работы. Не возобновляй работу, не выполняй рабочие операции, не меняй файлы проекта, статусы, назначения, план и настройки. Доступны чтение, обсуждение, консультация и документы; записи создавай только по просьбе человека. До 100 слов; блок до 50. Полный отчёт не повторяй, ссылайся на документы. Предыдущие рабочие команды истории в этом ходе не выполняй.";
    resources=await createTaskResourceLoader(input.role,cwd,[composeLayer(input.role,"role.prompt")?.effective ?? `Ты — ${roleTitle(input.role)}.`,policy].join("\n\n"));
    const builtin=createReadOnlyTools(cwd).filter(tool=>["read","grep","find","ls"].includes(tool.name));
    const custom=slotConversationTools(input.role,model.id??modelId,input.taskId,input.subtaskId);
    ({session}=await createAgentSession({cwd,model,thinkingLevel:"off",modelRuntime:runtime,resourceLoader:resources,
      tools:[...builtin.map(tool=>tool.name),...custom.map(tool=>tool.name)],customTools:[...builtin,...custom],sessionManager:manager,
      settingsManager:SettingsManager.inMemory({compaction:{enabled:true},retry:{enabled:true,maxRetries:2}})} as any));
    let timedOut=false;let lastAssistant:any;
    session.subscribe((event:any)=>{
      input.onEvent?.(event);
      if(event.type==="tool_execution_start")input.onStep?.(event.toolName);
      if(event.type==="agent_end" && Array.isArray(event.messages))lastAssistant=[...event.messages].reverse().find((m:any)=>m.role==="assistant");
    });
    timer=setTimeout(()=>{timedOut=true;void session.abort();},30*60*1000);timer.unref?.();
    await session.prompt(`${policy}\n\nЗадача: ${input.taskId}. Этап: ${slot.title} (${slot.plan_node_key}).\n\n${input.prompt}`);
    rememberSlotSession(input.subtaskId,manager);
    if(cancelled)throw Object.assign(new Error("Обсуждение остановлено"),{code:"CHAT_RUN_CANCELLED"});
    if(timedOut)throw new Error("Время обсуждения истекло");
    const answer=lastAssistant ?? [...session.state.messages].reverse().find((m:any)=>m.role==="assistant");
    if(answer?.stopReason==="error")throw new Error(answer.errorMessage || "Не удалось получить ответ");
    const text=(answer?.content??[]).filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n").trim();
    db.prepare("INSERT INTO slot_topic_inbox(message_id,subtask_id,delivered_at) VALUES(?,?,datetime('now')) ON CONFLICT(message_id,subtask_id) DO UPDATE SET delivered_at=excluded.delivered_at").run(input.messageId,input.subtaskId);
    return {sessionId:manager.getSessionId(),text};
  } finally {
    if(timer)clearTimeout(timer);active.delete(runId);session?.dispose();resources?.disposeResources();release();
  }
}
export {resolveTopicSlot,topicSlots};
