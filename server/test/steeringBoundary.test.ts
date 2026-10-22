import {it,expect,vi} from "vitest";
import {Type} from "typebox";
import {installSteeringBoundary} from "../src/runtime/steeringBoundary.js";

it("после законченного действия следующие инструменты ждут пересмотра модели",async()=>{
 // Настоящий цикл установленного SDK, без провайдера и сети.
 const sdk=await import(/* @vite-ignore */ new URL("../node_modules/@earendil-works/pi-agent-core/dist/index.js",import.meta.resolve("@earendil-works/pi-coding-agent")).href);
 const calls:string[]=[],contexts:any[]=[];let pending:string[]=[];
 const model={id:"fixture",name:"fixture",api:"openai-completions",provider:"fixture",baseUrl:"",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const answer=(content:any[],stopReason:string)=>({role:"assistant",content,api:model.api,provider:model.provider,model:model.id,stopReason,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
 const tool=(id:string)=>({type:"toolCall",id,name:"act",arguments:{id}});
 const agent=new sdk.Agent({initialState:{model,tools:[{name:"act",label:"act",description:"fixture",parameters:Type.Object({id:Type.String()}),execute:async(_id:string,args:any)=>{calls.push(args.id);if(args.id==="first"){pending.push("Измени план");agent.steer({role:"user",content:"Измени план",timestamp:Date.now()});}return {content:[{type:"text",text:"ok"}],details:{}};}}]},streamFn:(_model:any,ctx:any)=>{
  contexts.push(structuredClone(ctx.messages));
  const message=contexts.length===1?answer([tool("first"),tool("obsolete")],"toolUse"):answer([{type:"text",text:"План пересмотрен"}],"stop");
  return {async *[Symbol.asyncIterator](){yield {type:"done",reason:message.stopReason,message};},result:async()=>message};
 }});
 const session={agent,getSteeringMessages:()=>pending};
 agent.subscribe((e:any)=>{if(e.type==="message_start"&&e.message.role==="user"&&e.message.content==="Измени план")pending=[];});
 installSteeringBoundary(session as any);
 await agent.prompt("Начни");
 expect(calls).toEqual(["first"]);
 expect(contexts).toHaveLength(2);
 expect(JSON.stringify(contexts[1])).toContain("Измени план");
 expect(contexts[1].filter((m:any)=>m.role==="toolResult")).toHaveLength(2);
 expect(contexts[1].find((m:any)=>m.toolCallId==="obsolete").isError).toBe(true);
});
it("сохраняет прежнюю проверку инструмента и не блокирует без уточнения",async()=>{
 const hook=vi.fn(async()=>({block:true,reason:"access denied"}));
 const session:any={agent:{beforeToolCall:hook,toolExecution:"parallel"},getSteeringMessages:()=>[]};
 installSteeringBoundary(session);
 expect(await session.agent.beforeToolCall({toolCall:{id:"a"}})).toEqual({block:true,reason:"access denied"});expect(hook).toHaveBeenCalledOnce();
});
it("внешний CLI не получает ложную поддержку границы инструментов",()=>{
 expect(()=>installSteeringBoundary({} as any)).not.toThrow();
});
