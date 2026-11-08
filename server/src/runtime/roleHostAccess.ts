import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {Type} from "typebox";
import {Check} from "typebox/value";
import {createCodingTools,createReadOnlyTools} from "@earendil-works/pi-coding-agent";
import db from "../db.js";
import {getTaskForRead,privateProjectHides,archivedProjectHides} from "../access.js";
import {roleUserId} from "../roleRouting.js";
import {listMachines} from "../host/machines.js";
import {resolveMachine,isMachineOnline,runOperation} from "../host/gateway.js";
import {HOSTS_CONFIG} from "./roleWorkspace.js";
import {hostOperations,withHostToolExecution} from "./hostOperations.js";
import {местаОшибок, type Tool} from "./universalTaskflow.js";
import {asText,captureBash,captureFile,q,withFileChanges,type CaptureIO} from "../lib/toolFileCapture.js";
import {backgroundStartError} from "./backgroundJobs.js";
import {backgroundJobs} from "./backgroundJobsLive.js";
import {startActivityHeartbeat} from "./runActivityHeartbeat.js";
type Context={role:string;taskId?:string;chatId?:string;runId?:string};
const native=()=>[...new Map([...createCodingTools("/"),...createReadOnlyTools("/")].map(t=>[t.name,t])).values()];
const bindings=()=>JSON.parse(fs.readFileSync(HOSTS_CONFIG,"utf8")).projects as Record<string,Record<string,string>>;
function projectForRole(id:string,role:string){
 const p=db.prepare("SELECT * FROM projects WHERE id=?").get(id) as any;
 if(!p || privateProjectHides(roleUserId(role),p) || archivedProjectHides(roleUserId(role),p))throw new Error("Проект недоступен этой роли");
 return p;
}
export function roleHostTargets(role:string){
 const config=bindings();
 return listMachines().filter(m=>!m.revoked_at).map(m=>({
  id:m.id,name:m.name,online:isMachineOnline(m.id),
  projects:Object.entries(config[m.id]??{}).flatMap(([project_id,repo])=>{
   try{const p=projectForRole(project_id,role);return [{project_id,name:p.name,repo}];}catch{return [];}
  })
 })).filter(m=>m.projects.length);
}
/**
 * Машина, проект и рабочая копия для вызова хоста — общая часть обычных
 * операций и фоновых команд (08.11.2026): фон обязан попадать в то же дерево,
 * что и синхронный bash, иначе две сборки топчут одну папку.
 */
async function resolveHostTarget(c:Context,p:any,signal?:AbortSignal){
 // Пустая строка от модели — не задача. В чате без задачи чужой или несуществующий task_id не блокирует
 // работу (06.11.2026): инструмент идёт в контексте чата, права роли и машины проверяются как обычно.
 let taskId:string|undefined=(p.task_id||c.taskId)||undefined;
 if(taskId&&!c.taskId&&!getTaskForRead(taskId,roleUserId(c.role)))taskId=undefined;
 let projectId=p.project_id;
 if(taskId){
  if(c.taskId && taskId!==c.taskId)throw new Error("Используй текущую задачу");
  const task=getTaskForRead(taskId,roleUserId(c.role));
  if(!task)throw new Error("Задача недоступна");
  // Явный project_id — любой проект на машине, доступный роли (владелец
  // 20.10.2026): карточка веба не могла заглянуть в iOS-репозиторий для
  // сверки, роли упирались в отказ и жгли круги доработки. Без project_id —
  // проект карточки, как раньше.
  projectId=projectId||task.project_id;
 }
 const candidates=roleHostTargets(c.role).flatMap(m=>m.projects.map(project=>({...project,machine:m}))).filter(pj=>(!projectId||pj.project_id===projectId)&&(!p.machine||pj.machine.id===p.machine||pj.machine.name===p.machine));
 if(candidates.length!==1)throw new Error(candidates.length?"Несколько проектов или машин: укажи project_id и machine из taskflow_hosts":"У проекта карточки нет репозитория на машине. Вызови taskflow_hosts и передай project_id нужного проекта (например, iOS-репозитория) — работать можно в любом проекте из этого списка");
 const target=candidates[0],machine=resolveMachine(target.machine.id)!;
 if(!isMachineOnline(machine.id))throw new Error("Машина "+machine.name+" сейчас офлайн");
 const key=taskId??"host-"+crypto.createHash("sha256").update(c.role+"|"+target.project_id).digest("hex").slice(0,32);
 const worktree=await runOperation(machine.id,"git_worktree",{action:"create",repo:target.repo,taskId:key,branch:"roles/"+key},{signal});
 if(!worktree.ok)throw new Error(worktree.error);
 const cwd=(worktree.data as any)?.path??JSON.parse(worktree.stdout??"{}").path;
 if(typeof cwd!=="string")throw new Error("Хост не вернул рабочую папку");
 return {target,machine,cwd,key,taskId,projectId};
}

/**
 * Пока команда идёт, ход не считается молчащим: сторож тишины видел только
 * старт инструмента, и 40-минутная сборка обрывалась зачисткой на 30-й минуте.
 * Импорт динамический — inProcessRun тянет каталог ролей, а тот этот модуль.
 */
let activityModule:Promise<{touchRunActivity:(runId:string)=>void;touchTaskActivity:(taskId:string)=>void}>|null=null;
function keepActivityAlive(c:Context,taskId?:string){
 return startActivityHeartbeat({onBeat:()=>{
  activityModule??=import("./inProcessRun.js");
  void activityModule.then(m=>{
   if(taskId)m.touchTaskActivity(taskId);
   if(c.runId)m.touchRunActivity(c.runId);
  }).catch(()=>{});
 }});
}

export async function executeRoleHostTool(c:Context,p:any,signal?:AbortSignal,onUpdate?:any){
 const selected=native().find(t=>t.name===p.tool);
 if(!selected)throw new Error("Неизвестная операция хоста: "+String(p.tool));
 const аргументы=p.arguments??{};
 if(!Check(selected.parameters,аргументы))throw new Error("Неверные параметры операции "+String(p.tool)+":"+местаОшибок(selected.parameters,аргументы));
 const {target,machine,cwd,taskId}=await resolveHostTarget(c,p,signal);
 const args={...(p.arguments??{})};
 if(typeof args.path==="string"){
  const resolved=path.posix.resolve(cwd,args.path);
  const root=["write","edit"].includes(p.tool)?cwd:target.repo;
  // Чат без задачи: указанный абсолютный путь допустим внутри разрешённых корней машины (их же проверяет и сам host).
  const inMachineRoots=!taskId&&(machine.allowed_roots??[]).some((r:string)=>{const base=r.replace(/\/+$/,"");return resolved===base||resolved.startsWith(base+"/");});
  if(!inMachineRoots && resolved!==root && !resolved.startsWith(root+"/"))throw new Error("Путь выходит за разрешённую папку проекта");
  args.path=resolved;
 }
 const o=hostOperations(machine.id,cwd);
 const options={bash:{operations:o.bash},read:{operations:o.read},write:{operations:o.write},edit:{operations:o.edit},grep:{operations:o.grep},find:{operations:o.find},ls:{operations:o.ls}};
 const tool=withHostToolExecution(machine.id,cwd,[...createCodingTools(cwd,options),...createReadOnlyTools(cwd,options)]).find(t=>t.name===p.tool)!;
 const run=()=>tool.execute(crypto.randomUUID(),args,signal,onUpdate);
 // Диф под ответом в чате (LOCK-ASSISTANT-TOOL-DIFFS-20261028): снимки
 // файлов до и после правки — на той же машине. Сбой снимка правку не роняет.
 const io=hostCaptureIO(machine.id,signal);
 if(["write","edit"].includes(p.tool)&&typeof args.path==="string"){
  const {result,files}=await captureFile(io,args.path,run);
  return withFileChanges(result,machine.name,files);
 }
 if(p.tool==="bash"){
  const stopHeartbeat=keepActivityAlive(c,taskId);
  try{
   const {result,files}=await captureBash(io,cwd,run);
   return withFileChanges(result,machine.name,files);
  }finally{
   stopHeartbeat();
  }
 }
 return run();
}
function hostCaptureIO(machineId:string,signal?:AbortSignal):CaptureIO{
 return {
  read:async file=>{
   const r=await runOperation(machineId,"read",{path:file,encoding:"base64"},{signal}) as any;
   if(!r.ok)return null;
   const d=(r.data??{}) as {content?:string;encoding?:string};
   return asText(Buffer.from(d.content??"",d.encoding==="base64"?"base64":"utf8"));
  },
  sh:async(command,dir)=>{
   const r=await runOperation(machineId,"bash",{command:"cd "+q(dir)+" && "+command,cwd:dir,timeoutMs:20_000},{signal,timeoutMs:50_000}) as any;
   return {ok:!!r.ok&&(r.exitCode??0)===0,stdout:typeof r.stdout==="string"?r.stdout:""};
  },
 };
}
const text=(value:unknown)=>({content:[{type:"text" as const,text:typeof value==="string"?value:JSON.stringify(value,null,1)}]});

/** Предел фоновой команды: тот же, что у синхронного bash роли (40 минут). */
const BG_MAX_SECONDS=40*60;

/**
 * Фоновая команда роли (08.11.2026): долгая команда не держит ход. Хост про
 * фон не знает — реестр живёт в сервере поверх runOperation со потоком.
 */
async function executeBackgroundTool(c:Context,p:any,signal?:AbortSignal){
 const jobs=backgroundJobs();
 const action=String(p.action??"status");
 const jobId=typeof p.job_id==="string"?p.job_id.trim():"";
 if(action==="list")return text(jobs.list({role:c.role}));
 if(action==="output")return text(jobs.output(jobId,Number(p.offset??0)||0));
 if(action==="stop")return text(jobs.stop(jobId));
 if(action==="status")return text(jobs.status(jobId));
 if(action!=="start")throw new Error("Неизвестное действие фоновой задачи: "+action+". Доступно: start, status, output, stop, list");
 const {target,machine,cwd,key,taskId}=await resolveHostTarget(c,p,signal);
 // Своя папка допустима только внутри дерева проекта или разрешённых корней машины:
 // фон не должен давать роль право бегать по всей файловой системе мака.
 const rawCwd=typeof p.cwd==="string"?p.cwd.trim():"";
 const workdir=rawCwd?path.posix.resolve(rawCwd.startsWith("/")?rawCwd:cwd,rawCwd):cwd;
 const roots=[...(machine.allowed_roots??[]) as string[],target.repo,cwd].filter(Boolean) as string[];
 const refusal=backgroundStartError({command:p.command,cwd:workdir,allowedRoots:roots});
 if(refusal)throw new Error(refusal);
 const seconds=Math.max(10,Math.min(Math.floor(Number(p.timeout??BG_MAX_SECONDS))||BG_MAX_SECONDS,BG_MAX_SECONDS));
 const job=jobs.start({role:c.role,worktreeKey:key,machineId:machine.id,cwd:workdir,command:String(p.command),timeoutMs:seconds*1000,taskId,chatId:c.chatId});
 return text({...job,hint:"Задача идёт без блокировки хода: можно закончить ход. Итог придёт сообщением в эту переписку, а ход роли поднимется сам. Статус — taskflow_host_bg action=status job_id="+job.id});
}

export function roleHostAccessTools(context:Context):Tool[]{
 const target={machine:Type.Optional(Type.String({description:"Имя или id из taskflow_hosts; при одной машине можно не указывать"})),project_id:Type.Optional(Type.String()),task_id:Type.Optional(Type.String())};
 return [{
  name:"taskflow_hosts",description:"Удалённые host: доступные машины и проекты, онлайн и пути. Доступно каждой роли в чате и задаче без согласования плана.",parameters:Type.Object({}),
  execute:async()=>({content:[{type:"text",text:JSON.stringify(roleHostTargets(context.role))}]})
 },{
  name:"taskflow_host_bg",
  description:"Фоновая команда на удалённом host (Mac): сборка, тесты, выкладка — всё, что идёт дольше нескольких секунд. Запуск НЕ держит ход: роль получает id задачи и может закончить ход, итог придёт сообщением в переписку и ход поднимется сам. В одном рабочем дереве идёт одна команда: вторая встаёт в очередь и стартует после первой. Для коротких команд (ls, grep, git status) используй taskflow_host_bash.",
  parameters:Type.Object({...target,
   action:Type.Union([Type.Literal("start"),Type.Literal("status"),Type.Literal("output"),Type.Literal("stop"),Type.Literal("list")],{description:"start — запустить, status — состояние и хвост, output — страница вывода, stop — остановить, list — свои задачи"}),
   command:Type.Optional(Type.String({description:"Команда для action=start"})),
   cwd:Type.Optional(Type.String({description:"Папка внутри рабочего дерева (по умолчанию — корень дерева проекта)"})),
   job_id:Type.Optional(Type.String({description:"id задачи из ответа start или list"})),
   offset:Type.Optional(Type.Number({description:"Смещение в байтах для action=output"})),
   timeout:Type.Optional(Type.Number({description:"Предел команды в секундах, не больше 2400 (по умолчанию 2400)"})),
  }),
  execute:async(_id:string,p:any,signal?:AbortSignal)=>executeBackgroundTool(context,p,signal)
 },...native().map(tool=>({
  name:"taskflow_host_"+tool.name,
  description:"Выполнить "+tool.name+" на удалённом host (Mac) в песочнице проекта. Доступно всем ролям без назначения этапа и согласования плана. Рабочая копия создаётся автоматически. Проект по умолчанию — проект карточки; для другого проекта (например, iOS-репозитория из веб-карточки) передай project_id из taskflow_hosts. "+(tool.name==="bash"?"Сборка, тесты, симулятор (xcodebuild, xcrun simctl) идут здесь; для долгих команд передай timeout в секундах (без него — 40 минут). Прямой ssh на Mac не нужен и не используется. ":"")+tool.description,
  parameters:Type.Object({...target,arguments:tool.parameters}),
  execute:async(_id:string,p:any,signal?:AbortSignal,onUpdate?:any)=>executeRoleHostTool(context,{...p,tool:tool.name},signal,onUpdate)
 }))];
}
