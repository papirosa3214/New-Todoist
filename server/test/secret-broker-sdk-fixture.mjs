import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";import {join} from "node:path";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {Composio} from "@composio/core";
import {installSecretBrokerRuntime} from "../src/runtime/secretBrokerRuntime.ts";
const url=process.env.BROKER_FIXTURE_URL,token=process.env.BROKER_FIXTURE_TOKEN;
assert(url?.startsWith("http://127.0.0.1:"));assert(token);
const dir=await mkdtemp(join(tmpdir(),"broker-e2e-"));
try{
 const rt=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
 installSecretBrokerRuntime(rt,[
  {provider:"anthropic",alias:"anthropic",brokerUrl:url,tokenPath:"fixture",authKind:"api_key"},
  {provider:"openai-codex",alias:"codex",brokerUrl:url,tokenPath:"fixture",authKind:"oauth",accountId:"fixture-account"},
  {provider:"opencode",alias:"opencode",brokerUrl:url,tokenPath:"fixture",authKind:"api_key",upstreamBaseUrl:"https://opencode.ai/inference"}
 ],{readToken:()=>token});
 for(const [provider,api] of [["anthropic","anthropic-messages"],["openai-codex","openai-codex-responses"],["opencode","google-generative-ai"]]){
  const model=rt.getModels(provider).find(m=>m.api===api);assert(model);
  const result=await rt.streamSimple(model,{messages:[{role:"user",content:"fixture",timestamp:Date.now()}]}).result();
  assert.equal(result.stopReason,"stop",provider+": "+(result.errorMessage??"no completion"));
  assert(result.content.some(p=>p.type==="text"&&p.text==="ready"),provider+": no fixture output");
 }
 const sdk=new Composio({apiKey:token,baseURL:url+"/proxy/composio-taskflow",logLevel:"silent",allowTracking:false});
 const response=await sdk.getClient().toolkits.list({limit:1});
 assert(Array.isArray(response.items));
 process.stdout.write("SDK_CHAIN_OK\n");
}finally{await rm(dir,{recursive:true,force:true})}
