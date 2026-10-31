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
it("отказ самого сервера (уточнение посреди хода, режим планирования) не считается неверным вызовом",()=>{
 const catalog=buildRoleToolCatalog({role:"builder",mode:"work",runId:"server-refusal"});
 const target=catalog.registeredNames.find((name:string)=>name!=="taskflow_tools")!;
 const reasons=[
  "Действие не начато: поступило уточнение. Сначала учти новое сообщение, затем заново выбери нужные действия.",
  "Планирование: разрешены только инструменты чтения. Для выполнения выберите режим Работа.",
 ];
 for(let i=0;i<4;i++){
  const text=reasons[i%2];
  expect(catalog.onToolExecutionEnd({type:"tool_execution_end",toolCallId:"refused-"+i,toolName:target,isError:true,result:{content:[{type:"text",text}]}})).toBe(false);
 }
 const invalid=db.prepare("SELECT COUNT(*) AS n FROM role_tool_audit WHERE run_id=? AND error_code=?").get("server-refusal","INVALID_ARGUMENTS") as {n:number};
 expect(invalid.n).toBe(0);
 // P0 карточки e73e7314: отказ сервера остаётся в учёте, но своим кодом —
 // по нему видно, что роль ждала зря, и что аргументы тут ни при чём.
 const codes=db.prepare("SELECT error_code, COUNT(*) AS n FROM role_tool_audit WHERE run_id=? GROUP BY error_code").all("server-refusal") as Array<{error_code:string;n:number}>;
 const codeOf=(c:string)=>codes.find(r=>r.error_code===c)?.n ?? 0;
 expect(codeOf("STEERING_REFUSAL")).toBe(2);
 expect(codeOf("PLANNING_REFUSAL")).toBe(2);
});
it("действие в чате пишется событием с областью chat и id чата",async()=>{
 const c=buildRoleToolCatalog({role:"builder",mode:"work",runId:"chat-action",chatId:"chat-x",messageId:"msg-x"});
 const out=(await c.customTools[0].execute("e",{action:"invoke",operation:"taskflow_plan_read",version:1,arguments:{}})) as any;
 expect(out).toBeTruthy();
 const rows=db.prepare("SELECT scope, item_id, outcome FROM role_tool_audit WHERE run_id=? ORDER BY rowid DESC LIMIT 1").get("chat-action") as any;
 expect(rows.scope).toBe("chat");
 expect(rows.item_id).toBe("chat-x");
 // Исход любой (в чате операция может быть ограничена режимом) — важно, что
 // событие действия есть и у чата: раньше чатовые действия не имели ни
 // области, ни элемента, и метрика по ним не считалась.
 expect(["ok","error","repaired"]).toContain(rows.outcome);
});
it("успешное действие роли пишет событие с областью, элементом и длительностью",async()=>{
 const c=buildRoleToolCatalog({role:"builder",mode:"work",runId:"action-event",taskId:"task-ae",subtaskId:"slot-ae"});
 const rules=c.customTools.find((t:any)=>t.name==="taskflow_rules");
 expect(rules).toBeTruthy();
 await (rules as any).execute("call-ae",{});
 const row=db.prepare("SELECT scope, item_id, outcome, error_code, duration_ms FROM role_tool_audit WHERE run_id=? ORDER BY rowid DESC LIMIT 1").get("action-event") as any;
 expect(row.outcome).toBe("ok");
 expect(row.error_code).toBeNull();
 expect(row.scope).toBe("task");
 expect(row.item_id).toBe("slot-ae");
 expect(typeof row.duration_ms).toBe("number");
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
