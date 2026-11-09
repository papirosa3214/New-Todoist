import fs from "node:fs";
import {fetch as directFetch} from "undici";

export type BrokerBinding={provider:string;alias:string;brokerUrl:string;tokenPath:string;authKind:"api_key"|"oauth";accountId?:string;upstreamBaseUrl?:string};
type Dependencies={readToken?:(path:string)=>string;fetch?:any};
const installed=new WeakSet<object>();
const genericKey="broker-managed-credential";
export function secretBrokerBindings(env:NodeJS.ProcessEnv=process.env):BrokerBinding[]{
 const raw=env.TASKFLOW_SECRET_BROKER_BINDINGS;
 if(!raw?.trim())return [];
 let parsed:unknown;try{parsed=JSON.parse(raw)}catch{throw new Error("Invalid broker bindings")}
 if(!Array.isArray(parsed))throw new Error("Invalid broker bindings");
 const providers=new Set<string>();
 for(const b of parsed){
  if(!b||typeof b.provider!=="string"||!b.provider||providers.has(b.provider)||typeof b.alias!=="string"||!/^[-a-zA-Z0-9._]{1,64}$/.test(b.alias)||typeof b.tokenPath!=="string"||!b.tokenPath.startsWith("/")||!["api_key","oauth"].includes(b.authKind))throw new Error("Invalid broker binding");
  const u=new URL(b.brokerUrl);
  if(u.username||u.password||u.search||u.hash||u.pathname!=="/"||!((["127.0.0.1","localhost","[::1]"].includes(u.hostname)&&u.protocol==="http:")||u.protocol==="https:"))throw new Error("Invalid broker URL");
  if(b.provider==="openai-codex"&&!b.accountId)throw new Error("Codex broker binding requires account identity");
  if(["opencode","opencode-go"].includes(b.provider)&&!b.upstreamBaseUrl)throw new Error("Gateway broker binding requires upstream base URL");
  if(b.upstreamBaseUrl){const source=new URL(b.upstreamBaseUrl);if(source.protocol!=="https:"||source.username||source.password||source.search||source.hash)throw new Error("Invalid broker upstream URL")}
  providers.add(b.provider);
 }
 return parsed as BrokerBinding[];
}
function sdkCredential(b:BrokerBinding):string{
 if(b.provider==="anthropic"&&b.authKind==="oauth")return "sk-ant-oat-broker-managed";
 if(b.provider==="openai-codex"){
  if(!b.accountId)throw new Error("Codex broker binding requires account identity");
  return "broker."+Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:b.accountId}})).toString("base64url")+".managed";
 }
 return genericKey;
}
function privateToken(path:string):string{
 try{
  const stat=fs.statSync(path);
  if(!stat.isFile()||(stat.mode&0o077)!==0)throw new Error();
  const token=fs.readFileSync(path,"utf8").trim();
  if(!token||/[\r\n\0]/.test(token))throw new Error();
  return token;
 }catch{throw new Error("Broker connection credential unavailable")}
}
/** No configuration means no wrappers, token reads, network calls or auth changes.
 * Selected providers retain their provider/model IDs and SDK transformations.
 * Only the destination/auth boundary changes; original credentials are not used.
 */
export function installSecretBrokerRuntime(runtime:any,bindings:BrokerBinding[],deps:Dependencies={}):void{
 if(!bindings.length||installed.has(runtime))return;
 const byProvider=new Map(bindings.map(b=>[b.provider,b]));
 const read=deps.readToken??privateToken;
 const fetchImpl=deps.fetch??directFetch;
 const base=(b:BrokerBinding,model?:any)=>{
  const target=new URL("/proxy/"+encodeURIComponent(b.alias),b.brokerUrl);
  if(b.upstreamBaseUrl&&model?.baseUrl){
   const source=new URL(model.baseUrl),service=new URL(b.upstreamBaseUrl);
   if(source.origin===target.origin&&(source.pathname===target.pathname||source.pathname.startsWith(target.pathname+"/")))return source.toString();
   const prefix=service.pathname.replace(/\/+$/,"");
   if(source.origin!==service.origin||!(source.pathname===prefix||source.pathname.startsWith(prefix+"/")))throw new Error("Model endpoint does not match broker service");
   target.pathname+=source.pathname.slice(prefix.length);
  }
  return target.toString();
 };
 const getAuth=runtime.getAuth?.bind(runtime);
 if(getAuth)runtime.getAuth=async(model:any,...rest:any[])=>{
  const b=byProvider.get(typeof model==="string"?model:model?.provider);
  if(!b)return getAuth(model,...rest);
  return {auth:{apiKey:model?.api==="google-generative-ai"?read(b.tokenPath):sdkCredential(b),baseUrl:base(b,model)},source:"secret broker"};
 };
 for(const name of ["stream","streamSimple","streamDeferred","fetchDeferred","cancelDeferred","generateImages","classify"]){
  if(typeof runtime[name]!=="function")continue;
  const original=runtime[name].bind(runtime);
  runtime[name]=(model:any,context:any,options:any={})=>{
   const b=byProvider.get(model?.provider);if(!b)return original(model,context,options);
   const target=base(b,model),expected=new URL(target);
   // Google's native adapter explicitly rejects custom fetch. Its SDK sends the
   // scoped broker token in x-goog-api-key; the proxy replaces it upstream.
   if(model.api==="google-generative-ai")return original({...model,baseUrl:target},context,{...options,apiKey:read(b.tokenPath),fetch:undefined});
   const routedFetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);const u=new URL(request.url);
    if(u.origin!==expected.origin||!(u.pathname===expected.pathname||u.pathname.startsWith(expected.pathname+"/")))throw new Error("Broker request escaped configured service");
    const headers=new Headers(request.headers);const authHeader=headers.has("x-api-key")?"X-Api-Key":headers.has("x-goog-api-key")?"X-Goog-Api-Key":"Authorization";headers.set("x-broker-auth-header",authHeader);headers.delete("x-api-key");headers.delete("api-key");headers.delete("cookie");headers.delete("x-goog-api-key");
    headers.set("authorization","Bearer "+read(b.tokenPath));
    if(["opencode","opencode-go"].includes(b.provider)&&!headers.has("x-opencode-session")){
     const session=typeof options?.sessionId==="string"&&options.sessionId.trim()?options.sessionId.trim():crypto.randomUUID();
     headers.set("x-opencode-session",session);
    }
    // Use direct undici fetch so the local broker does not inherit the model's
    // proxy dispatcher. The broker owns its explicit outbound egress policy.
    return fetchImpl(u,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body,signal:request.signal,redirect:"error",duplex:"half"});
   };
   return original({...model,baseUrl:target},context,{...options,apiKey:sdkCredential(b),fetch:routedFetch,...(b.provider==="openai-codex"?{transport:"sse"}:{})});
  };
 }
 installed.add(runtime);
}

const catalogueAdapters=new Set(["anthropic","minimax","opencode","opencode-go","openai-codex","xai","deepseek"]);
/** Public SDK in-memory key overlays also cover the SDK's independent catalogue
 * auth resolution. No auth.json mutation and no refresh of a retired OAuth key.
 * These supported providers use a public catalogue, never a personalized key.
 */
export async function prepareSecretBrokerRuntime(runtime:any,bindings:BrokerBinding[],deps:Dependencies={}):Promise<void>{
 const models=bindings.filter(b=>!["composio","wealthfolio","secretary-voice"].includes(b.provider));
 if(!models.length)return;
 for(const b of models){
  if(!catalogueAdapters.has(b.provider))throw new Error("Broker catalogue adapter unavailable for provider");
  const provider=runtime.getProvider(b.provider);
  if(!provider)throw new Error("Broker provider absent from SDK");
  if(!provider.auth.apiKey){
   runtime.registerNativeProvider({...provider,auth:{...provider.auth,apiKey:{
    name:"API key",
    login:async()=>{throw new Error("Authentication is managed by the secret broker")},
    resolve:async()=>({auth:{apiKey:sdkCredential(b)},source:"secret broker"})
   }}});
  }
  await runtime.setRuntimeApiKey(b.provider,sdkCredential(b));
  await runtime.refresh({allowNetwork:false,providers:[b.provider]});
 }
 installSecretBrokerRuntime(runtime,models,deps);
 const originalOAuth=runtime.isUsingOAuth?.bind(runtime),originalSubscription=runtime.isUsingSubscription?.bind(runtime);
 if(originalOAuth)runtime.isUsingOAuth=(provider:string)=>models.find(b=>b.provider===provider)?.authKind==="oauth"||originalOAuth(provider);
 if(originalSubscription)runtime.isUsingSubscription=(provider:string)=>{
  const b=models.find(b=>b.provider===provider);
  return b?b.authKind==="oauth"&&!!runtime.getProvider(provider)?.auth?.oauth?.isSubscription:originalSubscription(provider);
 };
}
export function secretBrokerConnectionToken(path:string):string{return privateToken(path)}
export function secretBrokerService(provider:string):BrokerBinding|undefined{return secretBrokerBindings().find(b=>b.provider===provider)}

/** Prepared path for server-side HTTP consumers outside Pi. No binding keeps
 * the exact existing fetch implementation; bound failures never fall back.
 */
export async function fetchWithSecretBroker(provider:string,input:string,init?:RequestInit,deps:Dependencies={}):Promise<Response>{
 const b=secretBrokerService(provider);
 if(!b)return globalThis.fetch(input,init);
 const source=new URL(input);
 if(source.username||source.password)throw new Error("Credential URL forbidden");
 const target=new URL("/proxy/"+encodeURIComponent(b.alias)+source.pathname,b.brokerUrl);target.search=source.search;
 const headers=new Headers(init?.headers);
 headers.set("x-broker-auth-header",headers.has("x-api-key")?"X-Api-Key":headers.has("x-goog-api-key")?"X-Goog-Api-Key":"Authorization");
 for(const name of ["authorization","x-api-key","api-key","x-goog-api-key","cookie"])headers.delete(name);
 headers.set("authorization","Bearer "+(deps.readToken??privateToken)(b.tokenPath));
 return (deps.fetch??directFetch)(target,{...init,headers,redirect:"error"});
}
