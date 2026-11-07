import { registryTextOr } from "../lib/roleRules.js";
import {chatExecutionMode,type ChatExecutionMode} from "./chatExecutionMode.js";
import {roleHostAccessTools} from "./roleHostAccess.js";
import {createHostRoleTools} from "./hostRoleTools.js";
import {isToolNotInCatalogText,serviceRefusalCodeOf,TOOL_NOT_CONNECTED} from "./toolRefusalCodes.js";
import {Check,Errors} from "typebox/value";
import {Type} from "typebox";
import {createHash} from "node:crypto";
import {taskflowTools} from "./inProcessRun.js";
import {roleToolAllowed} from "../lib/roleToolScope.js";
import {scopeTaskChatOperations,TASK_CHAT_MODE} from "./taskChatTools.js";
import {roleUserId} from "../roleRouting.js";
import {createUniversalTaskflow,isReadOperation,operationRestriction,UNIVERSAL_INSTRUCTION,type Tool,type Context} from "./universalTaskflow.js";
import {toolRequestStore} from "./toolRequestStore.js";
import {recordToolAudit} from "./toolAuditStore.js";
import {MISTAKE_LIMIT,stopRoleOnErrorLoop} from "./errorLoopStop.js";
import {createToolLoader,onDemandScopeKey,onDemandTools,rememberOnDemandTool,TOOL_LOADER_NAME} from "./nativeToolLoader.js";
import {createRoleSubagentCallTool,createRoleSubagentSteerTool,isSubagentRun,resetSubagentCallCounters,ROLE_SUBAGENT_CALL_TOOL,ROLE_SUBAGENT_STEER_TOOL} from "./roleSubagentCall.js";
import {createSecretaryOpenBranchTool} from "./secretaryVoiceBranch.js";
export {UNIVERSAL_INSTRUCTION};
const ROLE_TOOL_INSTRUCTION_LITERAL = "Инструменты TaskFlow сгруппированы по объектам: taskflow_tasks, taskflow_step, taskflow_plans, taskflow_slot, taskflow_chats, taskflow_knowledge, taskflow_memory, taskflow_mail, taskflow_team. Вызов: {\"action\": \"<действие>\", \"args\": {поля действия}}; действия и их поля перечислены в описании группы, поле с «?» необязательно. Несколько операций за один раунд — taskflow_batch. Отдельными именами: taskflow_work_plan, taskflow_ask_user_question, taskflow_consult. Не выдумывай поля, имена и значения-заглушки. Если вызов отклонён, исправь указанный параметр; тот же неверный вызов не повторяй. После трёх одинаковых неверных вызовов ход останавливается. Прежние отдельные имена (taskflow_recall и т. п.) тоже принимаются.";
export const roleToolInstruction = (): string => registryTextOr("инструменты: всегда", "tools:ROLE_TOOL_INSTRUCTION", ROLE_TOOL_INSTRUCTION_LITERAL);
export const ROLE_TOOL_INSTRUCTION = ROLE_TOOL_INSTRUCTION_LITERAL;
/** Ядро: операции, без которых ход не начинается (сориентироваться, взять
 * слот) и не закрывается (план, комментарий, сдача шага). Отбор — по частоте
 * за 14 дней (role_tool_audit) и по обязательности шага. Остальное подключает
 * загрузчик по требованию: весь каталог в каждый запрос не уходит. */
/** Стартовый набор TaskFlow-операций — один для всех ролей и обоих способов (карточка, чат).
 *  Решение владельца 06.11.2026: по фактическому использованию. Источник: role_tool_audit,
 *  action=invoke, с 2026-11-01 по 06.11.2026, объединение операций, покрывающих 95% вызовов:
 *  карточки (subtask_id не пуст) — 15 операций, 459 из 479 вызовов (95,8%);
 *  чаты — 14 операций taskflow_*, к ним web_*, things_*, composio_*, graft_* (идут своими путями),
 *  946 из 993 (95,3%). Плюс обязательные по решению владельца: taskflow_work_item_submit,
 *  taskflow_inspect, taskflow_call_role; загрузчик taskflow_tools добавляется отдельно.
 *  Остальное подключается через taskflow_tools. В чате карточные операции по-прежнему скрывает
 *  CARD_WORK_OPERATIONS, в чате задачи — ограничение task_chat.
 *  07.11.2026: загрузчик taskflow_tools снова в активном наборе — без него подключить
 *  операцию по имени было нечем. */
export const STARTER_TOOLS = [
  // карточки
  "taskflow_host_bash", "taskflow_work_plan", "taskflow_host_read", "taskflow_doc_read", "taskflow_recall",
  "taskflow_kb_search", "taskflow_task", "taskflow_host_edit", "taskflow_host_write", "taskflow_subtask_done",
  "taskflow_remember", "taskflow_subtask_work", "taskflow_chat_send", "taskflow_topic_send", "taskflow_comment",
  // чаты
  "taskflow_doc_write", "taskflow_chat_read", "taskflow_plan_read", "taskflow_ask_user_question", "taskflow_slot_status",
  "taskflow_chat_share_material", "taskflow_agents", "taskflow_topic_read", "taskflow_task_summary", "taskflow_status",
  "taskflow_plan_ops", "taskflow_chat_reply",
  // обязательные
  "taskflow_work_item_submit", "taskflow_inspect", "taskflow_call_role",
  // подключение операций по требованию
  "taskflow_tools",
] as const;
const CORE_OPERATIONS = new Set<string>(STARTER_TOOLS);

/** Операции внешних сервисов подключаются по требованию, а не сразу (07.11.2026).
 *  Замер журнала запросов (сессия чата 3a1c1875): из 142 схем 46 Todoist, 5 Composio и
 *  20 Things — 71 схема, 84 844 символа из 169 525. Роль зовёт их изредка, а платят
 *  за них все запросы сессии. Права не меняются: операции остаются в реестре сессии,
 *  загрузчик отдаёт только то, что роль и так имеет право вызывать. */
export const ON_DEMAND_PREFIXES = ["todoist_", "mcp__composio__", "things_"] as const;
const isOnDemandOperation = (name: string): boolean => ON_DEMAND_PREFIXES.some(prefix => name.startsWith(prefix));
/** Ядро (STARTER_TOOLS) активно всегда; внешние сервисы — только через taskflow_tools. */
const staysActive = (name: string): boolean => CORE_OPERATIONS.has(name) || !isOnDemandOperation(name);

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
  roleToolAllowed(input.role,name) && (!input.subtaskId || name!=="taskflow_claim")};
 const taskflowOperations=taskflowTools(input.role,input.model??null,input.taskId,input.subtaskId,true,{chatId:input.chatId??"",messageId:input.messageId??""});
 const adapterNames=new Set(adapters.map(tool=>tool.name));
 const hostTools=createHostRoleTools(input.role,input.taskId,input.subtaskId);
 // Вызов роли как субагента: только Помощник и Оркестратор (правило доступа
 // в roleToolScope). В каталоге СУБАГЕНТА инструмента нет — иначе роли
 // вызывают друг друга цепочкой (роль → роль → роль).
 const openBranchTools = !isSubagentRun() && roleToolAllowed(input.role,"taskflow_chat_open_branch")
 ? [createSecretaryOpenBranchTool(context)] : [];
 const subagentCallTools = !isSubagentRun() && roleToolAllowed(input.role,ROLE_SUBAGENT_CALL_TOOL)
 ? [createRoleSubagentCallTool(context)] : [];
 // Уточнение работающему субагенту — тем же правом, что и сам вызов.
 const subagentSteerTools = !isSubagentRun() && roleToolAllowed(input.role,ROLE_SUBAGENT_STEER_TOOL)
 ? [createRoleSubagentSteerTool(context)] : [];
 // Новый ход роли — счётчик вызовов субагента сбрасывается: лимит «3 за ход».
 if(subagentCallTools.length)resetSubagentCallCounters(input.role,input.chatId??"");
 const allOperations=[...taskflowOperations.filter(tool=>!adapterNames.has(tool.name)),...roleHostAccessTools(input),...hostTools,...openBranchTools,...subagentCallTools,...subagentSteerTools,...adapters];
 // Чат задачи: чужую карточку, документ и коллегу пускает только слово владельца.
 // Один набор во всех режимах (владелец 07.11.2026): чат задачи больше не урезается.
 const operations=allOperations;
 const universal=createUniversalTaskflow(operations,context,toolRequestStore);
 const handledCalls=new Set<string>();
 const sdkMistakes=new Map<string,number>();
 // Ключ памяти подключённых по требованию операций: роль + чат/задача.
 const scope=onDemandScopeKey(input); // Нативный инструмент исполняется напрямую (владелец 27.10.2026): Pi
 // рассчитан на обычные инструменты, а прогон через общий шлюз (конверт,
 // request_id, тренер ошибок) совпал по времени с ростом сбоев шагов.
 // Права проверяются и здесь, каждый вызов пишется в журнал аудита.
 const requestScope=JSON.stringify({taskId:context.taskId??null,subtaskId:context.subtaskId??null,chatId:context.chatId??null});
 const aliases=operations.map(tool=>({...tool,execute:async(id:string,args:any,signal?:AbortSignal,onUpdate?:any)=>{
  handledCalls.add(id);
  // A1: на каждое действие роли — событие с областью, элементом, инструментом,
  // исходом, кодом отказа, повтором и длительностью. Пишется и на успех, и на
  // отказ: без строки об успехе сторож считал ok=0 и гасил живой ход.
  const startedAt=Date.now();
  const actionEvent={scope:input.taskId?"task":"chat",itemId:input.subtaskId??input.taskId??input.chatId??null};
  const audit=(outcome:"ok"|"error",errorCode?:string,errorMessage?:string)=>recordToolAudit({...context,...actionEvent,action:"invoke",tool:tool.name,operation:tool.name,outcome,errorCode,errorMessage,durationMs:Date.now()-startedAt});
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
   const message=String((error as Error)?.message??error).slice(0,500);
   // Служебный отказ (устаревший ход, закрытый чек-лист, уточнение) — не
   // ошибка аргументов: пишется своим кодом и в цикл неверных вызовов не идёт.
   const serviceCode=serviceRefusalCodeOf({code:(error as {code?:string})?.code??null,text:message});
   audit("error",serviceCode??(rejected?"REJECTED":"OPERATION_FAILED"),message);
   throw error;
  }
 }}));
 const nativeByName=new Map(aliases.map(tool=>[tool.name,tool]));
 const loader=createToolLoader({operations:aliases,onActivated:names=>{for(const name of names)rememberOnDemandTool(scope,name);}});
 // A1: отказы, которые доходят только сюда (SDK отклонил вызов до запуска
 // операции), пишутся в учёт с той же формой события действия: область,
 // элемент, инструмент, исход и код. Успешные вызовы здесь не видны — их
 // пишет сама операция, вместе с длительностью.
 const refusalEvent={scope:input.taskId?"task":"chat",itemId:input.subtaskId??input.taskId??input.chatId??null};
 // SDK validates native schemas before execute(). Such refusals must not vanish
 // from counters or evade the existing three-mistake stop policy.
 // Вызов операции, которой нет в активном наборе: сервер подключает её и тут же выполняет
 // тот же вызов с теми же аргументами (06.11.2026) — без ошибки и без повторного хода.
 const startArgs=new Map<string,any>();
 const autoHandled=new Set<string>();
 // toolCallId вызовов, которые выполнило автоподключение: у их результата признак ошибки снимается везде.
 const autoConnected=new Set<string>();
 const onAgentEvent=async(event:any,signal?:AbortSignal):Promise<void>=>{
  if(event?.type==="tool_execution_start"){startArgs.set(event.toolCallId,event.args);return;}
  // Сообщение с результатом ещё не сохранено в сессии и не ушло провайдеру: правим его здесь,
  // тогда и запрос, и файл сессии (resume) получают его без признака ошибки.
  if((event?.type==="message_start"||event?.type==="message_end")&&event.message?.role==="toolResult"&&autoConnected.has(event.message.toolCallId)){
   fixAutoConnectedMessage(event.message);return;
  }
  if(event?.type!=="tool_execution_end")return;
  const args=startArgs.get(event.toolCallId);startArgs.delete(event.toolCallId);
  if(!event.isError||args===undefined)return;
  // Только операции, разрешённые роли и режиму (aliases отфильтрованы operationRestriction);
  // остальное — прежний отказ. Неверные аргументы тоже идут прежним путём: роль увидит схему.
  const tool=nativeByName.get(event.toolName);
  if(!tool||!isToolNotInCatalogText(toolResultText(event.result)))return;
  if(!Check(tool.parameters,args))return;
  autoHandled.add(event.toolCallId);autoConnected.add(event.toolCallId);
  rememberOnDemandTool(scope,tool.name);loader.activate([tool.name]);
  // Отдельное действие учёта: не «invoke», поэтому счётчики ошибок и сторож его не видят.
  recordToolAudit({...context,...refusalEvent,action:"auto_connect",tool:tool.name,operation:tool.name,outcome:"ok",errorMessage:"auto_connected"});
  try{
   const result:any=await tool.execute(event.toolCallId,args,signal);
   event.result.content=result?.content??[];event.result.details=result?.details;event.isError=false;
  }catch(error:any){
   event.result.content=[{type:"text",text:String(error?.message??error)}];
  }
 };
 const onToolExecutionEnd=(event:any):boolean=>{
  if(event.type!=="tool_execution_end")return false;
  if(autoHandled.delete(event.toolCallId)){handledCalls.delete(event.toolCallId);return false;}
  if(handledCalls.delete(event.toolCallId))return false;
  if(!event.isError)return false;
  // Pi не кладёт args в событие — причина отказа живёт в тексте результата.
  const text=toolResultText(event.result);
  const tool=nativeByName.get(event.toolName);
  // Операция не подключена к сессии: это не неверные аргументы. Подключаем её
  // сами (только из реестра роли — права не расширяются) и НЕ считаем это
  // неверным вызовом: три таких отказа роняли ход роли.
  // Только сообщение «инструмент не в каталоге»: иначе настоящая ошибка
  // аргументов с текстом «task not found» попадала сюда, вычиталась из
  // счётчика ошибок и ход не останавливался (D1 карточки e73e7314).
  if(isToolNotInCatalogText(text)){
   recordToolAudit({...context,...refusalEvent,action:"invoke",tool:event.toolName,operation:event.toolName,outcome:"error",errorCode:TOOL_NOT_CONNECTED,errorMessage:"Операция не подключена к сессии — подключается автоматически"});
   if(tool){rememberOnDemandTool(scope,event.toolName);loader.activate([event.toolName]);}
   return false;
  }
  if(!tool)return false;
  // Отказ самого сервера — вызов верный, ошибкой роли не считается. В учёте он
  // остаётся и пишется своим кодом: видно, что роль ждала зря, и видно, что
  // это не её ошибка аргументов.
  const serviceCode=serviceRefusalCodeOf({text});
  if(serviceCode){
   recordToolAudit({...context,...refusalEvent,action:"invoke",tool:tool.name,operation:tool.name,outcome:"error",errorCode:serviceCode,errorMessage:"Отказ сервера: вызов не выполнялся, аргументы верные"});
   return false;
  }
  const issue=parseSchemaIssue(text);
  const reason="SDK отклонил вызов до выполнения";
  recordToolAudit({...context,...refusalEvent,action:"invoke",tool:tool.name,operation:tool.name,outcome:"error",errorCode:"INVALID_ARGUMENTS",errorMessage:reason,errorField:issue?.field,errorExpected:issue?.expected});
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
 // Набор роли (владелец 07.11.2026): у всех ролей один полный набор, сгруппированный
 // по объектам (taskflow_tasks, taskflow_step, …), действие — параметром action.
 // Отдельные операции остаются в реестре сессии: вызов прежнего имени подключается
 // автоматически (onAgentEvent), поэтому история и старые привычки ролей не ломаются.
 const grouped=buildToolGroups(aliases);
 const batch=createBatchTool(aliases);
 const hidden=new Set<string>([...grouped.members,...RETIRED_OPERATIONS]);
 const standalone=aliases.filter(tool=>!hidden.has(tool.name));
 // Активный набор: ядро, группы по объектам, пакетный вызов и загрузчик. Внешние
 // сервисы (Todoist, Composio, Things) остаются в реестре сессии и подключаются
 // через taskflow_tools — по имени или по смыслу задачи.
 const activeNames=[...standalone.filter(tool=>staysActive(tool.name)).map(tool=>tool.name),...grouped.tools.map(tool=>tool.name),batch.name,loader.tool.name];
 return {activeNames,registeredNames:[...aliases.map(tool=>tool.name),...grouped.tools.map(tool=>tool.name),batch.name,loader.tool.name],customTools:[universal,...aliases,...grouped.tools,batch,loader.tool],operations,context,scope,loader,onToolExecutionEnd,onAgentEvent,autoConnected,
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

const NOT_FOUND_TEXT=/^Tool "?[\w.:-]+"? not found$/;
const dropNotFound=(blocks:any[]):any[]=>blocks.filter(b=>!(b?.type==="text"&&typeof b.text==="string"&&NOT_FOUND_TEXT.test(b.text.trim())));
/** Сообщение toolResult автоподключённого вызова — без признака ошибки и без «Tool X not found». */
export function fixAutoConnectedMessage(message:any):void{
 message.isError=false;
 if(Array.isArray(message.content)){const kept=dropNotFound(message.content);if(kept.length)message.content=kept;}
}
/** Запрос провайдеру: снять признак ошибки у результатов автоподключённых вызовов в формате провайдера.
 *  Anthropic — is_error; Google — response.error → output; Bedrock — status; Mistral — префикс «[tool error]»;
 *  OpenAI Chat Completions и Responses признака ошибки не имеют — убираем только остаток «Tool X not found». */
export function clearAutoConnectedErrorFlags(payload:any,ids:ReadonlySet<string>):any{
 if(!payload||!ids.size)return payload;
 const clean=(text:any)=>typeof text==="string"&&NOT_FOUND_TEXT.test(text.trim())?"":text;
 for(const msg of payload.messages??[]){
  // Anthropic: content[] с type tool_result
  if(Array.isArray(msg?.content))for(const block of msg.content){
   if(block?.type==="tool_result"&&ids.has(block.tool_use_id)){
    if("is_error" in block)block.is_error=false;
    if(Array.isArray(block.content))block.content=dropNotFound(block.content);else block.content=clean(block.content);
   }
   // Bedrock: toolResult { toolUseId, status }
   if(block?.toolResult&&ids.has(block.toolResult.toolUseId)){
    if(block.toolResult.status==="error")block.toolResult.status="success";
    if(Array.isArray(block.toolResult.content))block.toolResult.content=block.toolResult.content.filter((c:any)=>!(typeof c?.text==="string"&&NOT_FOUND_TEXT.test(c.text.trim())));
   }
  }
  // OpenAI Chat Completions и Mistral: role tool
  if(msg?.role==="tool"&&ids.has(msg.tool_call_id)){
   if(typeof msg.content==="string")msg.content=clean(msg.content.replace(/^\[tool error\] /,""));
   else if(Array.isArray(msg.content))msg.content=msg.content.map((c:any)=>typeof c?.text==="string"?{...c,text:clean(c.text.replace(/^\[tool error\] /,""))}:c);
  }
 }
 // OpenAI Responses: input[] с function_call_output
 for(const item of payload.input??[])if(item?.type==="function_call_output"&&ids.has(item.call_id)&&typeof item.output==="string")item.output=clean(item.output);
 // Google: contents[].parts[].functionResponse
 for(const content of payload.contents??[])for(const part of content?.parts??[]){
  const fr=part?.functionResponse;
  if(fr&&ids.has(fr.id)&&fr.response&&"error" in fr.response){const {error,...rest}=fr.response;fr.response={...rest,output:clean(error)};}
 }
 return payload;
}

export function installNativeToolSchemas(session:any,catalog:ReturnType<typeof buildRoleToolCatalog>):void {
 if(!session?.agent)return; // External CLI runtime owns its own transport.
 const previous=session.agent.onPayload;
 session.agent.onPayload=async(payload:any,model:any)=>{
  const next=(await previous?.(payload,model))??payload;
  const cleaned=clearAutoConnectedErrorFlags(next,catalog.autoConnected);
  return model?.api==="anthropic-messages" ? restoreNativeToolSchemas(cleaned,catalog.customTools) : cleaned;
 };
 // Слушатель агента ждётся ядром Pi: подключение и выполнение идут до того, как
 // результат станет сообщением. Встаём первыми, чтобы сессионный сторож видел готовый исход.
 const agent=session.agent;
 if(typeof agent.subscribe==="function"){
  const earlier=agent.listeners instanceof Set?[...agent.listeners]:[];
  if(earlier.length)agent.listeners.clear();
  agent.subscribe(catalog.onAgentEvent);
  for(const listener of earlier)agent.listeners.add(listener);
 }
 session.subscribe((event:any)=>{
  if(catalog.onToolExecutionEnd(event))void session.abort();
 });
}

/** Группы операций TaskFlow (владелец 07.11.2026): ~90 отдельных схем → инструмент
 *  на объект. Имя действия — имя операции без префикса taskflow_. */
export const TOOL_GROUPS:Record<string,{title:string;ops:string[]}>={
 taskflow_tasks:{title:"Задачи и проекты",ops:["task","my_tasks","project_tasks","projects","create_project","create_task","children","dependencies","labels","set_task_labels","archive","task_summary","task_daily","task_proposal","structure_dictation","suggest_subtasks"]},
 taskflow_step:{title:"Работа над шагом карточки",ops:["claim","state","comment","subtask_add","subtask_work","subtask_done","work_start","review","report"]},
 taskflow_plans:{title:"План совместной работы",ops:["plan_read","plan_create","plan_edit","plan_ops","plan_propose","plan_approve","plan_proposal_decide","plan_from_subtasks","plan_request","node_run","assign","mission_contract"]},
 taskflow_slot:{title:"Слоты плана",ops:["slot_status","slot_reset","slot_restart","slot_cancel","slot_snapshot"]},
 taskflow_chats:{title:"Чаты и темы",ops:["chat_read","chat_reply","chat_send","chat_archive","chat_close","chats_cleanup","chats_cleanup_preview","topic_read","topic_reply","topic_send","chat_attach_file","chat_share_material","checklist_state"]},
 taskflow_knowledge:{title:"Документы и база знаний",ops:["docs","doc_read","doc_write","library","kb_search","kb_categorize"]},
 taskflow_memory:{title:"Память роли",ops:["recall","remember"]},
 taskflow_mail:{title:"Почта",ops:["mail_accounts","mail_list","mail_read","mail_attachment","mail_draft","mail_archive","mail_spam","mail_trusted","mail_send_to_owner"]},
 taskflow_team:{title:"Команда и состояние",ops:["agents","team_read","status","my_stats","runtime","weather","calendar_events"]},
};
/** Операции, которые роли больше не вызывают сами: пульс ставит сервер, набор полный
 *  (подгружать и просить нечего). Имена остаются в реестре. Протокол правил
 *  (rule_publish/rule_acknowledge), переписка ролей и Mission Control — остаются
 *  (владелец 07.11.2026). */
export const RETIRED_OPERATIONS=new Set<string>(["taskflow_heartbeat","taskflow_tool_request","taskflow_tools"]);
export const BATCH_TOOL_NAME="taskflow_batch";

const shortName=(name:string)=>name.replace(/^taskflow_/,"");
function fieldsOf(schema:any):string{
 const props=schema?.properties??{};
 const required=new Set<string>(schema?.required??[]);
 const names=Object.keys(props);
 return names.length?names.map(n=>required.has(n)?n:n+"?").join(", "):"без полей";
}
const ArgsSchema=Type.Optional(Type.Object({},{additionalProperties:true,description:"поля действия"}));

/** Инструмент на объект: action выбирает операцию, args — её поля (можно и рядом с action).
 *  Исполняет ту же операцию из aliases — права, аудит и идемпотентность прежние. */
export function buildToolGroups(aliases:Tool[]):{tools:Tool[];members:Set<string>}{
 const byName=new Map(aliases.map(tool=>[tool.name,tool]));
 const tools:Tool[]=[];
 const members=new Set<string>();
 for(const [group,spec] of Object.entries(TOOL_GROUPS)){
  if(byName.has(group))continue; // имя занято операцией — группу не строим, конфликта имён нет
  const ops=spec.ops.map(op=>byName.get("taskflow_"+op)).filter((tool):tool is Tool=>!!tool);
  if(!ops.length)continue;
  const own=new Set(ops.map(op=>op.name));
  for(const name of own)members.add(name);
  const actions=ops.map(op=>shortName(op.name));
  // Описание операции целиком: в нём обязательные правила (отчёт при сдаче, формат вердикта).
  const lines=ops.map(op=>`### ${shortName(op.name)}\nПоля: ${fieldsOf(op.parameters)}.\n${String(op.description??"").trim()}`);
  tools.push({
   name:group,
   description:`${spec.title}. Выбери действие в action, его поля передай в args. Поле с «?» необязательно.\n\n${lines.join("\n\n")}`,
   parameters:Type.Object({action:Type.Union(actions.map(a=>Type.Literal(a)),{description:"действие"}),args:ArgsSchema},{additionalProperties:true}),
   execute:async(id:string,raw:any,signal?:AbortSignal,onUpdate?:any)=>{
    const {action,args,...rest}=(raw??{}) as Record<string,any>;
    const name="taskflow_"+shortName(String(action??""));
    const tool=own.has(name)?byName.get(name):undefined;
    if(!tool)throw new Error(`Неизвестное действие «${action}» в ${group}. Доступны: ${actions.join(", ")}.`);
    return tool.execute(id,{...rest,...(args&&typeof args==="object"?args:{})},signal,onUpdate);
   },
  });
 }
 return {tools,members};
}

/** Несколько операций одним вызовом, по порядку; ошибка одной не останавливает остальные. */
export function createBatchTool(aliases:Tool[]):Tool{
 const byName=new Map(aliases.map(tool=>[tool.name,tool]));
 return {
  name:BATCH_TOOL_NAME,
  description:"Несколько операций TaskFlow одним вызовом, по порядку: например, прочитать карточку, план и память за один раунд. ops — до 10 элементов {action, args}; action — действие любой группы (recall, task, plan_read …) или полное имя операции. Ошибка одной операции не останавливает остальные — у каждой свой ответ.",
  parameters:Type.Object({ops:Type.Array(Type.Object({action:Type.String({description:"действие или имя операции"}),args:ArgsSchema}),{minItems:1,maxItems:10})}),
  execute:async(id:string,raw:any,signal?:AbortSignal,onUpdate?:any)=>{
   const ops:any[]=Array.isArray(raw?.ops)?raw.ops.slice(0,10):[];
   const content:any[]=[];
   for(const [index,op] of ops.entries()){
    const action=String(op?.action??"");
    const name=byName.has(action)?action:"taskflow_"+shortName(action);
    const tool=RETIRED_OPERATIONS.has(name)?undefined:byName.get(name);
    let text:string;
    if(!tool)text=`Нет операции «${action}».`;
    else try{
     const result:any=await tool.execute(`${id}:${index}`,op?.args&&typeof op.args==="object"?op.args:{},signal,onUpdate);
     text=(result?.content??[]).map((part:any)=>typeof part?.text==="string"?part.text:"").join("\n");
    }catch(error){text="Ошибка: "+String((error as Error)?.message??error).slice(0,500);}
    content.push({type:"text",text:`## ${index+1}. ${action}\n${text}`});
   }
   return {content,details:{operation:BATCH_TOOL_NAME,count:ops.length}};
  },
 };
}
