import {describe,it,expect,vi} from "vitest";
import {Type} from "typebox";
import {createUniversalTaskflow} from "../src/runtime/universalTaskflow.js";
const context={actor:"role_builder",role:"builder",mode:"work" as const,runId:"test-run"};
const tool=(execute=vi.fn(async()=>({content:[{type:"text",text:"done"}]})))=>({name:"taskflow_comment",description:"Комментарий в задачу",parameters:Type.Object({id:Type.String(),text:Type.String()}),execute});
const decode=(r:any)=>JSON.parse(r.content[0].text);
describe("universal TaskFlow",()=>{
 it("discovers by text and describes the exact schema without execution",async()=>{
  const t=tool();const api=createUniversalTaskflow([t],context);
  expect(decode(await api.execute("1",{action:"discover",query:"Комментарий"})).data.operations[0].operation).toBe("taskflow_comment");
  expect(decode(await api.execute("2",{action:"describe",operation:t.name})).data.inputSchema.required).toEqual(["id","text"]);
  expect(t.execute).not.toHaveBeenCalled();
 });
 it("validates nested arguments before side effects",async()=>{
  const t=tool();const api=createUniversalTaskflow([t],context);
  expect(decode(await api.execute("3",{action:"invoke",operation:t.name,version:1,arguments:{id:5},request_id:"invalid"})).error.code).toBe("INVALID_ARGUMENTS");
  expect(t.execute).not.toHaveBeenCalled();
 });
 it("blocks writes in planning and checks current authorization on every call",async()=>{
  const t=tool();let allowed=true;
  const api=createUniversalTaskflow([t],{...context,authorize:()=>allowed});
  allowed=false;
  expect(decode(await api.execute("4",{action:"invoke",operation:t.name,version:1,arguments:{id:"t",text:"x"},request_id:"deny"})).error.code).toBe("FORBIDDEN");
  const plan=createUniversalTaskflow([t],{...context,mode:"plan"});
  expect(decode(await plan.execute("5",{action:"invoke",operation:t.name,version:1,arguments:{id:"t",text:"x"},request_id:"plan"})).error.code).toBe("MODE_RESTRICTED");
  expect(t.execute).not.toHaveBeenCalled();
 });
 it("rejects duplicate registrations instead of choosing a handler",()=>{
  const t=tool();expect(()=>createUniversalTaskflow([t,t],context)).toThrow(/duplicate/i);
 });
 it("preserves media content returned by underlying adapters",async()=>{
  const t=tool(vi.fn(async()=>({content:[{type:"image",data:"AA==",mimeType:"image/png"}]})) as any);
  const api=createUniversalTaskflow([t],context);
  const r=await api.execute("6",{action:"invoke",operation:t.name,version:1,arguments:{id:"t",text:"x"},request_id:"media"});
  expect(r.content.some((c:any)=>c.type==="image")).toBe(true);
 });
});
