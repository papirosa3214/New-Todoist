import {chatExecutionMode,type ChatExecutionMode} from "./chatExecutionMode.js";
import {roleHostAccessTools} from "./roleHostAccess.js";
import {createHostRoleTools} from "./hostRoleTools.js";
import {taskflowTools} from "./inProcessRun.js";
import {roleToolAllowed} from "../lib/roleToolScope.js";
import {roleUserId} from "../roleRouting.js";
import {createUniversalTaskflow,operationRestriction,UNIVERSAL_INSTRUCTION,type Tool,type Context} from "./universalTaskflow.js";
import {toolRequestStore} from "./toolRequestStore.js";
import {recordToolAudit} from "./toolAuditStore.js";
import {Check,Errors} from "typebox/value";
import {MISTAKE_LIMIT,stopRoleOnErrorLoop} from "./errorLoopStop.js";
import {createToolLoader,TOOL_LOADER_NAME} from "./nativeToolLoader.js";
export {UNIVERSAL_INSTRUCTION};
export const ROLE_TOOL_INSTRUCTION = "Инструменты доступны отдельными именами с точными JSON Schema. Вызывай нужный инструмент напрямую: параметры передавай ровно по его схеме, без обёртки operation/arguments и без предварительного discover/describe. Не выдумывай поля, имена инструментов и значения-заглушки. Проверка прав, контекста и аргументов выполняется до действия. Если вызов отклонён, прочитай ошибку и исправь указанный параметр; не повторяй прежний неверный вызов. После трёх одинаковых неверных вызовов ход останавливается. Старый taskflow в истории — прежний способ вызова тех же операций; в новом ходе используй показанные нативные инструменты. Нужного инструмента может не быть в списке: тогда вызови taskflow_tools — он покажет индекс операций и подключит нужные; права при этом не расширяются. Возможность не означает разрешение: соблюдай режим чата/карточки и явное поручение владельца.";
/** Ядро: операции, без которых ход не начинается (сориентироваться, взять
 * слот) и не закрывается (план, комментарий, сдача шага). Отбор — по частоте
 * за 14 дней (role_tool_audit) и по обязательности шага. Остальное подключает
 * загрузчик по требованию: весь каталог в каждый запрос не уходит. */
const CORE_OPERATIONS = new Set([
  "taskflow_task", "taskflow_task_summary",
  "taskflow_work_plan", "taskflow_work_item_submit", "taskflow_plan_read", "taskflow_plan_ops", "taskflow_plan_request",
  "taskflow_subtask_work", "taskflow_subtask_done", "taskflow_subtask_add",
  "taskflow_state", "taskflow_heartbeat", "taskflow_claim", "taskflow_slot_status", "taskflow_slot_snapshot",
  "taskflow_comment", "taskflow_topic_send", "taskflow_topic_read",
  "taskflow_chat_send", "taskflow_chat_read",
  "taskflow_doc_read", "taskflow_docs", "taskflow_kb_search", "taskflow_recall",
  "taskflow_status", "taskflow_agents", "taskflow_rules",
  "taskflow_review", "taskflow_tool_request", "taskflow_work_start",
]);

export type CatalogContext={role:string;model?:string|null;mode:string;runId:string;taskId?:string;subtaskId?:string;chatId?:string;messageId?:string;executionMode?:ChatExecutionMode};
export function buildRoleToolCatalog(input:CatalogContext,adapters:Tool[]=[]){
 const context:Context={...input,executionMode:input.taskId ? "card" : input.executionMode ?? (input.chatId ? chatExecutionMode(input.chatId,input.messageId) : undefined),actor:roleUserId(input.role),authorize:(name)=>
  roleToolAllowed(input.role,name) && (!input.subtaskId || name!=="taskflow_claim") &&
  (input.role!=="critic_verifier" || name!=="taskflow_subtask_done")};
 const taskflowOperations=taskflowTools(input.role,input.model??null,input.taskId,input.subtaskId,true,{chatId:input.chatId??"",messageId:input.messageId??""});
 const adapterNames=new Set(adapters.map(tool=>tool.name));
 const hostTools=createHostRoleTools(input.role,input.taskId,input.subtaskId);
 const operations=[...taskflowOperations.filter(tool=>!adapterNames.has(tool.name)),...roleHostAccessTools(input),...hostTools,...adapters];
 const universal=createUniversalTaskflow(operations,context,toolRequestStore);
 const handledCalls=new Set<string>();
 const sdkMistakes=new Map<string,number>();
 // Native schema and name are visible; execution still goes through the existing
 // authorization, argument validation, idempotency and audit path.
 const aliases=operations.filter(t=>!operationRestriction(t.name,context)).map(tool=>({...tool,execute:async(id:string,args:any,signal?:AbortSignal,onUpdate?:any)=>{
  handledCalls.add(id);
  const output=await universal.execute(id,{action:"invoke",operation:tool.name,version:1,arguments:args,request_id:input.runId+":"+id},signal,onUpdate);
  const envelope=JSON.parse(output.content[0].text);
  if(!envelope.ok)throw new Error(JSON.stringify({ok:false,operation:tool.name,request_id:envelope.request_id,error:envelope.error}));
  sdkMistakes.delete(tool.name);
  if(!envelope.data?.content)throw new Error("Запрос уже выполняется; проверь requests.status");
  return {content:envelope.data.content,details:{operation:tool.name}};
 }}));
 const nativeByName=new Map(aliases.map(tool=>[tool.name,tool]));
 // SDK validates native schemas before execute(). Such refusals must not vanish
 // from counters or evade the existing three-mistake stop policy.
 const onToolExecutionEnd=(event:any):boolean=>{
  if(event.type!=="tool_execution_end")return false;
  if(handledCalls.delete(event.toolCallId))return false;
  const tool=nativeByName.get(event.toolName);
  if(!tool || !event.isError)return false;
  const invalid=!Check(tool.parameters,event.args);
  const issue=invalid ? [...Errors(tool.parameters,event.args)][0] : undefined;
  const missing=(issue?.params as any)?.requiredProperties?.[0];
  const field=issue ? (issue.instancePath || "") + (missing ? "/"+missing : "") : undefined;
  const expected=(issue?.params as any)?.type ?? (missing ? tool.parameters.properties?.[missing]?.type : undefined) ?? issue?.keyword;
  const reason="SDK отклонил вызов до выполнения";
  recordToolAudit({...context,action:"invoke",tool:tool.name,operation:tool.name,outcome:"error",errorCode:invalid?"INVALID_ARGUMENTS":"OPERATION_FAILED",errorMessage:reason,errorField:field,errorExpected:expected});
  if(!invalid)return false;
  const attempts=(sdkMistakes.get(tool.name)??0)+1;
  sdkMistakes.set(tool.name,attempts);
  if(attempts<MISTAKE_LIMIT)return false;
  void stopRoleOnErrorLoop({taskId:input.taskId,subtaskId:input.subtaskId,role:input.role,operation:tool.name,attempts,reason}).catch(error=>console.warn("[native-tools] error-loop stop failed:",error));
  return true;
 };
 const loader=createToolLoader({operations:aliases});
 const core=aliases.filter(tool=>CORE_OPERATIONS.has(tool.name));
 // Активно ядро и загрузчик: остальные операции ждут подключения по требованию.
 // Реестр сессии при этом полный — подключать можно всё, что роль имеет право.
 const activeNames=[...core.map(tool=>tool.name),loader.tool.name];
 return {activeNames,registeredNames:[...aliases.map(tool=>tool.name),loader.tool.name],customTools:[universal,...aliases,loader.tool],operations,context,onToolExecutionEnd,
  attachSession:(session:any)=>loader.attach(session)};
}

/** Pi's non-strict Anthropic converter drops root JSON Schema constraints.
 * Restore the source schema without claiming provider-side strict sampling. */
export function restoreNativeToolSchemas(payload:any, tools:Tool[]):any {
 const schemas=new Map(tools.map(tool=>[tool.name,tool.parameters]));
 for(const wire of payload?.tools??[]){
  const schema=schemas.get(wire.name);
  // Strict Claude schemas have already been normalized by its SDK; leave them.
  if(schema && wire.strict!==true)wire.input_schema=JSON.parse(JSON.stringify(schema));
 }
 return payload;
}

/** Сузить активный набор сессии до ядра операций: в запрос уходит ядро, остальное
 * подключает загрузчик по требованию. keepNames — встроенные инструменты, которые
 * остаются активными (файлы, поиск). Внешняя CLI-сессия своего набора не имеет. */
export function installNativeToolCore(session:any,catalog:ReturnType<typeof buildRoleToolCatalog>,keepNames:string[]=[]):void {
 if(typeof session?.setActiveToolsByName!=="function")return;
 session.setActiveToolsByName([...keepNames,...catalog.activeNames]);
 catalog.attachSession(session);
}

export function installNativeToolSchemas(session:any,catalog:ReturnType<typeof buildRoleToolCatalog>):void {
 if(!session?.agent)return; // External CLI runtime owns its own transport.
 const previous=session.agent.onPayload;
 session.agent.onPayload=async(payload:any,model:any)=>{
  const next=(await previous?.(payload,model))??payload;
  return model?.api==="anthropic-messages" ? restoreNativeToolSchemas(next,catalog.customTools) : next;
 };
 session.subscribe((event:any)=>{
  if(catalog.onToolExecutionEnd(event))void session.abort();
 });
}
