import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"taskflow-unified-smoke-"));
fs.chmodSync(dir,0o700);
const live=process.argv[2]??"/home/maksim/Проекты/New-Todoist/server/taskflow.db";
const dbPath=path.join(dir,"smoke.db");
execFileSync("python3",["-c","import sqlite3,sys; a=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()",live,dbPath]);
Object.assign(process.env,{DB_PATH:dbPath,NODE_ENV:"test",JWT_SECRET:crypto.randomUUID(),INBOX_TRIAGE_DISABLED:"1",TASKFLOW_ROLE_WORKTREES:"off",TASKFLOW_NOTIF_ROOT:path.join(dir,"notifications"),TASKFLOW_ROLES_DIR:path.join(dir,"roles"),TASKFLOW_RUNS_DIR:path.join(dir,"runs"),UPLOAD_DIR:path.join(dir,"uploads"),OLLAMA_HEALTH_WATCHER_DISABLED:"1"});
delete process.env.TASKFLOW_KICK_IN_TESTS;
const {buildApp}=await import("../dist/index.js");
const app=await buildApp();
const {default:db}=await import("../dist/db.js");
const {buildRoleToolCatalog}=await import("../dist/runtime/roleToolCatalog.js");
const {loadRoleRouting}=await import("../dist/roleRouting.js");
const {parseModelRef}=await import("../dist/lib/attemptModel.js");
const {getModelRuntime}=await import("../dist/runtime/PiRuntimeAdapter.js");
const {createTaskResourceLoader}=await import("../dist/runtime/instructionResources.js");
const {createAgentSession,SessionManager,SettingsManager}=await import("@earendil-works/pi-coding-agent");
let session,resources;
try {
 const taskId="unified-smoke-"+crypto.randomUUID();
 db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES(?,?,'role_builder')").run(taskId,"Проба единого инструмента");
 const c=buildRoleToolCatalog({role:"builder",mode:"work",runId:"smoke-write",taskId});
 const invoke={action:"invoke",operation:"taskflow_comment",version:1,arguments:{id:taskId,text:"Проба единого входа"},request_id:"smoke-comment"};
 const first=JSON.parse((await c.customTools[0].execute("w1",invoke)).content[0].text);
 const second=JSON.parse((await c.customTools[0].execute("w2",invoke)).content[0].text);
 if(!first.ok || !second.ok)throw new Error("Основная запись не выполнена: "+JSON.stringify(first.error));
 const count=db.prepare("SELECT count(*) n FROM comments WHERE task_id=?").get(taskId).n;
 if(count!==1)throw new Error("Повтор создал "+count+" комментариев");
 console.log("BASIC_WRITE_OK: one comment after two calls; isolated DB");
 if(!process.argv.includes("--basic-only")) {
 const ref=parseModelRef(loadRoleRouting().models.builder);
 const runtime=await getModelRuntime();
 const model=runtime.getModel?.(ref.provider,ref.id);
 if(!model)throw new Error("Модель роли недоступна");
 const catalog=buildRoleToolCatalog({role:"builder",model:ref.id,mode:"plan",runId:"smoke-model"});
 resources=await createTaskResourceLoader("builder",dir,"Проверь единый инструмент taskflow. Доступен только он. Не выполняй работу проекта и не вызывай внешние сервисы. Найди taskflow_projects через discover, затем получи describe этой операции, затем invoke version=1 arguments={}. Заверши коротким ответом после успешного чтения. Никаких изменений.");
 ({session}=await createAgentSession({cwd:dir,model,thinkingLevel:model.reasoning?"medium":"off",modelRuntime:runtime,resourceLoader:resources,tools:catalog.activeNames,customTools:catalog.customTools,sessionManager:SessionManager.inMemory(),settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:true,maxRetries:1}})}));
 const active=session.getActiveToolNames();
 if(active.length!==1 || active[0]!=="taskflow")throw new Error("SDK активировал лишние инструменты: "+active);
 const calls=[],results=[];
 session.subscribe(e=>{
  if(e.type==="message_end" && e.message?.role==="assistant" && e.message?.stopReason==="error")console.log("MODEL_ERROR",String(e.message.errorMessage).replace(/Bearer\s+\S+/g,"Bearer [redacted]"));
  if(e.type==="tool_execution_start"){calls.push(e.args);console.log("MODEL_CALL",e.toolName,e.args?.action,e.args?.operation??"");}
  if(e.type==="tool_execution_end")results.push(e);
 });
 const timer=setTimeout(()=>void session.abort(),120000);
 try {await session.prompt("Выполни проверку: discover taskflow_projects, describe, invoke. Нужно настоящее чтение списка проектов, ответ словами не заменяет вызов.");}finally{clearTimeout(timer);}
 if(!calls.some(p=>p?.action==="discover")||!calls.some(p=>p?.action==="describe")||!calls.some(p=>p?.action==="invoke"&&p.operation==="taskflow_projects"))throw new Error("Модель не прошла полный цикл обнаружения/описания/вызова");
 if(!results.some(e=>{try{return JSON.parse(e.result.content[0].text).ok && JSON.parse(e.result.content[0].text).operation==="taskflow_projects";}catch{return false;}}))throw new Error("Не получен успешный результат операции");
 console.log("LIVE_MODEL_OK: SDK exposes only taskflow; real role model discovered, described and invoked server operation.");
 }
 console.log("Evidence directory:",dir);
} finally {
 session?.dispose();resources?.disposeResources();await app.close();db.close();
}
process.exit(0);
