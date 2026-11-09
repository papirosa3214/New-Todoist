import {describe,it,expect,vi} from "vitest";
import {installSecretBrokerRuntime,secretBrokerBindings,prepareSecretBrokerRuntime} from "../src/runtime/secretBrokerRuntime.js";
describe("secret broker runtime preparation",()=>{
 it("does absolutely nothing when no bindings are configured",()=>{
  const runtime={getAuth:vi.fn(),stream:vi.fn()};const before={...runtime};
  installSecretBrokerRuntime(runtime,[]);
  expect(runtime.getAuth).toBe(before.getAuth);expect(runtime.stream).toBe(before.stream);
 });
 it("replaces provider authentication in memory without reading original credentials",async()=>{
  let options:any,model:any;
  const oldAuth=vi.fn(()=>{throw new Error("legacy credential read")});
  const runtime={getAuth:oldAuth,streamSimple:(m:any,_c:any,o:any)=>{model=m;options=o;return "stream"}};
  const fetch=vi.fn().mockResolvedValue(new Response("data: done\n\n",{headers:{"content-type":"text/event-stream"}}));
  installSecretBrokerRuntime(runtime,[{provider:"anthropic",alias:"minimax",brokerUrl:"http://127.0.0.1:28443",tokenPath:"unused",authKind:"oauth"}],{readToken:()=> "connection-canary",fetch});
  const original={provider:"anthropic",id:"same-model",baseUrl:"https://api.anthropic.com",api:"anthropic-messages"};
  const auth=await runtime.getAuth(original);
  expect(auth.auth.apiKey).toContain("sk-ant-oat");expect(oldAuth).not.toHaveBeenCalled();
  expect(runtime.streamSimple(original,{},{})).toBe("stream");
  expect(model.provider).toBe(original.provider);expect(model.id).toBe(original.id);expect(original.baseUrl).toBe("https://api.anthropic.com");
  await options.fetch("http://127.0.0.1:28443/proxy/minimax/v1/messages",{method:"POST",body:"{}",headers:{"x-api-key":"fake-key",Authorization:"Bearer fake-key"}});
  const [url,init]=fetch.mock.calls[0];expect(url.toString()).toContain("/proxy/minimax/v1/messages");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer connection-canary");
  expect(new Headers(init.headers).has("x-api-key")).toBe(false);expect(new Headers(init.headers).get("x-broker-auth-header")).toBe("X-Api-Key");
  await expect(options.fetch("https://evil.example/")).rejects.toThrow();
 });
 it("keeps unconfigured providers on the exact original path",async()=>{
  const getAuth=vi.fn().mockResolvedValue("original");const runtime={getAuth,streamSimple:vi.fn()};
  installSecretBrokerRuntime(runtime,[{provider:"minimax",alias:"minimax",brokerUrl:"http://127.0.0.1:28443",tokenPath:"unused",authKind:"api_key"}],{readToken:()=> "connection"});
  expect(await runtime.getAuth({provider:"xai"})).toBe("original");
  expect(getAuth).toHaveBeenCalledTimes(1);
 });
 it("does not silently fall back if broker connection fails",async()=>{
  let options:any;const runtime={getAuth:vi.fn(),stream:(m:any,c:any,o:any)=>{options=o}};
  const fetch=vi.fn().mockRejectedValue(new Error("offline"));
  installSecretBrokerRuntime(runtime,[{provider:"minimax",alias:"minimax",brokerUrl:"http://127.0.0.1:28443",tokenPath:"unused",authKind:"api_key"}],{readToken:()=> "connection",fetch});
  runtime.stream({provider:"minimax",id:"same"}, {}, {});
  await expect(options.fetch("http://127.0.0.1:28443/proxy/minimax/messages")).rejects.toThrow("offline");
  expect(fetch).toHaveBeenCalledTimes(1);
 });
});

describe("broker configuration and installed SDK compatibility",()=>{
 it("rejects unsafe configurations without reading credentials",()=>{
  expect(secretBrokerBindings({})).toEqual([]);
  for(const brokerUrl of ["http://evil.example","https://user:password@example.com","http://127.0.0.1:28443/other"]){
   expect(()=>secretBrokerBindings({TASKFLOW_SECRET_BROKER_BINDINGS:JSON.stringify([{provider:"minimax",alias:"minimax",brokerUrl,tokenPath:"/unused",authKind:"api_key"}])})).toThrow();
  }
 });
 it("adds the TaskFlow session ID for OpenCode gateway requests",async()=>{
  let options:any;const runtime={streamSimple:(_m:any,_c:any,o:any)=>{options=o;return "stream";}};
  const fetch=vi.fn().mockResolvedValue(new Response("{}"));
  installSecretBrokerRuntime(runtime,[{provider:"opencode-go",alias:"opencode-go",brokerUrl:"http://127.0.0.1:28443",tokenPath:"unused",authKind:"api_key",upstreamBaseUrl:"https://opencode.ai/inference/go"}],{readToken:()=>"connection-fixture",fetch});
  runtime.streamSimple({provider:"opencode-go",id:"deepseek-v4.1-flash",baseUrl:"https://opencode.ai/inference/go/openai/v1"},{},{sessionId:"taskflow-session-fixture"});
  await options.fetch("http://127.0.0.1:28443/proxy/opencode-go/openai/v1/chat/completions",{method:"POST",body:"{}"});
  expect(new Headers(fetch.mock.calls[0][1].headers).get("x-opencode-session")).toBe("taskflow-session-fixture");
 });
 it("runs the installed Anthropic SDK through the adapter using only fixture credentials",async()=>{
  const {ModelRuntime}=await import("@earendil-works/pi-coding-agent");
  const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const dir=await mkdtemp(join(tmpdir(),"broker-sdk-"));
  try{
   const rt=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
   const model=rt.getModels("anthropic")[0];expect(model).toBeTruthy();
   const events=[
    ["message_start",{type:"message_start",message:{id:"msg_fixture",type:"message",role:"assistant",model:model.id,content:[],stop_reason:null,usage:{input_tokens:1,output_tokens:0}}}],
    ["content_block_start",{type:"content_block_start",index:0,content_block:{type:"text",text:""}}],
    ["content_block_delta",{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"ready"}}],
    ["content_block_stop",{type:"content_block_stop",index:0}],
    ["message_delta",{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:1}}],
    ["message_stop",{type:"message_stop"}]
   ];
   const fetch=vi.fn().mockImplementation(async()=>new Response(events.map(([name,value])=>"event: "+name+"\ndata: "+JSON.stringify(value)+"\n\n").join(""),{headers:{"content-type":"text/event-stream"}}));
   installSecretBrokerRuntime(rt,[{provider:"anthropic",alias:"minimax",brokerUrl:"http://127.0.0.1:28443",tokenPath:"unused",authKind:"oauth"}],{readToken:()=>"connection-fixture",fetch});
   const result=await rt.streamSimple(model,{messages:[{role:"user",content:"test",timestamp:Date.now()}]}).result();
   expect(result.stopReason).toBe("stop");expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({type:"text",text:"ready"})]));
   expect(fetch).toHaveBeenCalledTimes(1);
   const [url,init]=fetch.mock.calls[0];expect(String(url)).toContain("/proxy/minimax/v1/messages");
   expect(new Headers(init.headers).get("authorization")).toBe("Bearer connection-fixture");
  }finally{await rm(dir,{recursive:true,force:true})}
 });
});

it("uses the installed Codex SDK SSE protocol without leaking the real credential",async()=>{
 const {ModelRuntime}=await import("@earendil-works/pi-coding-agent");
 const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const dir=await mkdtemp(join(tmpdir(),"broker-codex-"));
 try{
  const rt=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  const model=rt.getModels("openai-codex")[0];expect(model).toBeTruthy();
  const events=[
   {type:"response.created",response:{id:"resp_fixture"}},
   {type:"response.output_item.done",output_index:0,item:{type:"message",id:"msg_fixture",role:"assistant",status:"completed",content:[{type:"output_text",text:"ready",annotations:[]}]}},
   {type:"response.completed",response:{id:"resp_fixture",status:"completed",output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}
  ];
  let headers:Headers|undefined,payload:any;
  const fetch=vi.fn().mockImplementation(async(_url,init)=>{
   headers=new Headers(init.headers);const bytes=Buffer.from(await new Response(init.body).arrayBuffer());
   const {zstdDecompressSync}=await import("node:zlib");
   payload=JSON.parse(headers.get("content-encoding")==="zstd"?zstdDecompressSync(bytes).toString():bytes.toString());
   return new Response(events.map(value=>"data: "+JSON.stringify(value)+"\n\n").join(""),{headers:{"content-type":"text/event-stream"}});
  });
  installSecretBrokerRuntime(rt,[{provider:"openai-codex",alias:"codex",brokerUrl:"http://127.0.0.1:28443",tokenPath:"unused",authKind:"oauth",accountId:"fixture-account"}],{readToken:()=>"connection-fixture",fetch});
  const result=await rt.streamSimple(model,{messages:[{role:"user",content:"test",timestamp:Date.now()}]}).result();
  expect(result.stopReason).toBe("stop");expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({type:"text",text:"ready"})]));
  expect(fetch).toHaveBeenCalledTimes(1);expect(headers?.get("chatgpt-account-id")).toBe("fixture-account");
  expect(headers?.get("authorization")).toBe("Bearer connection-fixture");expect(payload.model).toBe(model.id);
 }finally{await rm(dir,{recursive:true,force:true})}
});

it("retains model availability and original credential files while masking catalog authentication",async()=>{
 const {ModelRuntime}=await import("@earendil-works/pi-coding-agent");
 const fs=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const dir=await fs.mkdtemp(join(tmpdir(),"broker-catalog-"));const authPath=join(dir,"auth.json");const stored=JSON.stringify({"openai-codex":{type:"oauth",access:"expired-fixture",refresh:"retired-fixture",expires:1}});await fs.writeFile(authPath,stored);
 try{
  const rt=await ModelRuntime.create({authPath,modelsPath:null,allowModelNetwork:false});
  const ids=rt.getModels("openai-codex").map(m=>m.id);
  await prepareSecretBrokerRuntime(rt,[{provider:"openai-codex",alias:"codex",brokerUrl:"http://127.0.0.1:28443",tokenPath:"unused",authKind:"oauth",accountId:"fixture-account"}],{readToken:()=>"fixture",fetch:vi.fn()});
  expect(rt.getAvailableSnapshot().some(m=>m.provider==="openai-codex")).toBe(true);
  expect(rt.getModels("openai-codex").map(m=>m.id)).toEqual(ids);
  expect(rt.isUsingOAuth("openai-codex")).toBe(true);
  const requests:string[]=[];
  vi.stubGlobal("fetch",vi.fn(async(input:any)=>{const url=String(input instanceof Request?input.url:input);requests.push(url);if(!url.startsWith("https://pi.dev/api/models/providers/"))throw new Error("Unexpected auth request");return new Response(JSON.stringify({models:[]}),{headers:{"content-type":"application/json","last-modified":"Tue, 01 Jan 2030 00:00:00 GMT"}})}));
  try{
   const result=await rt.refresh({allowNetwork:true,providers:["openai-codex"],force:true,signal:AbortSignal.timeout(2000)});
   expect(result.errors.size).toBe(0);expect(requests.some(u=>u.includes("/openai-codex"))).toBe(true);
   expect(await fs.readFile(authPath,"utf8")).toBe(stored);
  }finally{vi.unstubAllGlobals()}

 }finally{await fs.rm(dir,{recursive:true,force:true})}
});

it("does not alter runtime methods for an empty or Composio-only preparation",async()=>{
 const runtime={getAuth:vi.fn(),isUsingOAuth:vi.fn(),isUsingSubscription:vi.fn()};
 const before={...runtime};
 await prepareSecretBrokerRuntime(runtime,[]);
 expect(runtime.isUsingOAuth).toBe(before.isUsingOAuth);
 await prepareSecretBrokerRuntime(runtime,[{provider:"composio",alias:"composio-taskflow",brokerUrl:"http://127.0.0.1:28443",tokenPath:"unused",authKind:"api_key"}]);
 expect(runtime.isUsingSubscription).toBe(before.isUsingSubscription);
});

it("supports the installed native Google adapter without custom-fetch rejection",async()=>{
 const {ModelRuntime}=await import("@earendil-works/pi-coding-agent");const fs=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const dir=await fs.mkdtemp(join(tmpdir(),"broker-google-"));
 try{
  const rt=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  const model=rt.getModels("opencode").find(m=>m.api==="google-generative-ai");expect(model).toBeTruthy();
  let request:Request|undefined;
  vi.stubGlobal("fetch",vi.fn(async(input,init)=>{request=new Request(input,init);return new Response('data: '+JSON.stringify({candidates:[{content:{role:"model",parts:[{text:"ready"}]},finishReason:"STOP",index:0}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2}})+'\n\n',{headers:{"content-type":"text/event-stream"}})}));
  installSecretBrokerRuntime(rt,[{provider:"opencode",alias:"opencode",brokerUrl:"http://127.0.0.1:28443",tokenPath:"unused",authKind:"api_key",upstreamBaseUrl:"https://opencode.ai/inference"}],{readToken:()=>"connection-fixture",fetch:vi.fn(()=>{throw new Error("custom fetch must not be used")})});
  const result=await rt.streamSimple(model!,{messages:[{role:"user",content:"test",timestamp:Date.now()}]}).result();
  expect(result.stopReason).toBe("stop");expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({type:"text",text:"ready"})]));
  expect(request?.url).toContain("/proxy/opencode/google/v1beta/");
  expect(request?.headers.get("x-goog-api-key")).toBe("connection-fixture");
 }finally{vi.unstubAllGlobals();await fs.rm(dir,{recursive:true,force:true})}
});
