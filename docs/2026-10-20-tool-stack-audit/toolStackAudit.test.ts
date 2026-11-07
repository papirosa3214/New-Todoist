import {beforeAll,it,expect,vi} from "vitest";
import fs from "node:fs";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {allRoles,refreshRoles} from "../src/roleRouting.js";
import {buildRoleToolCatalog} from "../src/runtime/roleToolCatalog.js";
import {createHostRoleTools} from "../src/runtime/hostRoleTools.js";
import {Check,Errors} from "typebox/value";
import {voiceToolManifest,runVoiceTool} from "../src/lib/secretaryVoiceTools.js";
import {isReadOperation} from "../src/runtime/universalTaskflow.js";
beforeAll(()=>{migrate();runMigrations();seedRoleAccounts(db);
 const liveRoles=JSON.parse(fs.readFileSync("../docs/2026-10-20-tool-stack-audit/live-roles.json","utf8"));
 for(const r of liveRoles)db.prepare("INSERT OR REPLACE INTO roles(key,title,summary,enabled,position,runtime) VALUES(?,?,?,?,?,?)").run(r.key,r.title,r.summary,r.enabled,r.position,r.runtime);
 refreshRoles();});
const decode=(r:any)=>JSON.parse(r.content[0].text);
it("inventories every role/entry/schema/template without invoking mutations",async()=>{
 const rows:any[]=[];const schemaErrors:any[]=[];const opMap=new Map<string,any>();
 for(const role of allRoles()){
  for(const entry of ["chat","work","work-host","discussion","plan"]){
   const c=buildRoleToolCatalog({role:role.key,mode:entry==="plan"?"plan":entry==="discussion"?"discussion":"work",runId:"audit",...(entry.startsWith("work")?{taskId:"audit-task",subtaskId:"audit-slot"}:{chatId:"audit-chat",messageId:"audit-message"})},entry==="work-host"?createHostRoleTools("audit-machine","audit-task",role.key):[]);
   const api=c.customTools[0];
   const visible:any[]=[];
   for(let offset=0;;offset+=20){
    const r=decode(await api.execute("catalog",{action:"discover",offset,limit:20}));
    expect(r.ok).toBe(true);visible.push(...r.data.operations);
    if(r.data.next_offset===null)break;
   }
   const described:any[]=[];
   for(const operation of visible){
    const r=decode(await api.execute("schema",{action:"describe",operation:operation.operation}));
    if(!r.ok){schemaErrors.push({role:role.key,entry,operation:operation.operation,error:r.error});continue;}
    try{Check(r.data.inputSchema,{});}catch(e){schemaErrors.push({role:role.key,entry,operation:operation.operation,error:String(e)});}
    const tool=c.operations.find(t=>t.name===operation.operation)!;
    let templateValid=false;let errors:any[]=[];
    try{templateValid=Check(tool.parameters,r.data.invokeTemplate.arguments);if(!templateValid)errors=[...Errors(tool.parameters,r.data.invokeTemplate.arguments)].slice(0,3);}catch(e){errors=[String(e)];}
    described.push({operation:operation.operation,available:operation.available,restriction:operation.restriction,templateValid,templateErrors:errors});
    if(!opMap.has(operation.operation))opMap.set(operation.operation,{name:operation.operation,effects:isReadOperation(operation.operation)?"read":"write",schema:JSON.parse(JSON.stringify(tool.parameters)),description:tool.description});
   }
   rows.push({role:role.key,entry,activeNames:c.activeNames,registered:c.operations.length,visible:visible.length,available:visible.filter(t=>t.available).length,operations:described});
  }
 }
 const manifest=await voiceToolManifest();
 const voiceSchemas:any[]=[];
 const c=buildRoleToolCatalog({role:"secretary",mode:"work",runId:"audit"});
 for(const op of c.operations){
  const r=await runVoiceTool("u-secretary","taskflow",{action:"describe",operation:op.name});
  const envelope=JSON.parse(r.result);
  voiceSchemas.push({operation:op.name,ok:envelope.ok,available:envelope.data?.available,error:envelope.error});
 }
 const result={rows,operations:[...opMap.values()],schemaErrors,voiceManifest:manifest,voiceSchemas};
 fs.writeFileSync("../docs/2026-10-20-tool-stack-audit/catalog.json",JSON.stringify(result,null,2));
 expect(schemaErrors).toEqual([]);
});


it("cancellation reaches the host bash gateway",async()=>{
 const gateway=await import("../src/host/gateway.js");
 const {hostBashOperations}=await import("../src/runtime/hostOperations.js");
 const spy=vi.spyOn(gateway,"runOperation").mockResolvedValue({ok:true,exitCode:0} as any);
 try{
  const controller=new AbortController();
  await hostBashOperations("audit-machine","/tmp").exec("true","/tmp",{signal:controller.signal,onData:()=>{}});
  const forwarded=(spy.mock.calls[0][3] as any)?.signal===controller.signal;
  fs.writeFileSync("../docs/2026-10-20-tool-stack-audit/cancellation.json",JSON.stringify({expectedSignal:true,forwarded,forwardedKeys:Object.keys(spy.mock.calls[0][3]??{})},null,2));
  expect(forwarded).toBe(true);
 }finally{spy.mockRestore();}
});

it("failed host push is not reported as succeeded",async()=>{
 const gateway=await import("../src/host/gateway.js");
 const workspace=await import("../src/runtime/roleWorkspace.js");
 const {createUniversalTaskflow}=await import("../src/runtime/universalTaskflow.js");
 const repo=vi.spyOn(workspace,"hostRepoPath").mockReturnValue("/audit-repo");
 const operation=vi.spyOn(gateway,"runOperation").mockResolvedValue({ok:false,error:"audit remote unavailable"} as any);
 try{
  const push=createHostRoleTools("audit-machine","audit-task","builder").find(t=>t.name==="taskflow_host_push")!;
  const api=createUniversalTaskflow([push],{actor:"role_builder",role:"builder",mode:"work",runId:"audit"});
  const envelope=decode(await api.execute("push",{action:"invoke",operation:push.name,version:1,request_id:"audit-push",arguments:{}}));
  fs.writeFileSync("../docs/2026-10-20-tool-stack-audit/push-error.json",JSON.stringify(envelope,null,2));
  expect(envelope.ok).toBe(false);
 }finally{operation.mockRestore();repo.mockRestore();}
});
