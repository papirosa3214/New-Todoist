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

// Владелец 11.11.2026: «журналы всем поставь, чтобы я видел, какой контекст им идёт».
it("keeps a readable digest of every role request: system text, tools and attached turn",async()=>{
 const {extractRequestContext,checkPromptContextInstrument}=await import("../src/runtime/promptAudit.js");
 const dir=mkdtempSync(join(tmpdir(),"prompt-digest-"));
 try{
  const anthropic={system:[{type:"text",text:"BUILDER SYSTEM"}],tools:[{name:"read"},{name:"taskflow_docs"}],
   messages:[{role:"user",content:[{type:"text",text:"CLOCK + HISTORY + owner text"}]},{role:"assistant",content:[{type:"tool_use",id:"t",name:"read",input:{}}]},
    {role:"user",content:[{type:"tool_result",tool_use_id:"t",content:"file body"}]}]};
  expect(extractRequestContext(anthropic)).toMatchObject({system:"BUILDER SYSTEM",tools:["read","taskflow_docs"],lastUser:"CLOCK + HISTORY + owner text",messages:3});
  const responses={input:[{role:"developer",content:"SECRETARY FILE"},{role:"user",content:[{type:"input_text",text:"turn json"}]},{type:"function_call_output",call_id:"c",output:"x"}],
   tools:[{type:"function",name:"bash"}]};
  expect(extractRequestContext(responses)).toMatchObject({system:"SECRETARY FILE",tools:["bash"],lastUser:"turn json"});
  recordPromptAudit({role:"builder",call_id:"b1",phase:"payload",origin:"chat",chat_id:"c1",model:"m",content:{...anthropic,apiKey:"SECRET"}},dir);
  const latest=readFileSync(join(dir,"roles","builder","latest.md"),"utf8");
  for(const part of ["BUILDER SYSTEM","taskflow_docs","CLOCK + HISTORY + owner text","c1"])expect(latest).toContain(part);
  expect(latest).not.toContain("SECRET");
  expect(readdirSync(dir)).not.toContain("objects"); // полный архив — только у Помощника
  const day=readdirSync(join(dir,"roles","builder")).find(x=>x.endsWith(".jsonl"))!;
  expect(JSON.parse(readFileSync(join(dir,"roles","builder",day),"utf8").trim())).toMatchObject({call_id:"b1",tools_count:2,system_chars:14});
  recordPromptAudit({role:"builder",call_id:"b0",phase:"context",content:anthropic},dir);
  expect(readFileSync(join(dir,"roles","builder",day),"utf8").trim().split("\n")).toHaveLength(1);
  expect(checkPromptContextInstrument(dir)).toEqual({ok:true,reason:""});
  expect(readdirSync(join(dir,"roles"))).toEqual(["builder"]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
