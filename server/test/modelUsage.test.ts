import {beforeEach,expect,it} from "vitest";
import db from "../src/db.js";
import {recordModelUsage,readModelUsage,ensureModelUsageSchema} from "../src/lib/modelUsage.js";
import {LiveTurn} from "../src/runtime/chatLiveTurn.js";
const message=(timestamp=Date.now(),cost:number|null=0.12)=>({
 role:"assistant",provider:"minimax",model:"MiniMax-M3.1-Flash",timestamp,
 content:[{type:"text",text:"готово"}],
 usage:{input:100,output:20,cacheRead:900,cacheWrite:0,cost:cost===null?undefined:{total:cost}}
});
beforeEach(()=>{ensureModelUsageSchema();db.exec("DELETE FROM model_usage");});
it("stores each provider response once across event replay and session copies",()=>{
 const m=message();recordModelUsage(m,"chat");recordModelUsage({...m},"session");
 const s=readModelUsage("week");expect(s.totals.calls).toBe(1);
 expect(s.totals.totalTokens).toBe(1020);expect(s.totals.cacheHitRate).toBe(0.9);
 expect(s.totals.estimatedCostUsd).toBe(0.12);
});
it("counts zero-usage and failed responses without inventing money",()=>{
 recordModelUsage({...message(),stopReason:"error",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:{total:0}}},"task");
 const s=readModelUsage("week");
 expect(s.totals.calls).toBe(1);expect(s.totals.unpricedCalls).toBe(1);
 expect(s.totals.estimatedCostUsd).toBeNull();expect(s.totals.cacheHitRate).toBeNull();
});
it("filters period and preserves breakdown by actual provider/model",()=>{
 recordModelUsage(message(Date.now()-40*86400000),"session");
 recordModelUsage(message(Date.now(),null),"task");
 recordModelUsage({...message(Date.now()+1),provider:"other",model:"another"},"chat");
 const s=readModelUsage("week");expect(s.totals.calls).toBe(2);
 expect(s.models).toHaveLength(2);expect(s.daily.reduce((n:any,d:any)=>n+d.calls,0)).toBe(2);
 expect(s.totals.unpricedCalls).toBe(1);expect(()=>readModelUsage("nonsense")).toThrow();
});
it("ignores malformed counters and non-assistant records",()=>{
 recordModelUsage({...message(),role:"user"},"session");
 recordModelUsage({...message(),usage:{input:-1,output:0}},"session");
 recordModelUsage({...message(),timestamp:NaN},"session");
 expect(readModelUsage("week").totals.calls).toBe(0);
});
it("real chat and task LiveTurn parser persists message_end before finish",()=>{
 const live=new LiveTurn({chatId:"usage-test",userId:"role_builder",name:"Builder",audience:()=>[],publish:()=>{}});
 const m=message();live.onEvent({type:"message_end",message:m});
 expect(readModelUsage("week").totals.calls).toBe(1);
 live.onEvent({type:"message_end",message:m});live.finish();
 expect(readModelUsage("week").totals.calls).toBe(1);
});

it("HTTP usage is owner-only and validates the period",async()=>{
 const {buildApp}=await import("../src/index.js");
 const app=await buildApp();
 try{
  const owner=db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as {id:string};
  const headers={authorization:"Bearer "+app.jwt.sign({id:owner.id})};
  recordModelUsage(message(),"chat");
  const response=await app.inject({method:"GET",url:"/api/runtime/usage?window=week",headers});
  expect(response.statusCode).toBe(200);expect(response.json().totals.calls).toBe(1);
  expect((await app.inject({method:"GET",url:"/api/runtime/usage?window=bad",headers})).statusCode).toBe(400);
  expect((await app.inject({method:"GET",url:"/api/runtime/usage"})).statusCode).toBe(401);
  db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES('usage-member','Member','usage-member@test','!t','viewer','human')").run();
  expect((await app.inject({method:"GET",url:"/api/runtime/usage",headers:{authorization:"Bearer "+app.jwt.sign({id:"usage-member"})}})).statusCode).toBe(403);
 }finally{await app.close();}
});
