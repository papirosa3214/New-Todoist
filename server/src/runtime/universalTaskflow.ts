import crypto from "node:crypto";
import { Type } from "typebox";
import { Check } from "typebox/value";
export type Tool = {name:string;description:string;parameters:any;
 /** Образец правильного вызова — дописывается к INVALID_ARGUMENTS, когда схема (anyOf) сама его не объясняет. */
 invalidArgsHint?:(args:Record<string,unknown>)=>string;
 execute:(id:string,args:any,signal?:AbortSignal,onUpdate?:any)=>Promise<any>};
export type Context = {actor:string;role:string;mode:string;runId:string;taskId?:string;subtaskId?:string;chatId?:string;messageId?:string;authorize?:(name:string)=>boolean};
export type RequestRecord = {actor:string;id:string;scope:string;hash:string;operation:string;state:string;result?:any};
export interface RequestStore {get(actor:string,id:string):RequestRecord|undefined;begin(r:RequestRecord):boolean;finish(actor:string,id:string,state:string,result:any):void}
export function memoryRequestStore():RequestStore {
 const records=new Map<string,RequestRecord>(); const key=(a:string,id:string)=>JSON.stringify([a,id]);
 return {get:(a,id)=>records.get(key(a,id)),begin:r=>{if(records.has(key(r.actor,r.id)))return false;records.set(key(r.actor,r.id),r);return true;},
 finish:(a,id,state,result)=>{Object.assign(records.get(key(a,id))!,{state,result});}};
}
const READ=new Set(["taskflow_team_read","taskflow_plan_read","taskflow_children","taskflow_runtime","taskflow_status","taskflow_agents","taskflow_project_tasks","taskflow_my_stats","taskflow_task_summary","taskflow_recall","taskflow_weather","taskflow_my_tasks","taskflow_task_daily","taskflow_calendar_events","taskflow_task","taskflow_rules","taskflow_projects","taskflow_docs","taskflow_doc_read","taskflow_kb_search","taskflow_library","taskflow_chat_read","taskflow_checklist_state","taskflow_topic_read","web_search","web_get","ocr","youtube","local_model"]);
const CHAT_CONTEXT=new Set(["taskflow_chat_attach_file","taskflow_slot_restart","taskflow_work_start"]);
const TASK_CONTEXT=new Set(["taskflow_topic_send","taskflow_topic_reply","taskflow_slot_snapshot"]);
export function isReadOperation(name:string){return ["taskflow_hosts","taskflow_host_read","taskflow_host_ls","taskflow_host_grep","taskflow_host_find"].includes(name) || READ.has(name) || name.startsWith("mcp__infra__");}
export function operationRestriction(name:string,c:Context):{code:string;message:string}|undefined{
 if(c.authorize && !c.authorize(name)) return {code:"FORBIDDEN",message:"Эта операция не разрешена роли "+c.role};
 if(c.mode==="plan" && !isReadOperation(name))return {code:"MODE_RESTRICTED",message:"Для изменения нужен режим Работа"};
 // «Обсуждение» в чате — то же, что работа по задаче: владелец поручает в
 // нём работу и заводит карточки, поэтому ограничений нет (20.10.2026).
 if(CHAT_CONTEXT.has(name) && (!c.chatId || !c.messageId))return {code:"CONTEXT_REQUIRED",message:"Нужно исходное сообщение в чате"};
 if(TASK_CONTEXT.has(name) && !c.taskId)return {code:"CONTEXT_REQUIRED",message:"Нужна текущая задача"};
}
function stable(value:any):string {
 if(Array.isArray(value))return "["+value.map(stable).join(",")+"]";
 if(value && typeof value==="object")return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stable(value[k])).join(",")+"}";
 return JSON.stringify(value);
}
const response=(payload:any,extra:any[]=[])=>({content:[{type:"text",text:JSON.stringify(payload)},...extra],details:{operation:payload.operation,request_id:payload.request_id}});
export /** Что делать дальше после ошибки. Требование владельца 19.10.2026: отказ
 *  без следующего шага бесполезен — агент или человек должен знать, куда идти.
 *  Подсказка приходит вместе с кодом в каждом отказе. */
const ПОДСКАЗКИ:Record<string,string>={
 INVALID_ARGUMENTS:"1) вызови describe для этой операции и сверь arguments с inputSchema; 2) для изменения обязателен request_id длиной 1..200 — он принимается и на верхнем уровне вызова, и внутри arguments; 3) если в describe нет нужного поля — операции нет в этом наборе, найди её через discover.",
 FORBIDDEN:"Операция не разрешена роли. 1) вызови discover по этой операции — там поле available и restriction; 2) попроси владельца или оркестратора расширить права роли; 3) обходных путей нет: молчаливый отказ хуже слов.",
 MODE_RESTRICTED:"Режим не тот. 1) plan — только чтение, для изменения нужен режим Работа или Обсуждение; 2) проверь, какой режим у текущего хода.",
 CONTEXT_REQUIRED:"Не хватает контекста. 1) передай task_id — без него операции над задачей не положены; 2) вызови из того чата, где есть сообщение, чтобы в контексте были chat_id и message_id; 3) в чате без задачи сначала уточни у владельца, что делать.",
 UNKNOWN_OPERATION:"Операция не найдена. 1) discover — поиск по смыслу задачи, а не по точному имени; 2) describe — точная схема и версия; 3) старое имя может быть совместимым обращением — попробуй найти его в discover.",
 VERSION_MISMATCH:"Версия не та. Поддерживается version: 1 — получи describe и повтори с version 1.",
 CONFLICT:"Запрос с таким request_id уже в работе или использован с другими аргументами. 1) состояние — операция requests.status с этим request_id; 2) если аргументы другие — возьми новый request_id; 3) повтор того же действия с тем же request_id не запускает его заново.",
 REJECTED:"Сервер отклонил вызов по правилу — действия не было. 1) в message написано правило и что исправить: выполни именно это (другие аргументы, другой порядок шагов, другой инструмент); 2) тот же вызов без изменений не повторяй — ответ будет тем же; 3) исправленный вызов отправляй с новым request_id; 4) если message прямо говорит ждать или что решение за владельцем — заверши ход и сообщи об этом, не перебирай.",
 OPERATION_FAILED:"Операция не выполнилась. 1) проверь состояние через requests.status; 2) если это внешний сервис или машина — сообщи владельцу: нужен код, текст и время; 3) не повторяй вслепую то же самое, сначала выясни причину.",
 DUPLICATE_OPERATION:"Один и тот же ход уже выполняется. Дождись текущего; второй запуск того же хода не нужен.",
};
const ответнаяПодсказка=(code:string)=>ПОДСКАЗКИ[code]??"Отказ нестандартный: 1) повтори discover/describe, чтобы сверить схему; 2) найди похожий случай в базе знаний (taskflow_kb_search); 3) не перебирай вручную — спроси архитектора или оркестратора, приложив код и текст ошибки.";

export const UNIVERSAL_INSTRUCTION="Серверные возможности доступны через один инструмент taskflow. Любая роль может работать с Mac через host: discover taskflow_hosts, затем taskflow_host_read/bash/edit/write/grep/find/ls. Назначение машины этапу и утверждение плана для доступа к host не нужны. При одном проекте машина и проект выбираются автоматически; для другого проекта на машине (например, iOS-репозитория из веб-карточки) передай project_id из taskflow_hosts. Рабочая копия создаётся в песочнице проекта. Сборка, тесты и симулятор — через host bash (долгим командам — timeout в секундах); прямой ssh не используется. Найди действие через discover (по названию или смыслу), получи точные параметры через describe, затем invoke с operation, version и arguments. Для изменения передавай уникальный request_id; при повторе того же действия используй прежний request_id. Состояние запроса: requests.status. Старые имена в истории — совместимые обращения к тем же операциям. Отказ объясняет права, режим или недостающий контекст; не объявляй возможность отсутствующую без поиска. Каждый отказ несёт поле hint — что делать дальше: читай его и выполняй по шагам, а не перебирай вызовы вслепую.";
export function createUniversalTaskflow(tools:Tool[],context:Context,store:RequestStore=memoryRequestStore()):Tool {
 const registry=new Map<string,Tool>();
 for(const tool of tools){if(registry.has(tool.name))throw new Error("Duplicate operation: "+tool.name);registry.set(tool.name,tool);}
 const scope=stable({taskId:context.taskId??null,subtaskId:context.subtaskId??null,chatId:context.chatId??null});
 return {name:"taskflow",description:UNIVERSAL_INSTRUCTION,parameters:Type.Object({
  action:Type.Union([Type.Literal("discover"),Type.Literal("describe"),Type.Literal("invoke")]),
  query:Type.Optional(Type.String()),operation:Type.Optional(Type.String()),version:Type.Optional(Type.Integer()),
  arguments:Type.Optional(Type.Record(Type.String(),Type.Any())),request_id:Type.Optional(Type.String({minLength:1,maxLength:200})),
  offset:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:20}))
 }),execute:async(id,p,signal,onUpdate)=>{
  const fail=(code:string,message:string)=>response({ok:false,operation:p?.operation,request_id:p?.request_id??(p?.arguments as any)?.request_id,error:{code,message,hint:ответнаяПодсказка(code)}});
  if(!p || !["discover","describe","invoke"].includes(p.action))return fail("INVALID_ARGUMENTS","action: discover, describe или invoke");
  const denied=(name:string)=>operationRestriction(name,context);
  if(p.action==="discover"){
   if((p.offset!==undefined && (!Number.isInteger(p.offset)||p.offset<0)) || (p.limit!==undefined && (!Number.isInteger(p.limit)||p.limit<1||p.limit>20)))return fail("INVALID_ARGUMENTS","offset >= 0; limit 1..20");
   const words=String(p.query??"").toLowerCase().split(/[\s._]+/).filter(Boolean);
   const matches=[...registry.values()].filter(t=>!context.authorize || context.authorize(t.name)).map(t=>({tool:t,score:words.reduce((n,w)=>n+((t.name+" "+t.description).toLowerCase().includes(w)?1:0),0)}))
    .filter(t=>!words.length || t.score>0).sort((a,b)=>b.score-a.score || a.tool.name.localeCompare(b.tool.name));
   const offset=p.offset??0,limit=p.limit??10;
   return response({ok:true,data:{operations:matches.slice(offset,offset+limit).map(({tool:t})=>({operation:t.name,version:1,description:t.description,available:!denied(t.name),restriction:denied(t.name)})),total:matches.length,next_offset:offset+limit<matches.length?offset+limit:null,hint:"Если ничего не найдено, повтори короче или запроси каталог без query. Статус запроса: operation requests.status, arguments {request_id}."}});
  }
  if(p.operation==="requests.status" || p.operation==="requests.reconcile"){
   if(p.action==="describe")return response({ok:true,data:{operation:p.operation,version:1,inputSchema:{type:"object",properties:{request_id:{type:"string"}},required:["request_id"]}}});
   if(p.version!==1)return fail("VERSION_MISMATCH","Поддерживается version: 1");
   const record=store.get(context.actor,p.arguments?.request_id);
   if(!record || record.scope!==scope)return fail("UNKNOWN_REQUEST","Запрос не найден в текущем контексте");
   const restriction=denied(record.operation);if(restriction)return fail(restriction.code,restriction.message);
   return response({ok:true,data:{state:record.state,result:record.result,reconciliation:p.operation==="requests.reconcile"?"Автоматическая сверка для этого адаптера не поддерживается; повтор не выполнен":undefined}});
  }
  const tool=registry.get(p.operation);
  if(!tool)return fail("UNKNOWN_OPERATION","Операция не найдена. Используй discover.");
  const restriction=denied(tool.name);
  if(p.action==="describe"){
   // request_id объявляем в схеме явно: без него рантайм агента не передаёт
   // поле, которого нет в inputSchema операции (см. выше про host-операции).
   const параметры:Record<string,unknown>={...(tool.parameters as any)};
   const свойства={...(параметры.properties as Record<string,unknown>|undefined??{})};
   if(!свойства.request_id)свойства.request_id={type:"string",minLength:1,maxLength:200,description:"Уникальный идентификатор запроса; для операций изменения обязателен"};
   return response({ok:true,data:{operation:tool.name,version:1,description:tool.description,inputSchema:{...параметры,properties:свойства},effects:isReadOperation(tool.name)?"read":"write",available:!restriction,restriction}});
  }
  if(restriction)return fail(restriction.code,restriction.message);
  if(p.version!==1)return fail("VERSION_MISMATCH","Поддерживается version: 1; получи describe");
  const write=!isReadOperation(tool.name);
  // request_id приходит и внутри arguments. Рантайм агента вырезает поля, которых
  // нет в схеме операции, а в схемах host-операций (`roleHostAccess.ts`) его нет —
  // из-за этого запись на удалённую машину падала с «нужен request_id» при любом
  // вызове (19.10.2026). Поле служебное: из аргументов операции убираем, чтобы
  // проверка схемы его не считала лишним.
  const {request_id:изАргументов,...args}=({...(p.arguments??{})} as Record<string,unknown>);
  const requestId=(typeof p.request_id==="string"&&p.request_id?p.request_id:typeof изАргументов==="string"?изАргументов:undefined);
  if(!Check(tool.parameters,args))return fail("INVALID_ARGUMENTS","Аргументы не соответствуют inputSchema: пришли ключи ["+Object.keys(args).join(", ")+"], ждём ["+((tool.parameters as any).properties?Object.keys((tool.parameters as any).properties).join(", "):"?")+"]"+((tool.parameters as any).required?"; обязательны: "+((tool.parameters as any).required as string[]).join(", "):"")+(tool.invalidArgsHint?". "+tool.invalidArgsHint(args):""));
  if(write && (typeof requestId!=="string" || !requestId.trim() || requestId.length>200))return fail("INVALID_ARGUMENTS","Для изменения нужен request_id длиной 1..200");
  const hash=crypto.createHash("sha256").update(stable({operation:tool.name,version:p.version,arguments:args})).digest("hex");
  if(write){
   const current=store.get(context.actor,requestId!);
   if(current){
    if(current.scope!==scope || current.hash!==hash)return fail("CONFLICT","Этот request_id уже использован с другим контекстом или аргументами");
    return current.result??response({ok:true,operation:tool.name,request_id:requestId,data:{state:current.state}});
   }
   if(!store.begin({actor:context.actor,id:requestId!,scope,hash,operation:tool.name,state:"running"}))return fail("CONFLICT","Запрос уже принят; проверь requests.status");
  }
  try{
   const result=await tool.execute(id,args,signal,onUpdate);
   if(result?.isError)throw new Error("Адаптер вернул ошибку; проверь результат операции");
   const resultContent=result?.content??[];
   const out=response({ok:true,operation:tool.name,version:1,request_id:requestId,data:{state:"succeeded",content:resultContent}},resultContent.filter((c:any)=>c.type!=="text"));
   if(write)store.finish(context.actor,requestId!,"succeeded",out);
   return out;
  }catch(error){
   // A transport error can happen after a side effect. Never repeat it automatically.
   // Отказ по правилу (ToolError, 4xx) — действия не было, исход известен.
   const status=(error as {status?:number}).status;
   const rejected=(error as Error)?.name==="ToolError" && (status===undefined || status<500);
   const out=fail(rejected?"REJECTED":"OPERATION_FAILED",String((error as Error).message));
   // requestId, а не p.request_id: он мог прийти внутри arguments, и тогда
   // запись оставалась running, а успешный вызов отдавался роли как сбой (19.10.2026).
   if(write)store.finish(context.actor,requestId!,rejected?"rejected":"unknown_outcome",out);
   return out;
  }
 }};
}
