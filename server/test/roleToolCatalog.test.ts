import {beforeAll,it,expect,vi} from "vitest";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {allRoles} from "../src/roleRouting.js";
import {buildRoleToolCatalog} from "../src/runtime/roleToolCatalog.js";
import {secretaryThings3Tools} from "../src/runtime/secretaryThings3Tools.js";
beforeAll(()=>{migrate();runMigrations();seedRoleAccounts(db);});
const decode=(r:any)=>JSON.parse(r.content[0].text);
it("every configured role uses one active tool with a unique common registry in chat/work/discussion",()=>{
 for(const role of allRoles()){
  const make=(mode:string,extra:any={})=>buildRoleToolCatalog({role:role.key,mode,runId:"test",...extra});
  const chat=make("work",{chatId:"chat",messageId:"msg"});
  const work=make("work",{taskId:"task",subtaskId:"slot"});
  const discussion=make("discussion",{taskId:"task",subtaskId:"slot",chatId:"chat",messageId:"msg"});
  for(const c of [chat,work,discussion]){
   expect(c.activeNames).toEqual(["taskflow"]);
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
it("secretary cannot regain plan_request through chat additions",async()=>{
 const c=buildRoleToolCatalog({role:"secretary",mode:"work",runId:"test",chatId:"chat",messageId:"msg"});
 const result=decode(await c.customTools[0].execute("x",{action:"invoke",operation:"taskflow_plan_request",version:1,arguments:{}}));
 expect(result.error.code).toBe("FORBIDDEN");
});
it("missing message context is explained rather than silently removing attachment support",async()=>{
 const c=buildRoleToolCatalog({role:"builder",mode:"work",runId:"test",taskId:"task"});
 const result=decode(await c.customTools[0].execute("x",{action:"describe",operation:"taskflow_chat_attach_file"}));
 expect(result.data.restriction.code).toBe("CONTEXT_REQUIRED");
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
