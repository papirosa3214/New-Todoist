import {mkdirSync,appendFileSync,writeFileSync,existsSync,chmodSync,readdirSync,statSync,rmSync,utimesSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {homedir} from "node:os";
import {randomUUID,createHash} from "node:crypto";
type AuditInput={role?:string;call_id:string;phase:"context"|"payload";content:unknown;[key:string]:unknown};
function scrub(value:any):any {
 if(Array.isArray(value))return value.map(scrub);
 if(value && typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,/^(api.?key|authorization|headers|cookie|access.?token|refresh.?token|client.?secret)$/i.test(key)?"[REDACTED]":scrub(v)]));
 return value;
}
/** Owner-authorized private archive, separate from metadata-only diagnostics. */
export function recordPromptAudit(input:AuditInput,directory?:string):void {
 if(process.env.VITEST && !directory)return;
 const root=directory ?? auditRoot();
 // Сводка запроса — у всех ролей (владелец 11.11.2026); полный архив — только Помощник.
 if(input.phase==="payload" && input.role)recordContextDigest(input,root);
 if(input.role!=="secretary")return;
 try {
  mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
  const objects=join(root,"objects");mkdirSync(objects,{recursive:true,mode:0o700});
  const content=JSON.stringify(scrub(input.content),null,2);
  const sha=createHash("sha256").update(content).digest("hex");const object=join(objects,sha+".json");
  if(!existsSync(object))writeFileSync(object,content+"\n",{mode:0o600,flag:"wx"});
  const at=new Date().toISOString();const {content:_,...metadata}=input;
  appendFileSync(join(root,at.slice(0,10)+".jsonl"),JSON.stringify({...metadata,at,sha256:sha,characters:content.length,object:"objects/"+sha+".json"})+"\n",{mode:0o600});
  writeFileSync(join(root,"latest.md"),"# Model request audit\n\n"+JSON.stringify({...metadata,at,sha256:sha},null,2)+"\n\n```json\n"+content+"\n```\n",{mode:0o600});
 }catch{
  console.warn("prompt-audit: recording failed; model request continues");
  void import("../db.js").then(({default:db})=>{
   const type="prompt_audit_watch";
   if(db.prepare("SELECT 1 FROM notifications WHERE type=? AND created_at > datetime(?,?)").get(type,"now","-1 day"))return;
   const owner=db.prepare("SELECT id FROM users WHERE role=? LIMIT 1").get("owner") as {id:string}|undefined;
   if(owner)db.prepare("INSERT INTO notifications(id,user_id,type,text) VALUES(?,?,?,?)").run(randomUUID(),owner.id,type,"Журнал запросов Помощника не записывается. Проверьте место и права ~/.local/state/taskflow-prompt-audit; обращения продолжаются.");
  }).catch(()=>{});
 }
}

function auditRoot():string { return process.env.TASKFLOW_PROMPT_AUDIT_DIR ?? join(homedir(),".local/state/taskflow-prompt-audit"); }

function textOf(content:any):string {
 if(typeof content==="string")return content;
 if(Array.isArray(content))return content.map(part=>typeof part==="string" ? part : typeof part?.text==="string" ? part.text : "").filter(Boolean).join("\n");
 if(content && Array.isArray(content.parts))return textOf(content.parts);
 return "";
}

/** Что в теле запроса к провайдеру системный текст, какие инструменты и какой
 *  последний ход пользователя. Форматы: Anthropic, OpenAI Responses/Completions, Google. */
export function extractRequestContext(payload:any):{system:string;tools:string[];lastUser:string;messages:number} {
 const system:string[]=[];
 if(typeof payload?.system==="string")system.push(payload.system); else if(Array.isArray(payload?.system))system.push(textOf(payload.system));
 if(typeof payload?.instructions==="string")system.push(payload.instructions);
 if(payload?.systemInstruction)system.push(textOf(payload.systemInstruction));
 const list:any[]=Array.isArray(payload?.messages) ? payload.messages : Array.isArray(payload?.input) ? payload.input : Array.isArray(payload?.contents) ? payload.contents : [];
 for(const m of list)if(m && (m.role==="system" || m.role==="developer"))system.push(textOf(m.content));
 let lastUser="";
 for(let i=list.length-1;i>=0;i--){const m=list[i];if(m?.role!=="user")continue;const t=textOf(m.content ?? m.parts);if(t.trim()){lastUser=t;break;}}
 const tools=(Array.isArray(payload?.tools) ? payload.tools : []).flatMap((t:any)=>Array.isArray(t?.functionDeclarations) ? t.functionDeclarations.map((f:any)=>f?.name) : [t?.name ?? t?.function?.name]).filter((n:any)=>typeof n==="string");
 return {system:system.filter(x=>x.trim()).join("\n\n---\n\n"),tools,lastUser,messages:list.length};
}

const KEEP_DAYS=14;
const DAY_MS=24*60*60*1000;
let lastCleanup=0;
const safeName=(role:string)=>role.replace(/[^a-zA-Z0-9_.-]/g,"_");

/** Части (системный текст, ход, список инструментов) — один файл на содержимое; касание продлевает срок. */
function storePart(root:string,text:string):string {
 const parts=join(root,"parts");mkdirSync(parts,{recursive:true,mode:0o700});
 const sha=createHash("sha256").update(text).digest("hex");const file=join(parts,sha+".txt");
 if(existsSync(file)){const now=new Date();utimesSync(file,now,now);} else writeFileSync(file,text,{mode:0o600,flag:"wx"});
 return sha;
}

/** Срок хранения сводок — 14 дней. Полный архив Помощника (objects/, корневые .jsonl) не трогается. */
function cleanup(root:string):void {
 if(Date.now()-lastCleanup<60*60*1000)return;lastCleanup=Date.now();
 const border=Date.now()-KEEP_DAYS*DAY_MS;
 const old=(file:string)=>{try{return statSync(file).mtimeMs<border;}catch{return false;}};
 const rolesDir=join(root,"roles");
 if(existsSync(rolesDir))for(const role of readdirSync(rolesDir))for(const f of readdirSync(join(rolesDir,role)))if(f.endsWith(".jsonl") && old(join(rolesDir,role,f)))rmSync(join(rolesDir,role,f),{force:true});
 const parts=join(root,"parts");
 if(existsSync(parts))for(const f of readdirSync(parts))if(f.endsWith(".txt") && old(join(parts,f)))rmSync(join(parts,f),{force:true});
}

/** Сводка одного запроса роли к модели: журнал дня и latest.md роли для чтения глазами. */
export function recordContextDigest(input:AuditInput,root:string=auditRoot()):void {
 try {
  const role=safeName(String(input.role));
  const {system,tools,lastUser,messages}=extractRequestContext(scrub(input.content));
  const dir=join(root,"roles",role);mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(root,0o700);
  const at=new Date().toISOString();
  const meta:Record<string,unknown>={};
  for(const key of ["origin","chat_id","message_id","task_id","subtask_id","discussion_id","run_id","session_id","provider","model","api"])if(input[key]!==undefined && input[key]!==null)meta[key]=input[key];
  const entry={at,call_id:input.call_id,role:input.role,...meta,messages,
   system_sha:storePart(root,system),system_chars:system.length,
   tools_sha:storePart(root,tools.join("\n")),tools_count:tools.length,
   last_user_sha:storePart(root,lastUser),last_user_chars:lastUser.length};
  appendFileSync(join(dir,at.slice(0,10)+".jsonl"),JSON.stringify(entry)+"\n",{mode:0o600});
  const block=(text:string)=>"~~~~text\n"+(text || "(пусто)")+"\n~~~~";
  writeFileSync(join(dir,"latest.md"),[
   `# Последний запрос роли ${input.role} к модели`,"",
   "~~~~json",JSON.stringify(entry,null,2),"~~~~","",
   `## Системный текст (${system.length} симв.)`,"",block(system),"",
   `## Инструменты (${tools.length})`,"",tools.join(", ") || "(нет)","",
   `## Последний ход пользователя — то, что сервер приложил к сообщению (${lastUser.length} симв.)`,"",block(lastUser),"",
   `Всего сообщений в запросе: ${messages}. Части лежат в parts/<sha>.txt, журнал дня — ${at.slice(0,10)}.jsonl. Хранится ${KEEP_DAYS} дней.`,"",
  ].join("\n"),{mode:0o600});
  cleanup(root);
 }catch(error){
  console.warn("prompt-context: сводка запроса не записана; обращение к модели продолжается",String((error as any)?.message ?? error).slice(0,200));
  notifyContextWatch("Журнал контекста ролей не записывается: не видно, что уходит моделям. Проверьте место и права "+root+"; обращения к моделям продолжаются.");
 }
}

function notifyContextWatch(text:string):void {
 if(process.env.VITEST)return;
 void import("../db.js").then(({default:db})=>{
  const type="prompt_context_watch";
  if(db.prepare("SELECT 1 FROM notifications WHERE type=? AND created_at > datetime(?,?)").get(type,"now","-1 day"))return;
  const owner=db.prepare("SELECT id FROM users WHERE role=? LIMIT 1").get("owner") as {id:string}|undefined;
  if(owner)db.prepare("INSERT INTO notifications(id,user_id,type,text) VALUES(?,?,?,?)").run(randomUUID(),owner.id,type,text);
 }).catch(()=>{});
}

const PROBE_ROLE="__probe_prompt_context";
/** Пробный ход сторожа: настоящая запись сводки тем же путём и чтение latest.md. */
export function checkPromptContextInstrument(root:string=auditRoot()):{ok:boolean;reason:string} {
 const dir=join(root,"roles",PROBE_ROLE);const marker="probe-"+randomUUID();
 try {
  recordContextDigest({role:PROBE_ROLE,call_id:marker,phase:"payload",content:{system:marker,tools:[{name:"probe_tool"}],messages:[{role:"user",content:marker}]}},root);
  const latest=existsSync(join(dir,"latest.md")) ? readFileSync(join(dir,"latest.md"),"utf8") : "";
  if(!latest.includes(marker) || !latest.includes("probe_tool"))return {ok:false,reason:"пробная запись не появилась в latest.md"};
  return {ok:true,reason:""};
 }catch(error){return {ok:false,reason:"ошибка пробного хода: "+String((error as any)?.message ?? error).slice(0,160)};}
 finally{try{rmSync(dir,{recursive:true,force:true});}catch{}}
}

/** Сторож журнала контекста: пробный ход через минуту после старта и далее раз в 15 минут. */
export function startPromptContextWatcher():()=>void {
 const check=()=>{const r=checkPromptContextInstrument();if(!r.ok){console.error("[prompt-context-watch] ПРИБОР НЕ РАБОТАЕТ:",r.reason);notifyContextWatch("Журнал контекста ролей сломан: "+r.reason+". Не видно, что уходит моделям.");}};
 const first=setTimeout(check,60_000),timer=setInterval(check,15*60_000);first.unref();timer.unref();
 return()=>{clearTimeout(first);clearInterval(timer);};
}
