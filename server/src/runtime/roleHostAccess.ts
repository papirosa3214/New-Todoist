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
import {hostOperations} from "./hostOperations.js";
import type {Tool} from "./universalTaskflow.js";
type Context={role:string;taskId?:string};
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
export async function executeRoleHostTool(c:Context,p:any,signal?:AbortSignal,onUpdate?:any){
 const selected=native().find(t=>t.name===p.tool);
 if(!selected || !Check(selected.parameters,p.arguments??{}))throw new Error("Неверная операция хоста или её параметры");
 const taskId=p.task_id??c.taskId;
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
 const args={...(p.arguments??{})};
 if(typeof args.path==="string"){
  const resolved=path.posix.resolve(cwd,args.path);
  const root=["write","edit"].includes(p.tool)?cwd:target.repo;
  if(resolved!==root && !resolved.startsWith(root+"/"))throw new Error("Путь выходит за разрешённую папку проекта");
  args.path=resolved;
 }
 const o=hostOperations(machine.id,cwd);
 const options={bash:{operations:o.bash},read:{operations:o.read},write:{operations:o.write},edit:{operations:o.edit},grep:{operations:o.grep},find:{operations:o.find},ls:{operations:o.ls}};
 const tool=[...createCodingTools(cwd,options),...createReadOnlyTools(cwd,options)].find(t=>t.name===p.tool)!;
 return tool.execute(crypto.randomUUID(),args,signal,onUpdate);
}
export function roleHostAccessTools(context:Context):Tool[]{
 const target={machine:Type.Optional(Type.String({description:"Имя или id из taskflow_hosts; при одной машине можно не указывать"})),project_id:Type.Optional(Type.String()),task_id:Type.Optional(Type.String())};
 return [{
  name:"taskflow_hosts",description:"Удалённые host: доступные машины и проекты, онлайн и пути. Доступно каждой роли в чате и задаче без согласования плана.",parameters:Type.Object({}),
  execute:async()=>({content:[{type:"text",text:JSON.stringify(roleHostTargets(context.role))}]})
 },...native().map(tool=>({
  name:"taskflow_host_"+tool.name,
  description:"Выполнить "+tool.name+" на удалённом host (Mac) в песочнице проекта. Доступно всем ролям без назначения этапа и согласования плана. Рабочая копия создаётся автоматически. Проект по умолчанию — проект карточки; для другого проекта (например, iOS-репозитория из веб-карточки) передай project_id из taskflow_hosts. "+(tool.name==="bash"?"Сборка, тесты, симулятор (xcodebuild, xcrun simctl) идут здесь; для долгих команд передай timeout в секундах (без него — 40 минут). Прямой ssh на Mac не нужен и не используется. ":"")+tool.description,
  parameters:Type.Object({...target,arguments:tool.parameters}),
  execute:async(_id:string,p:any,signal?:AbortSignal,onUpdate?:any)=>executeRoleHostTool(context,{...p,tool:tool.name},signal,onUpdate)
 }))];
}
