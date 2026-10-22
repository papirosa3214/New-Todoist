import {beforeAll,afterAll,describe,expect,it,vi} from "vitest";
import {Type} from "typebox";
import {createUniversalTaskflow} from "../src/runtime/universalTaskflow.js";
import {actionTurnHandler} from "../src/runtime/externalAgentActions.js";
import {buildApp} from "../src/index.js";
import {taskflowTools} from "../src/runtime/inProcessRun.js";
import db from "../src/db.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
let app:any;
beforeAll(async()=>{app=await buildApp();seedRoleAccounts(db);});
afterAll(async()=>{await app?.close();});
describe("runtime audit: real adapter and external turn results",()=>{
 it("uses separate gateway request identities for different external turns",async()=>{
  const writes:string[]=[];
  const op={name:"fixture_write",description:"fixture",parameters:Type.Object({text:Type.String()}),execute:vi.fn(async(_id:string,args:any)=>{writes.push(args.text);return {content:[{type:"text",text:"saved"}]};})};
  const gateway=createUniversalTaskflow([op],{actor:"role_builder",role:"builder",mode:"work",runId:"external-audit"});
  const alias={name:op.name,execute:async(id:string,args:any)=>gateway.execute(id,{operation:op.name,arguments:args})};
  const handler=actionTurnHandler([alias],"session-audit");
  const block=(text:string)=>"```taskflow-actions\n"+JSON.stringify([{operation:op.name,arguments:{text}}])+"\n```";
  await handler(block("first"));
  await handler(block("second"));
  expect(writes).toEqual(["first","second"]);
 });
 it("preserves a real route refusal as REJECTED rather than unknown outcome",async()=>{
   const comment=taskflowTools("builder",null).find(t=>t.name==="taskflow_comment")!;
   const gateway=createUniversalTaskflow([comment],{actor:"role_builder",role:"builder",mode:"work",runId:"real-refusal"});
   const out=await gateway.execute("missing",{operation:comment.name,arguments:{id:"fixture-missing-task",text:"fixture"}});
   const env=JSON.parse(out.content[0].text);
   expect(env.error.code).toBe("REJECTED");
 });
});
