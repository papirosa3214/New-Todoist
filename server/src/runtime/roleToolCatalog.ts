import {chatExecutionMode,type ChatExecutionMode} from "./chatExecutionMode.js";
import {roleHostAccessTools} from "./roleHostAccess.js";
import {createHostRoleTools} from "./hostRoleTools.js";
import {isServerRefusal} from "./serverRefusal.js";
import {Check,Errors} from "typebox/value";
import {createHash} from "node:crypto";
import {taskflowTools} from "./inProcessRun.js";
import {roleToolAllowed} from "../lib/roleToolScope.js";
import {roleUserId} from "../roleRouting.js";
import {createUniversalTaskflow,isReadOperation,operationRestriction,UNIVERSAL_INSTRUCTION,type Tool,type Context} from "./universalTaskflow.js";
import {toolRequestStore} from "./toolRequestStore.js";
import {recordToolAudit} from "./toolAuditStore.js";
import {MISTAKE_LIMIT,stopRoleOnErrorLoop} from "./errorLoopStop.js";
import {createToolLoader,onDemandScopeKey,onDemandTools,rememberOnDemandTool,TOOL_LOADER_NAME} from "./nativeToolLoader.js";
import {createRoleSubagentCallTool,isSubagentRun,resetSubagentCallCounters,ROLE_SUBAGENT_CALL_TOOL} from "./roleSubagentCall.js";
export {UNIVERSAL_INSTRUCTION};
export const ROLE_TOOL_INSTRUCTION = "Инструменты доступны отдельными именами с точными JSON Schema. Вызывай нужный инструмент напрямую: параметры передавай ровно по его схеме, без обёртки operation/arguments и без предварительного discover/describe. Не выдумывай поля, имена инструментов и значения-заглушки. Проверка прав, контекста и аргументов выполняется до действия. Если вызов отклонён, прочитай ошибку и исправь указанный параметр; не повторяй прежний неверный вызов. После трёх одинаковых неверных вызовов ход останавливается. Старый taskflow в истории — прежний способ вызова тех же операций; в новом ходе используй показанные нативные инструменты. Нужного инструмента может не быть в списке: тогда вызови taskflow_tools — он покажет индекс операций и подключит нужные; права при этом не расширяются. Возможность не означает разрешение: соблюдай режим чата/карточки и явное поручение владельца.";
/** Ядро: операции, без которых ход не начинается (сориентироваться, взять
 * слот) и не закрывается (план, комментарий, сдача шага). Отбор — по частоте
 * за 14 дней (role_tool_audit) и по обязательности шага. Остальное подключает
 * загрузчик по требованию: весь каталог в каждый запрос не уходит. */
const CORE_OPERATIONS = new Set([
  "taskflow_routines", "taskflow_routine_read",
  "taskflow_task", "taskflow_task_summary",
  "taskflow_work_plan", "taskflow_work_item_submit", "taskflow_plan_read", "taskflow_plan_ops", "taskflow_plan_request",
  "taskflow_subtask_work", "taskflow_subtask_done", "taskflow_subtask_add",
  "taskflow_state", "taskflow_heartbeat", "taskflow_claim", "taskflow_slot_status", "taskflow_slot_snapshot",
  "taskflow_comment", "taskflow_topic_send", "taskflow_topic_read",
  "taskflow_chat_send", "taskflow_chat_read",
  "taskflow_doc_read", "taskflow_docs", "taskflow_kb_search", "taskflow_recall",
  "taskflow_status", "taskflow_agents", "taskflow_rules",
  "taskflow_review", "taskflow_tool_request", "taskflow_work_start",
  "taskflow_ask_user_question",
  // Вызов роли как субагента: активен только у ролей с правом (Помощник,
  // Оркестратор) — у остальных операции нет вовсе, поэтому в ядре она
  // безвредна.
  "taskflow_call_role",
]);

/** Текст отказа Pi: args в событие tool_execution_end не кладутся, причина
 *  живёт в тексте результата («Tool X not found», «- /command: Expected string»). */
function toolResultText(result:any):string{
 return (Array.isArray(result?.content)?result.content:[])
  .map((part:any)=>typeof part?.text==="string"?part.text:"")
  .join("\n");
}

/** Ошибка схемы приходит текстом: «  - /command: Expected string, received undefined».
 *  Поле и ожидаемый тип берём оттуда — args в событии нет. */
function parseSchemaIssue(text:string):{field?:string;expected?:string}|undefined{
 const match=/^\s*-\s*([^\s:][^:]*):\s*Expected\s+([a-zA-Z]+)/m.exec(text);
 if(!match)return undefined;
 const field=match[1].trim().replace(/^\//,"").split("/").filter(Boolean).join(".");
 return {field:field||undefined,expected:match[2]};
}

export type CatalogContext={onErrorLoop?:()=>void;role:string;model?:string|null;mode:string;runId:string;taskId?:string;subtaskId?:string;chatId?:string;messageId?:string;executionMode?:ChatExecutionMode};
export function buildRoleToolCatalog(input:CatalogContext,adapters:Tool[]=[]){
 const context:Context={...input,executionMode:input.taskId ? "card" : input.executionMode ?? (input.chatId ? chatExecutionMode(input.chatId,input.messageId) : undefined),actor:roleUserId(input.role),authorize:(name)=>
  roleToolAllowed(input.role,name) && (!input.subtaskId || name!=="taskflow_claim") &&
  (input.role!=="critic_verifier" || name!=="taskflow_subtask_done")};
 const taskflowOperations=taskflowTools(input.role,input.model??null,input.taskId,input.subtaskId,true,{chatId:input.chatId??"",messageId:input.messageId??""});
 const adapterNames=new Set(adapters.map(tool=>tool.name));
 const hostTools=createHostRoleTools(input.role,input.taskId,input.subtaskId);
 // Вызов роли как субагента: только Помощник и Оркестратор (правило доступа
 // в roleToolScope). В каталоге СУБАГЕНТА инструмента нет — иначе роли
 // вызывают друг друга цепочкой (роль → роль → роль).
 const subagentCallTools = !isSubagentRun() && roleToolAllowed(input.role,ROLE_SUBAGENT_CALL_TOOL)
  ? [createRoleSubagentCallTool(context)] : [];
 // Новый ход роли — счётчик вызовов субагента сбрасывается: лимит «3 за ход».
 if(subagentCallTools.length)resetSubagentCallCounters(input.role,input.chatId??"");
 const operations=[...taskflowOperations.filter(tool=>!adapterNames.has(tool.name)),...roleHostAccessTools(input),...hostTools,...subagentCallTools,...adapters];
 const universal=createUniversalTaskflow(operations,context,toolRequestStore);
 const handledCalls=new Set<string>();
 const sdkMistakes=new Map<string,number>();
 // Ключ памяти подключённых по требованию операций: роль + чат/задача.
 const scope=onDemandScopeKey(input);
 // Нативный инструмент исполняется напрямую (владелец 27.10.2026): Pi
 // рассчитан на обычные инструменты, а прогон через общий шлюз (конверт,
 // request_id, тренер ошибок) совпал по времени с ростом сбоев шагов.
 // Права проверяются и здесь, каждый вызов пишется в журнал аудита.
 const requestScope=JSON.stringify({taskId:context.taskId??null,subtaskId:context.subtaskId??null,chatId:context.chatId??null});
 const aliases=operations.filter(t=>!operationRestriction(t.name,context)).map(tool=>({...tool,execute:async(id:string,args:any,signal?:AbortSignal,onUpdate?:any)=>{
  handledCalls.add(id);
  const audit=(outcome:"ok"|"error",errorCode?:string,errorMessage?:string)=>recordToolAudit({...context,action:"invoke",tool:tool.name,operation:tool.name,outcome,errorCode,errorMessage});
  const restriction=operationRestriction(tool.name,context);
  if(restriction){audit("error",restriction.code,restriction.message);throw new Error(restriction.message);}
  // request_id — служебное поле прежнего шлюза, в схему операции не входит.
  const {request_id:_requestId,...own}=(args??{}) as Record<string,unknown>;
  // Страховка на случай вызова в обход проверки SDK: неверные аргументы не доходят до записи.
  if(!Check(tool.parameters,own)){
   const issues=[...Errors(tool.parameters,own)].slice(0,3).map((e:any)=>`${e.instancePath||e.path||"/"}: ${e.message}`).join("; ");
   audit("error","INVALID_ARGUMENTS",issues);
   throw new Error(`INVALID_ARGUMENTS: ${issues}. Операция не выполнялась. hint: исправь эти поля по схеме инструмента и повтори вызов.`);
  }
  // Повтор записи с тем же request_id отдаёт прежний результат, а не делает
  // действие второй раз (дубли задач, повторный запуск рутины).
  // Ключ — явный request_id или номер хода и вызова, как было в шлюзе.
  const requestId=typeof _requestId==="string"&&_requestId.trim()?_requestId:input.runId+":"+id;
  const write=!isReadOperation(tool.name);
  const hash=write?createHash("sha256").update(JSON.stringify([tool.name,own])).digest("hex"):"";
  if(write){
   const prior=toolRequestStore.get(context.actor,requestId);
   if(prior){
    if(prior.scope!==requestScope||prior.hash!==hash)throw new Error("Этот request_id уже использован для другого действия — для нового действия нужен новый request_id.");
    if(prior.result)return prior.result;
    throw new Error("Запрос с этим request_id уже выполняется или его исход неизвестен — не повторяй, проверь результат.");
   }
   toolRequestStore.begin({actor:context.actor,id:requestId,scope:requestScope,hash,operation:tool.name,state:"running"});
  }
  try{
   const result=await tool.execute(id,own,signal,onUpdate);
   if(result?.isError)throw new Error((result.content??[]).map((c:any)=>c?.text??"").join("\n")||"Операция вернула ошибку");
   audit("ok");
   sdkMistakes.delete(tool.name);
   const out={content:result?.content??[],details:{operation:tool.name}};
   if(write)toolRequestStore.finish(context.actor,requestId!,"succeeded",out);
   return out;
  }catch(error){
   if(write)try{toolRequestStore.finish(context.actor,requestId!,"unknown_outcome",null);}catch{}
   const status=(error as {status?:number}).status;
   const rejected=(error as Error)?.name==="ToolError"&&(status===undefined||status<500);
   audit("error",rejected?"REJECTED":"OPERATION_FAILED",String((error as Error)?.message??error).slice(0,500));
   throw error;
  }
 }}));
 const nativeByName=new Map(aliases.map(tool=>[tool.name,tool]));
 const loader=createToolLoader({operations:aliases});
 // SDK validates native schemas before execute(). Such refusals must not vanish
 // from counters or evade the existing three-mistake stop policy.
 const onToolExecutionEnd=(event:any):boolean=>{
  if(event.type!=="tool_execution_end")return false;
  if(handledCalls.delete(event.toolCallId))return false;
  if(!event.isError)return false;
  // Pi не кладёт args в событие — причина отказа живёт в тексте результата.
  const text=toolResultText(event.result);
  const tool=nativeByName.get(event.toolName);
  // Операция не подключена к сессии: это не неверные аргументы. Подключаем её
  // сами (только из реестра роли — права не расширяются) и НЕ считаем это
  // неверным вызовом: три таких отказа роняли ход роли.
  if(/not found/i.test(text)){
   recordToolAudit({...context,action:"invoke",tool:event.toolName,operation:event.toolName,outcome:"error",errorCode:"TOOL_NOT_CONNECTED",errorMessage:"Операция не подключена к сессии — подключается автоматически"});
   if(tool){rememberOnDemandTool(scope,event.toolName);loader.activate([event.toolName]);}
   return false;
  }
  if(!tool)return false;
  // Отказ самого сервера — вызов верный, ошибкой роли не считается.
  if(isServerRefusal(text))return false;
  const issue=parseSchemaIssue(text);
  const reason="SDK отклонил вызов до выполнения";
  recordToolAudit({...context,action:"invoke",tool:tool.name,operation:tool.name,outcome:"error",errorCode:"INVALID_ARGUMENTS",errorMessage:reason,errorField:issue?.field,errorExpected:issue?.expected});
  const attempts=(sdkMistakes.get(tool.name)??0)+1;
  sdkMistakes.set(tool.name,attempts);
  if(attempts<MISTAKE_LIMIT)return false;
  if(input.mode==="task_discussion"){
   input.onErrorLoop?.();
   return true;
  }
  void stopRoleOnErrorLoop({taskId:input.taskId,subtaskId:input.subtaskId,role:input.role,operation:tool.name,attempts,reason}).catch(error=>console.warn("[native-tools] error-loop stop failed:",error));
  return true;
 };
 const core=aliases.filter(tool=>CORE_OPERATIONS.has(tool.name));
 // Активно ядро и загрузчик: остальные операции ждут подключения по требованию.
 // Реестр сессии при этом полный — подключать можно всё, что роль имеет право.
 const activeNames=[...core.map(tool=>tool.name),loader.tool.name];
 return {activeNames,registeredNames:[...aliases.map(tool=>tool.name),loader.tool.name],customTools:[universal,...aliases,loader.tool],operations,context,scope,loader,onToolExecutionEnd,
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
 // Операции, подключённые по требованию в прошлом ходе, снова активны: ход роли
 // создаёт новую сессию Pi, и без этой памяти набор сужался обратно до ядра.
 session.setActiveToolsByName([...keepNames,...catalog.activeNames,...onDemandTools(catalog.scope)]);
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
