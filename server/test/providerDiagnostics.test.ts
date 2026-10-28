import {describe,it,expect,vi} from "vitest";
import {installProviderDiagnostics, registerProviderSession, observeProviderRetries} from "../src/runtime/providerDiagnostics.js";

function harness(fetchImpl: typeof fetch, result: any = {stopReason:"stop",content:[{type:"text",text:"ok"}]}, extraOptions:any = {}) {
 const logs: any[] = [];
 let options: any;
 const runtime: any = {streamSimple: vi.fn((_m:any,_c:any,o:any)=>{
   options=o;
   return {result:()=>Promise.resolve(result)};
 })};
 installProviderDiagnostics(runtime, {emit:(e:any)=>logs.push(e),fetch:fetchImpl});
 const stream=runtime.streamSimple({provider:"minimax",id:"flash",api:"anthropic-messages",baseUrl:"https://api.example/v1?key=hidden"},{messages:[{role:"user",content:"PRIVATE PROMPT"}],tools:[]},{sessionId:"session-1",timeoutMs:10000,...extraOptions});
 return {logs,options,stream,runtime};
}
const settle=()=>new Promise(r=>setTimeout(r,0));
describe("provider diagnostics",()=>{
 it("preserves nested transport causes and rethrows the identical error",async()=>{
  const cause=Object.assign(new Error("connect timeout"),{code:"UND_ERR_CONNECT_TIMEOUT",address:"1.2.3.4",port:443});
  const err=new TypeError("fetch failed",{cause});
  const h=harness(vi.fn().mockRejectedValue(err));
  await expect(h.options.fetch("https://api.example/v1?token=SECRET",{headers:{Authorization:"Bearer SECRET"}})).rejects.toBe(err);
  const e=h.logs.find(x=>x.event==="transport_error");
  expect(e).toMatchObject({provider:"minimax",model:"flash",session_id:"session-1",attempt:1,phase:"request",category:"connection_timeout"});
  expect(e.error.cause).toMatchObject({code:"UND_ERR_CONNECT_TIMEOUT",address:"1.2.3.4",port:443});
  expect(JSON.stringify(h.logs)).not.toMatch(/PRIVATE PROMPT|SECRET|hidden/);
 });
 it("records HTTP quota/auth/server errors, request IDs, retry-after and each actual attempt",async()=>{
  const h=harness(vi.fn().mockImplementation(()=>new Response(JSON.stringify({error:{type:"rate_limit_error",code:"quota_exceeded",message:"quota exhausted"}}),{status:429,headers:{"request-id":"upstream-42","retry-after":"9","set-cookie":"secret"}})));
  const a=await h.options.fetch("https://api.example/v1",{method:"POST"});
  expect(a.status).toBe(429);
  expect(await a.json()).toHaveProperty("error.code","quota_exceeded");
  await h.options.fetch("https://api.example/v1",{method:"POST"});
  await settle();
  const events=h.logs.filter(x=>x.event==="http_error");
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({status:429,category:"rate_limit",upstream_request_id:"upstream-42",retry_after:"9"});
  expect(h.logs.find(x=>x.event==="http_error_detail")).toMatchObject({provider_error:{type:"rate_limit_error",code:"quota_exceeded",message:"quota exhausted"}});
  expect(events[1].attempt).toBe(2);
  expect(events[0].call_id).toBe(events[1].call_id);
  expect(events[0].request_id).not.toBe(events[1].request_id);
  expect(JSON.stringify(h.logs)).not.toContain("set-cookie");
 });
 it("records read failures after headers without consuming/replacing caller content",async()=>{
  const err=Object.assign(new Error("socket closed"),{code:"ECONNRESET"});
  const body=new ReadableStream({pull(c){c.error(err)}});
  const h=harness(vi.fn().mockResolvedValue(new Response(body,{status:200,headers:{"x-request-id":"stream-1"}})));
  const r=await h.options.fetch("https://api.example/v1");
  await expect(r.text()).rejects.toBe(err);
  expect(h.logs.find(x=>x.event==="transport_error")).toMatchObject({phase:"response_body",category:"connection_reset",upstream_request_id:"stream-1"});
 });
 it("records model refusal, empty answer and SDK failure without dumping response text",async()=>{
  for(const result of [
   {stopReason:"refusal",content:[{type:"text",text:"PRIVATE REFUSAL"}]},
   {stopReason:"stop",content:[]},
   {stopReason:"error",errorMessage:"Request timed out.",content:[]}
  ]){
   const h=harness(vi.fn(),result);
   await h.stream.result(); await settle();
   expect(h.logs.find(x=>x.event==="model_result")).toMatchObject({stop_reason:result.stopReason});
   expect(JSON.stringify(h.logs)).not.toContain("PRIVATE REFUSAL");
  }
 });
 it("does not change provider callbacks, payload, fetch or installation count",async()=>{
  const logs:any[]=[]; let passed:any;
  const original=vi.fn((_m,_c,o)=>{passed=o;return{result:()=>Promise.resolve({stopReason:"stop",content:[]})}});
  const rt:any={stream:original,streamSimple:original};
  installProviderDiagnostics(rt,{emit:e=>logs.push(e),fetch:vi.fn()});
  installProviderDiagnostics(rt,{emit:e=>logs.push(e),fetch:vi.fn()});
  const custom=vi.fn().mockResolvedValue(new Response("ok"));
  const payload=vi.fn(x=>x); const response=vi.fn();
  rt.stream({}, {messages:[]},{fetch:custom,onPayload:payload,onResponse:response});
  const p={model:"m",messages:["PRIVATE"]};
  expect(await passed.onPayload(p,{})).toBe(p);
  await passed.onResponse({status:200,headers:{"request-id":"r"}},{});
  await passed.fetch("https://example.org");
  expect(custom).toHaveBeenCalledTimes(1); expect(payload).toHaveBeenCalledTimes(1);expect(response).toHaveBeenCalledTimes(1);
  expect(logs.filter(e=>e.event==="request_start")).toHaveLength(1);
 });
 it("diagnostics logger cannot break requests",async()=>{
  const rt:any={streamSimple:(_m:any,_c:any,o:any)=>({result:()=>Promise.resolve({stopReason:"error",errorMessage:"bad"}),options:o})};
  installProviderDiagnostics(rt,{emit:()=>{throw Error("disk error")},fetch:vi.fn().mockResolvedValue(new Response("ok"))});
  const s=rt.streamSimple({}, {}, {});
  expect((await s.options.fetch("https://example.org")).status).toBe(200);
  await expect(s.result()).resolves.toHaveProperty("stopReason","error");
 });
});

describe("provider failure coverage",()=>{
 it.each([[401,"auth_or_access"],[403,"auth_or_access"],[400,"request_rejected"],[413,"request_rejected"],[429,"rate_limit"],[500,"upstream_server_error"],[502,"upstream_server_error"],[504,"upstream_timeout"]])("classifies HTTP %s",async(status,category)=>{
  const h=harness(vi.fn().mockResolvedValue(new Response("{}",{status:status as number})));
  await h.options.fetch("https://example.org");
  expect(h.logs.find(x=>x.event==="http_error")).toMatchObject({status,category});
 });
 it.each([["ENOTFOUND","dns"],["CERT_HAS_EXPIRED","tls"],["ECONNREFUSED","connection_refused"],["ECONNRESET","connection_reset"]])("preserves %s",async(code,category)=>{
  const err=new TypeError("fetch failed",{cause:Object.assign(new Error("failed"),{code})});
  const h=harness(vi.fn().mockRejectedValue(err));
  await expect(h.options.fetch("https://example.org")).rejects.toBe(err);
  expect(h.logs.find(x=>x.event==="transport_error")).toMatchObject({category,error:{cause:{code}}});
 });
 it("distinguishes owner cancellation from deadline",async()=>{
  for(const [reason,category] of [[new DOMException("deadline","TimeoutError"),"deadline"],[new DOMException("stop","AbortError"),"cancelled"]] as const){
   const ac=new AbortController();ac.abort(reason);
   const h=harness(vi.fn().mockRejectedValue(reason),undefined,{signal:ac.signal});
   await expect(h.options.fetch("https://example.org",{signal:ac.signal})).rejects.toBe(reason);
   expect(h.logs.find(x=>x.event==="transport_error")).toMatchObject({category,signal_aborted:true});
  }
 });
 it("captures split SSE error and raw refusal without logging generated content",async()=>{
  const encoder=new TextEncoder();
  const pieces=['data: {"type":"error","error":{"type":"overloaded_', 'error","message":"Busy"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\ndata: {"type":"content_block_delta","delta":{"text":"PRIVATE OUTPUT"}}\n\n'];
  const h=harness(vi.fn().mockResolvedValue(new Response(new ReadableStream({start(c){pieces.forEach(p=>c.enqueue(encoder.encode(p)));c.close();}}),{headers:{"content-type":"text/event-stream"}})));
  const r=await h.options.fetch("https://example.org"); const body=await r.text();
  expect(body).toContain("PRIVATE OUTPUT");
  expect(h.logs.find(x=>x.event==="provider_stream_error")).toMatchObject({provider_error:{type:"overloaded_error",message:"Busy"}});
  expect(h.logs.find(x=>x.event==="provider_stop")).toMatchObject({stop_reason:"refusal"});
  expect(JSON.stringify(h.logs)).not.toContain("PRIVATE OUTPUT");
 });
 it("correlates requests to the role and task",async()=>{
  registerProviderSession("session-1",{role:"critic_verifier",task_id:"task-42",run_id:"run-7"});
  const h=harness(vi.fn().mockResolvedValue(new Response("ok")));
  await h.options.fetch("https://example.org");
  expect(h.logs.find(x=>x.event==="request_start")).toMatchObject({role:"critic_verifier",task_id:"task-42",run_id:"run-7"});
 });
 it("runs through the installed Pi SDK and retains the cause it flattens",async()=>{
  const {ModelRuntime}=await import("@earendil-works/pi-coding-agent");
  const rt=await ModelRuntime.create({modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  rt.registerProvider("diagnostic-test",{api:"anthropic-messages",baseUrl:"https://example.org",apiKey:"test-key-only",
    models:[{id:"test",name:"test",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:100}]});
  const logs:any[]=[];
  const failure=new TypeError("fetch failed",{cause:Object.assign(new Error("connect timeout"),{code:"UND_ERR_CONNECT_TIMEOUT"})});
  installProviderDiagnostics(rt,{emit:e=>logs.push(e),fetch:vi.fn().mockRejectedValue(failure)});
  const answer=await rt.completeSimple(rt.getModel("diagnostic-test","test")!,{messages:[{role:"user",content:"PRIVATE",timestamp:Date.now()}]},{maxRetries:0});
  await settle();
  expect(answer.stopReason).toBe("error");
  expect(logs.find(e=>e.event==="transport_error")).toMatchObject({error:{cause:{code:"UND_ERR_CONNECT_TIMEOUT"}}});
  expect(logs.find(e=>e.event==="model_result")).toMatchObject({stop_reason:"error",attempts:1});
  expect(JSON.stringify(logs)).not.toMatch(/PRIVATE|test-key-only/);
 });

 it("records real SDK HTTP retries and an upstream refusal separately",async()=>{
  const {ModelRuntime}=await import("@earendil-works/pi-coding-agent");
  const rt=await ModelRuntime.create({modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  rt.registerProvider("diagnostic-refusal",{api:"anthropic-messages",baseUrl:"https://example.org",apiKey:"test-key-only",
    models:[{id:"test",name:"test",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:100}]});
  const logs:any[]=[];
  const events=[
   {type:"message_start",message:{id:"m",type:"message",role:"assistant",model:"test",content:[],usage:{input_tokens:1,output_tokens:0}}},
   {type:"message_delta",delta:{stop_reason:"refusal",stop_sequence:null},usage:{output_tokens:0}},
   {type:"message_stop"}
  ].map(e=>"event: "+e.type+"\ndata: "+JSON.stringify(e)+"\n\n").join("");
  const network=vi.fn()
   .mockImplementationOnce(async()=>new Response(JSON.stringify({type:"error",error:{type:"rate_limit_error",message:"Slow down"}}),{status:429,headers:{"request-id":"rate-1","retry-after-ms":"1"}}))
   .mockImplementationOnce(async()=>new Response(events,{headers:{"content-type":"text/event-stream","request-id":"refusal-2"}}));
  installProviderDiagnostics(rt,{emit:e=>logs.push(e),fetch:network});
  const answer=await rt.completeSimple(rt.getModel("diagnostic-refusal","test")!,{messages:[{role:"user",content:"PRIVATE",timestamp:Date.now()}]},{maxRetries:1});
  await settle();
  expect(network).toHaveBeenCalledTimes(2);
  expect(answer.stopReason).toBe("error");
  expect(logs.find(e=>e.event==="http_error")).toMatchObject({status:429,upstream_request_id:"rate-1",attempt:1});
  expect(logs.find(e=>e.event==="provider_stop")).toMatchObject({stop_reason:"refusal",attempt:2});
  expect(logs.find(e=>e.event==="model_result")).toMatchObject({category:"model_refusal",attempts:2});
 });
 it("records session retry scheduling with role and sanitizes messages",()=>{
  const spy=vi.spyOn(console,"error").mockImplementation(()=>{});
  try{
   let listener:any;
   const session={subscribe:vi.fn(cb=>{listener=cb})};
   registerProviderSession("retry-session",{role:"critic_verifier",task_id:"task-42"});
   observeProviderRetries(session,"retry-session");observeProviderRetries(session,"retry-session");
   listener({type:"auto_retry_start",attempt:1,maxAttempts:2,delayMs:2000,errorMessage:"Bearer SECRET"});
   expect(session.subscribe).toHaveBeenCalledTimes(1);
   const record=JSON.parse(spy.mock.calls[0][1]);
   expect(record).toMatchObject({event:"auto_retry_start",role:"critic_verifier",attempt:1,max_attempts:2,delay_ms:2000});
   expect(record.error).not.toContain("SECRET");
  } finally {spy.mockRestore();}
 });

 it("keeps native Google transport and records raw undici errors in its request scope",async()=>{
  const {channel}=await import("node:diagnostics_channel");
  const logs:any[]=[];let passed:any;
  const rt:any={streamSimple:(_m:any,_c:any,o:any)=>{
   passed=o;
   const req={origin:"https://google.example",path:"/v1/models?key=SECRET",method:"POST"};
   channel("undici:request:create").publish({request:req});
   channel("undici:request:error").publish({request:req,error:new TypeError("fetch failed",{cause:Object.assign(new Error("dns"),{code:"ENOTFOUND"})})});
   return {result:()=>Promise.resolve({stopReason:"error",errorMessage:"fetch failed",content:[]})};
  }};
  installProviderDiagnostics(rt,{emit:e=>logs.push(e)});
  rt.streamSimple({provider:"google",id:"gemini",api:"google-generative-ai"},{messages:[]},{sessionId:"google-1"});
  await settle();
  expect(passed.fetch).toBeUndefined();
  expect(logs.find(e=>e.event==="native_transport_error")).toMatchObject({provider:"google",session_id:"google-1",category:"dns",error:{cause:{code:"ENOTFOUND"}}});
  expect(JSON.stringify(logs)).not.toContain("SECRET");
 });
 it("retains SDK transport fallback diagnostics without arbitrary details",async()=>{
  const h=harness(vi.fn(),{stopReason:"stop",content:[{type:"text",text:"ok"}],diagnostics:[{type:"provider_transport_failure",error:{name:"Error",code:"ECONNRESET",message:"ws closed"},details:{configuredTransport:"auto",fallbackTransport:"sse",phase:"before_message_stream_start",requestBytes:42,messages:"PRIVATE"}}]});
  await h.stream.result();await settle();
  expect(h.logs.find(e=>e.event==="sdk_diagnostic")).toMatchObject({diagnostic_type:"provider_transport_failure",error:{code:"ECONNRESET"},details:{fallbackTransport:"sse"}});
  expect(JSON.stringify(h.logs)).not.toContain("PRIVATE");
 });

 it("observes actual Node HTTP transport for a provider without injectable fetch",async()=>{
  const {createServer}=await import("node:http");
  const server=createServer((_req,res)=>{res.writeHead(403,{"content-type":"application/json"});res.end('{"error":"forbidden"}');});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address() as any;
  const logs:any[]=[];
  const rt:any={streamSimple:()=>{
   const result=fetch("http://127.0.0.1:"+address.port+"/provider?key=SECRET").then(async r=>{await r.text();return {stopReason:"error",errorMessage:"403 forbidden",content:[]};});
   return {result:()=>result};
  }};
  try{
   installProviderDiagnostics(rt,{emit:e=>logs.push(e)});
   await rt.streamSimple({provider:"google",id:"test",api:"google-generative-ai"},{messages:[]},{}).result();
   expect(logs.find(e=>e.event==="native_http_error")).toMatchObject({status:403,category:"auth_or_access"});
   expect(JSON.stringify(logs)).not.toContain("SECRET");
  }finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
});
