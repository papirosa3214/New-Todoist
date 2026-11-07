import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
const state=vi.hoisted(()=>({run:vi.fn(),host:vi.fn(()=>"fixture-machine"),repo:vi.fn(()=>"/fixture/repo")}));
vi.mock("../src/host/gateway.js",async orig=>({...await orig<any>(),runOperation:state.run}));
vi.mock("../src/runtime/roleHost.js",async orig=>({...await orig<any>(),resolveRoleHost:state.host}));
vi.mock("../src/runtime/roleWorkspace.js",async orig=>({...await orig<any>(),hostRepoPath:state.repo}));
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {createHostRoleTools} from "../src/runtime/hostRoleTools.js";
import {toolRequestStore} from "../src/runtime/toolRequestStore.js";
import { createUniversalTaskflow } from "../src/runtime/universalTaskflow.js";
import { hostBashOperations } from "../src/runtime/hostOperations.js";

beforeAll(()=>{migrate();runMigrations();seedRoleAccounts(db);
 db.prepare("INSERT INTO tasks(id,title,assignee_id,dispatched_role) VALUES ('audit-push','fixture','role_builder','builder')").run();
});
beforeEach(()=>state.run.mockReset());
const decode=(r:any)=>JSON.parse(r.content[0].text);
describe("runtime audit: cancellation across gateway boundaries",()=>{
 it("does not execute a write when the SDK signal is already aborted",async()=>{
   const execute=vi.fn(async()=>({content:[{type:"text",text:"written"}]}));
   const gateway=createUniversalTaskflow([{name:"fixture_write",description:"fixture",parameters:Type.Object({}),execute}],{actor:"role_builder",role:"builder",mode:"work",runId:"audit"},toolRequestStore);
   const controller=new AbortController();controller.abort();
   const out=await gateway.execute("cancelled",{operation:"fixture_write",arguments:{}},controller.signal);
   expect(execute).not.toHaveBeenCalled();
   expect(decode(out).ok).toBe(false);
   expect(toolRequestStore.get("role_builder","audit:cancelled")).toBeUndefined();
   const retried=await gateway.execute("cancelled",{operation:"fixture_write",arguments:{}});
   expect(decode(retried).ok).toBe(true);
   expect(toolRequestStore.get("role_builder","audit:cancelled")?.state).toBe("succeeded");
 });
 it("passes the SDK cancellation signal to the host operation",async()=>{
   state.run.mockResolvedValue({ok:true,exitCode:0});
   const controller=new AbortController();
   await hostBashOperations("fixture","/fixture").exec("fixture","/fixture",{onData:()=>{},signal:controller.signal});
   expect(state.run.mock.calls[0][3].signal).toBe(controller.signal);
 });
 it("does not record a failed host push as a succeeded gateway request",async()=>{
   state.run.mockResolvedValue({ok:false,error:"fixture remote rejected"});
   const tools=createHostRoleTools("builder","audit-push");
   const gateway=createUniversalTaskflow(tools,{actor:"role_builder",role:"builder",mode:"work",runId:"audit-push",taskId:"audit-push"},toolRequestStore);
   const out=await gateway.execute("push",{operation:"taskflow_host_push",arguments:{}});
   expect(decode(out).ok).toBe(false);
   const saved=toolRequestStore.get("role_builder","audit-push:push");
   expect(saved?.state).toBe("unknown_outcome");
   expect(JSON.parse(saved?.result.content[0].text).ok).toBe(false);
   const replay=await gateway.execute("push",{operation:"taskflow_host_push",arguments:{}});
   expect(decode(replay).ok).toBe(false);
   expect(state.run).toHaveBeenCalledTimes(2);
 });

});
