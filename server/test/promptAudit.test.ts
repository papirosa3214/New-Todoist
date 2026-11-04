import {it,expect,vi} from "vitest";
import {mkdtempSync,readFileSync,readdirSync,rmSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {recordPromptAudit} from "../src/runtime/promptAudit.js";
it("records ordered full context, deduplicates objects, and protects files",()=>{
 const dir=mkdtempSync(join(tmpdir(),"prompt-audit-"));
 try {
  const context={systemPrompt:"SYSTEM then AGENTS then ROLE",messages:[{role:"user",content:"first"},{role:"assistant",content:"reply"}],tools:[{name:"read"}]};
  recordPromptAudit({role:"secretary",call_id:"one",phase:"context",content:context},dir);
  recordPromptAudit({role:"secretary",call_id:"two",phase:"context",content:context},dir);
  const objects=readdirSync(join(dir,"objects"));expect(objects).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir,"objects",objects[0]),"utf8"))).toEqual(context);
  expect(statSync(join(dir,"objects",objects[0])).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir,"latest.md"),"utf8")).toContain("SYSTEM then AGENTS then ROLE");
  const journal=readdirSync(dir).find(x=>x.endsWith(".jsonl"))!;
  expect(readFileSync(join(dir,journal),"utf8").trim().split("\n")).toHaveLength(2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it("never records other roles or credentials in structured fields",()=>{
 const dir=mkdtempSync(join(tmpdir(),"prompt-audit-"));
 try{
  recordPromptAudit({role:"builder",call_id:"x",phase:"context",content:{text:"other"}},dir);
  expect(readdirSync(dir)).toHaveLength(0);
  recordPromptAudit({role:"secretary",call_id:"x",phase:"payload",content:{apiKey:"SECRET",headers:{authorization:"SECRET"},messages:[{role:"user",content:"keep text"}]}},dir);
  const text=readFileSync(join(dir,"latest.md"),"utf8");expect(text).not.toContain("SECRET");expect(text).toContain("keep text");
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it("captures each context and final replacement payload at the diagnostics boundary",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"audit-boundary-"));
 const {installProviderDiagnostics,registerProviderSession}=await import("../src/runtime/providerDiagnostics.js");
 let options:any;
 const runtime:any={stream:(_m:any,_c:any,o:any)=>{options=o;return {result:()=>Promise.resolve({content:[]})};}};
 vi.stubEnv("VITEST", "");vi.stubEnv("TASKFLOW_PROMPT_AUDIT_DIR",dir);
 try{
  registerProviderSession("audit-boundary",{role:"secretary"});
  installProviderDiagnostics(runtime,{emit:()=>{}});
  runtime.stream({id:"m",provider:"p"},{messages:[{role:"system",content:"ordered instructions"}]},{sessionId:"audit-boundary",onPayload:()=>({messages:["final replacement"]})});
  expect(await options.onPayload({messages:["original"]},{})).toEqual({messages:["final replacement"]});
  const journal=readdirSync(dir).find(x=>x.endsWith(".jsonl"))!;
  const entries=readFileSync(join(dir,journal),"utf8").trim().split("\n").map(x=>JSON.parse(x));
  expect(entries.map(e=>e.phase)).toEqual(["context","payload"]);
  expect(readFileSync(join(dir,entries[1].object),"utf8")).toContain("final replacement");
 }finally{vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});}
});
