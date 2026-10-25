import {beforeAll,it,expect,vi} from "vitest";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {allRoles} from "../src/roleRouting.js";
import {buildRoleToolCatalog,installNativeToolCore} from "../src/runtime/roleToolCatalog.js";
import {secretaryThings3Tools} from "../src/runtime/secretaryThings3Tools.js";
beforeAll(()=>{migrate();runMigrations();seedRoleAccounts(db);});
const decode=(r:any)=>JSON.parse(r.content[0].text);
/** Живая сессия в тесте: активный набор видят и загрузчик, и обработчик. */
function fakeSession(){
 let active:string[]=[];
 return {
  getActiveToolNames:()=>[...active],
  setActiveToolsByName:(names:string[])=>{active=[...new Set(names)];},
  names:()=>[...active],
 };
}
/** Операция в реестре роли, но не в активном наборе (ядро + загрузчик). */
const inactiveTarget=(catalog:any)=>catalog.registeredNames.find((name:string)=>name!=="taskflow_tools"&&!catalog.activeNames.includes(name))!;
it("every configured role exposes native schemas from the common registry in chat/work/discussion",()=>{
 for(const role of allRoles()){
  const make=(mode:string,extra:any={})=>buildRoleToolCatalog({role:role.key,mode,runId:"test",...extra});
  const chat=make("work",{chatId:"chat",messageId:"msg"});
  const work=make("work",{taskId:"task",subtaskId:"slot"});
  const discussion=make("discussion",{taskId:"task",subtaskId:"slot",chatId:"chat",messageId:"msg"});
  for(const c of [chat,work,discussion]){
   expect(c.activeNames).not.toContain("taskflow");
   // Активно ядро и загрузчик; полный каталог живёт в реестре и подключается
   // по требованию (setActiveToolsByName) — в каждый запрос он не уходит.
   expect(c.activeNames).toContain("taskflow_tools");
   expect(c.activeNames.length).toBeLessThan(c.registeredNames.length);
   expect(c.registeredNames).toEqual(c.customTools.filter(t=>t.name!=="taskflow").map(t=>t.name));
   expect(new Set(c.operations.map(t=>t.name)).size).toBe(c.operations.length);
  }
  expect(chat.operations.map(t=>t.name)).toEqual(work.operations.map(t=>t.name));
 }
});
it("secretary chat keeps each Things 3 operation once alongside the rest of her catalog",()=>{
 const things3=secretaryThings3Tools({role:"secretary",chatId:"chat",messageId:"message"});
 const chat=buildRoleToolCatalog({role:"secretary",mode:"work",runId:"test",chatId:"chat",messageId:"message"},things3);
 expect(chat.operations.filter(t=>t.name==="things_complete")).toHaveLength(1);
 expect(chat.operations.some(t=>t.name==="taskflow_task")).toBe(true);
 const work=buildRoleToolCatalog({role:"secretary",mode:"work",runId:"test",taskId:"task"});
 expect(work.operations.filter(t=>t.name==="things_complete")).toHaveLength(1);
 expect(work.operations.some(t=>t.name==="taskflow_things3")).toBe(false);
});
it("secretary cannot start card work from chat execution mode",async()=>{
 const c=buildRoleToolCatalog({role:"secretary",mode:"work",runId:"test",chatId:"chat",messageId:"msg"});
 const result=decode(await c.customTools[0].execute("x",{action:"invoke",operation:"taskflow_plan_request",version:1,arguments:{}}));
 expect(result.ok).toBe(false);
 expect(result.error.code).toBe("EXECUTION_MODE_RESTRICTED");
});
it("missing message context is explained rather than silently removing attachment support",async()=>{
 const c=buildRoleToolCatalog({role:"builder",mode:"work",runId:"test",taskId:"task"});
 const result=decode(await c.customTools[0].execute("x",{action:"describe",operation:"taskflow_chat_attach_file"}));
 expect(result.data.restriction.code).toBe("CONTEXT_REQUIRED");
});
it("отказ «инструмент не подключён» не роняет ход и пишет отдельный код аудита",()=>{
 const catalog=buildRoleToolCatalog({role:"builder",mode:"work",runId:"not-connected"});
 const target=inactiveTarget(catalog);
 const before=db.prepare("SELECT COUNT(*) AS n FROM role_tool_audit WHERE error_code='TOOL_NOT_CONNECTED'").get() as {n:number};
 // Pi отвечает «Tool X not found», когда операция не подключена к сессии.
 const stopped=catalog.onToolExecutionEnd({type:"tool_execution_end",toolCallId:"missing-1",toolName:target,isError:true,result:{content:[{type:"text",text:`Tool ${target} not found`}]}});
 expect(stopped).toBe(false);
 const rows=db.prepare("SELECT operation FROM role_tool_audit WHERE error_code='TOOL_NOT_CONNECTED' ORDER BY rowid DESC").all() as any[];
 expect(rows.length).toBe(before.n+1);
 expect(rows[0].operation).toBe(target);
 // Неверным вызовом это не считается — иначе три отказа роняли ход роли.
 const invalid=db.prepare("SELECT COUNT(*) AS n FROM role_tool_audit WHERE run_id='not-connected' AND error_code='INVALID_ARGUMENTS'").get() as {n:number};
 expect(invalid.n).toBe(0);
});
it("автоподключение возвращает операцию в активный набор",()=>{
 const catalog=buildRoleToolCatalog({role:"builder",mode:"work",runId:"auto-connect"});
 const target=inactiveTarget(catalog);
 const session=fakeSession();
 catalog.attachSession(session);
 catalog.onToolExecutionEnd({type:"tool_execution_end",toolCallId:"missing-2",toolName:target,isError:true,result:{content:[{type:"text",text:`Tool ${target} not found`}]}});
 expect(session.names()).toContain(target);
});
it("подключённая по требованию операция снова активна в новом ходе",()=>{
 const first=buildRoleToolCatalog({role:"builder",mode:"work",runId:"turn-1",chatId:"chat-on-demand",messageId:"msg"});
 const target=inactiveTarget(first);
 const session=fakeSession();
 first.attachSession(session);
 first.onToolExecutionEnd({type:"tool_execution_end",toolCallId:"missing-3",toolName:target,isError:true,result:{content:[{type:"text",text:`Tool ${target} not found`}]}});
 // Новый ход — новая сессия Pi и новый каталог той же роли и чата.
 const next=buildRoleToolCatalog({role:"builder",mode:"work",runId:"turn-2",chatId:"chat-on-demand",messageId:"msg"});
 const nextSession=fakeSession();
 installNativeToolCore(nextSession,next,[]);
 expect(nextSession.names()).toContain(target);
});
it("one adapter appears through the same catalog in every entry point",async()=>{
 const execute=vi.fn(async()=>({content:[{type:"text",text:"status"}]}));
 for(const mode of ["work","discussion","plan"]){
  const c=buildRoleToolCatalog({role:"infra_engineer",mode,runId:"test"},[{name:"mcp__infra__probe",description:"infra status",parameters:{type:"object"},execute}]);
  const result=decode(await c.customTools[0].execute("x",{action:"invoke",operation:"mcp__infra__probe",version:1,arguments:{}}));
  expect(result.ok).toBe(true);
 }
 expect(execute).toHaveBeenCalledTimes(3);
});
