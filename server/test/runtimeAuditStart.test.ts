import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const state=vi.hoisted(()=>({prepare:vi.fn(async()=>({prompt:"fixture",summary:"fixture"})),sessions:0}));
vi.mock("../src/runtime/composioRuntime.js",()=>({connectRoleComposio:async()=>({tools:[],close:async()=>{}})}));
vi.mock("../src/runtime/graftMcp.js",()=>({connectRoleMcp:async()=>({tools:[],close:async()=>{}})}));
vi.mock("../src/runtime/taskContextBridge.js",()=>({buildInProcessTaskContext:state.prepare}));
vi.mock("../src/runtime/roleHost.js",async orig=>({...await orig<any>(),resolveRoleHost:()=>null}));
vi.mock("../src/runtime/PiRuntimeAdapter.js",async orig=>({...await orig<any>(),getModelRuntime:async()=>({getModel:(_p:string,id:string)=>({id,provider:"fixture"})})}));
vi.mock("@earendil-works/pi-coding-agent",async orig=>({...await orig<any>(),createAgentSession:async()=>{
 state.sessions++;
 return {session:{state:{messages:[{role:"assistant",content:[{type:"text",text:"Fixture answer"}],stopReason:"stop"}]},subscribe:()=>()=>{},prompt:async()=>{},abort:async()=>{},dispose:()=>{}}};
}}));
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {runRoleInProcess,_settleInProcessRunsForTests} from "../src/runtime/inProcessRun.js";
let app:any;
beforeAll(async()=>{app=await buildApp();seedRoleAccounts(db);
 db.prepare("INSERT INTO tasks(id,title,status,assignee_id,dispatched_role) VALUES ('audit-start','fixture','active','role_builder','builder')").run();
});
afterAll(async()=>{await _settleInProcessRunsForTests();await app?.close();});
describe("runtime audit: startup ownership",()=>{
 it("reserves a task before asynchronous preparation so concurrent starts cannot create two sessions",async()=>{
   let unblock!:()=>void,entered!:()=>void;
   const gate=new Promise<void>(r=>unblock=r),ready=new Promise<void>(r=>entered=r);
   state.prepare.mockImplementation(async()=>{entered();await gate;return {prompt:"fixture",summary:"fixture"};});
   const first=runRoleInProcess({taskId:"audit-start",role:"builder",mode:"reply"});
   await ready;
   const second=runRoleInProcess({taskId:"audit-start",role:"builder",mode:"reply"}).then(value=>({value,error:null}),error=>({value:null,error}));
   unblock();
   const a=await first;await a.completion;
   const b=await second;if(b.value)await b.value.completion;
   expect(b.error).toBeTruthy();
   expect(state.sessions).toBe(1);
 });
 it("releases the startup reservation when preparation fails",async()=>{
   state.prepare.mockRejectedValueOnce(new Error("fixture preparation failure"));
   await expect(runRoleInProcess({taskId:"audit-start",role:"builder",mode:"reply"})).rejects.toThrow("fixture preparation failure");
   state.prepare.mockResolvedValue({prompt:"fixture",summary:"fixture"});
   const next=await runRoleInProcess({taskId:"audit-start",role:"builder",mode:"reply"});
   await next.completion;
 });
 it("does not steal the slot while its first session is still preparing",async()=>{
   db.prepare("INSERT INTO subtasks(id,task_id,title) VALUES ('audit-start-slot','audit-start','fixture')").run();
   const previousWait=process.env.TASKFLOW_SLOT_LEASE_WAIT_MS;
   process.env.TASKFLOW_SLOT_LEASE_WAIT_MS="20";
   let unblock!:()=>void,entered!:()=>void;
   const gate=new Promise<void>(r=>unblock=r),ready=new Promise<void>(r=>entered=r);
   state.prepare.mockClear();
   state.prepare.mockImplementation(async()=>{entered();await gate;return {prompt:"fixture",summary:"fixture"};});
   const input={taskId:"audit-start",subtaskId:"audit-start-slot",role:"builder",mode:"reply" as const};
   const first=runRoleInProcess(input);
   await ready;
   const second=runRoleInProcess(input).then(value=>({value,error:null}),error=>({value:null,error}));
   await new Promise(r=>setTimeout(r,80));
   const duringPreparation=state.prepare.mock.calls.length;
   unblock();
   try {
     const a=await first;await a.completion;
     const b=await second;if(b.value)await b.value.completion;
     expect(duringPreparation).toBe(1);
   } finally {
     if(previousWait===undefined)delete process.env.TASKFLOW_SLOT_LEASE_WAIT_MS;
     else process.env.TASKFLOW_SLOT_LEASE_WAIT_MS=previousWait;
   }
 });

 it("does not launch a role when its card is archived during preparation",async()=>{
   db.prepare("INSERT INTO tasks(id,title,status,assignee_id) VALUES ('audit-archived-start','fixture','active','role_builder')").run();
   let unblock!:()=>void,entered!:()=>void;
   const gate=new Promise<void>(r=>unblock=r),ready=new Promise<void>(r=>entered=r);
   state.prepare.mockImplementation(async()=>{entered();await gate;return {prompt:"fixture",summary:"fixture"};});
   const started=runRoleInProcess({taskId:"audit-archived-start",role:"builder",mode:"reply"})
     .then(value=>({value,error:null}),error=>({value:null,error}));
   await ready;
   db.prepare("UPDATE tasks SET archived_at=datetime('now') WHERE id='audit-archived-start'").run();
   unblock();
   const result=await started;if(result.value)await result.value.completion;
   expect(result.error).toBeTruthy();
 });

});
