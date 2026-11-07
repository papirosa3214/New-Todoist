import {describe,it,expect,vi} from "vitest";
import {appleReminderTools} from "../src/runtime/appleReminderTools.js";

const T=(name:string,description:string,parameters:any,run:any)=>({name,description,parameters,run});
describe("owner Apple reminder tools",()=>{
 it("exposes ordinary and urgent tools to each role and returns actual receipt",async()=>{
  const send=vi.fn(async(p:any)=>({id:"apple:1",mode:p.mode}));
  for(const role of ["secretary","code_orchestrator","builder","researcher"]){
   const tools=appleReminderTools(role,T,send);
   expect(tools.map((t:any)=>t.name)).toEqual(["taskflow_notify_owner","taskflow_notify_owner_urgent"]);
   const result=await tools[1].run({title:"Нужно решение",reason:"Нужен доступ владельца",notes:"Подробности",at:"2026-10-30T10:00:00+03:00",key:"test"});
   expect(result.id).toBe("apple:1");
   expect(send.mock.lastCall?.[0]).toMatchObject({mode:"urgent",key:"role:"+role+":test"});
  }
 });
 it("rejects empty titles, naive times and urgent calls without a reason before execution",async()=>{
  const send=vi.fn();const tools=appleReminderTools("builder",T,send);
  await expect(tools[0].run({title:" "})).rejects.toThrow(/название/);
  await expect(tools[0].run({title:"T",at:"2026-10-30T10:00:00"})).rejects.toThrow(/пояс/);
  await expect(tools[1].run({title:"T"})).rejects.toThrow(/причин/);
  expect(send).not.toHaveBeenCalled();
 });
 it("preserves delivery errors instead of claiming a reminder exists",async()=>{
  const send=vi.fn(async()=>{throw new Error("Mac offline")});
  await expect(appleReminderTools("code_orchestrator",T,send)[0].run({title:"T"})).rejects.toThrow("Mac offline");
 });
});
