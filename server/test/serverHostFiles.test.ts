import {beforeEach,afterEach,describe,expect,it,vi} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createCodingTools,createReadOnlyTools} from "@earendil-works/pi-coding-agent";
import {ls} from "../../host/src/operations/ls.js";
import {read} from "../../host/src/operations/read.js";
import {write} from "../../host/src/operations/write.js";
import {find} from "../../host/src/operations/find.js";
import {grep} from "../../host/src/operations/grep.js";
const state=vi.hoisted(()=>({actual:"",remote:"/remote-taskflow-fixture",calls:[] as string[],signals:[] as Array<AbortSignal|undefined>}));
vi.mock("../src/host/gateway.js",()=>({runOperation:async(_machine:string,op:string,args:any,options?:any)=>{
 state.calls.push(op);state.signals.push(options?.signal);
 if(op==="bash" && args.command.startsWith("test -f ")) {
  const result=spawnSync("/bin/sh",["-c",args.command.replaceAll(state.remote,state.actual)],{cwd:state.actual});
  return {ok:true,exitCode:result.status};
 }
 const translated={...args,path:typeof args.path==="string"?args.path.replace(state.remote,state.actual):args.path};
 const ops:any={ls,read,write,find,grep};
 try{
  const data=await ops[op](translated,{roots:[state.actual],worktreesBase:state.actual,limits:{bashTimeoutMs:1000,bashOutputLimitBytes:4*1024*1024},signal:options?.signal??new AbortController().signal,emit:()=>{},now:()=>Date.now()});
  return {ok:true,data:JSON.parse(JSON.stringify(data).replaceAll(state.actual,state.remote))};
 }catch(error:any){return {ok:false,error:error.message,code:error.code};}
}}));
import {hostOperations,withHostToolExecution} from "../src/runtime/hostOperations.js";
function tools(){
 const o=hostOperations("fixture",state.remote);
 const opts={bash:{operations:o.bash},read:{operations:o.read},write:{operations:o.write},edit:{operations:o.edit},grep:{operations:o.grep},find:{operations:o.find},ls:{operations:o.ls}};
 return withHostToolExecution("fixture",state.remote,[...createCodingTools(state.remote,opts),...createReadOnlyTools(state.remote,opts)]);
}
const call=async(name:string,args:any)=>tools().find(t=>t.name===name)!.execute("fixture",args);
const text=(out:any)=>out.content.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");
beforeEach(async()=>{
 state.actual=await fs.mkdtemp(path.join(os.tmpdir(),"taskflow-host-files-"));state.calls=[];state.signals=[];
 await fs.mkdir(path.join(state.actual,"child"));
 await fs.writeFile(path.join(state.actual,"alpha.txt"),"before\nNeedle.a\nafter\n");
 await fs.writeFile(path.join(state.actual,"beta.log"),"Needle.a\n");
 await fs.writeFile(path.join(state.actual,"child","nested.txt"),"needle.a\n");
});
afterEach(async()=>fs.rm(state.actual,{recursive:true,force:true}));
describe("server SDK to host file contract",()=>{
 it("writes a nested new file through the real SDK and host write operation",async()=>{
  await call("write",{path:"new/nested.txt",content:"created"});
  expect(await fs.readFile(path.join(state.actual,"new/nested.txt"),"utf8")).toBe("created");
 });
 it("lists files alongside directories instead of silently dropping files",async()=>{
  const out=text(await call("ls",{path:"."}));
  expect(out).toContain("alpha.txt");expect(out).toContain("beta.log");expect(out).toContain("child/");
 });
 it("returns matching path strings for SDK find instead of host entry objects",async()=>{
  const out=text(await call("find",{path:".",pattern:"**/*.txt"}));
  expect(out).toContain("alpha.txt");expect(out).toContain("child/nested.txt");expect(out).not.toContain("beta.log");
 });
 it("runs directory grep on the host with glob, case and literal semantics",async()=>{
  const out=text(await call("grep",{path:".",pattern:"needle.a",ignoreCase:true,literal:true,glob:"*.txt"}));
  expect(out).toContain("alpha.txt");expect(out).toContain("child/nested.txt");expect(out).not.toContain("beta.log");
  expect(state.calls).toContain("grep");
 });
 it("searches one remote file and returns its surrounding context",async()=>{
  const out=text(await call("grep",{path:"alpha.txt",pattern:"Needle.a",literal:true,context:1}));
  expect(out).toContain("before");expect(out).toContain("Needle.a");expect(out).toContain("after");
 });
 it("forwards each SDK invocation signal through asynchronous file operations",async()=>{
  const a=new AbortController(),b=new AbortController();
  await Promise.all([
   tools().find(t=>t.name==="ls")!.execute("a",{path:"."},a.signal),
   tools().find(t=>t.name==="find")!.execute("b",{path:".",pattern:"*.txt"},b.signal),
  ]);
  expect(state.signals).toContain(a.signal);expect(state.signals).toContain(b.signal);
  expect(state.signals.every(s=>s===a.signal||s===b.signal)).toBe(true);
 });
 it("rejects an already cancelled file invocation before any host operation",async()=>{
  const controller=new AbortController();controller.abort();
  await expect((async()=>tools().find(t=>t.name==="write")!.execute("cancel",{path:"cancel.txt",content:"no"},controller.signal))()).rejects.toBeTruthy();
  expect(state.calls).toEqual([]);
 });
 it("honors literal matching, an empty result and grep output limits",async()=>{
  await fs.writeFile(path.join(state.actual,"child","regex.txt"),"needleXa\n");
  const literal=text(await call("grep",{path:".",pattern:"needle.a",literal:true,ignoreCase:true}));
  expect(literal).not.toContain("regex.txt");
  expect(text(await call("grep",{path:".",pattern:"no-such-fixture"}))).toContain("No matches found");
  const limited=await call("grep",{path:".",pattern:"needle",ignoreCase:true,limit:1});
  expect(limited.details.matchLimitReached).toBe(1);
 });

 it("reads and edits remote content through SDK without using a local path",async()=>{
  expect(text(await call("read",{path:"alpha.txt"}))).toContain("Needle.a");
  await call("edit",{path:"alpha.txt",edits:[{oldText:"Needle.a",newText:"Changed"}]});
  expect(await fs.readFile(path.join(state.actual,"alpha.txt"),"utf8")).toBe("before\nChanged\nafter\n");
 });
 it("overwrites an existing remote file without disturbing its directory",async()=>{
  await call("write",{path:"alpha.txt",content:"replacement"});
  expect(await fs.readFile(path.join(state.actual,"alpha.txt"),"utf8")).toBe("replacement");
  expect((await fs.stat(state.actual)).isDirectory()).toBe(true);
 });

});
