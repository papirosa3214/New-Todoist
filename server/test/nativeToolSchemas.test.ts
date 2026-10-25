import {beforeAll,it,expect,vi} from "vitest";
import {Type} from "typebox";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {buildRoleToolCatalog,restoreNativeToolSchemas} from "../src/runtime/roleToolCatalog.js";
beforeAll(()=>{migrate();runMigrations();seedRoleAccounts(db);});
function fixture(){
 const execute=vi.fn(async(_id:string,args:any)=>({content:[{type:"text",text:JSON.stringify({answer:args.query})}]}));
 const parameters=Type.Object({query:Type.String(),limit:Type.Optional(Type.Integer({minimum:1,maximum:5}))},{additionalProperties:false});
 const catalog=buildRoleToolCatalog({role:"infra_engineer",mode:"work",runId:"native-schema-test"},[{name:"mcp__infra__schema_probe",description:"Read-only schema probe",parameters,execute}]);
 return {execute,parameters,catalog,tool:catalog.customTools.find(t=>t.name==="mcp__infra__schema_probe")!};
}
it("offers the operation itself with its exact schema",()=>{
 const {catalog,tool,parameters}=fixture();
 // Операция доступна с точной схемой; в запрос уходит ядро, остальное
 // подключается по требованию (taskflow_tools).
 expect(catalog.registeredNames).toContain(tool.name);
 expect(catalog.activeNames).toContain("taskflow_tools");
 expect(catalog.activeNames).not.toContain(tool.name);
 expect(catalog.activeNames).not.toContain("taskflow");
 expect(tool.parameters).toEqual(parameters);
 expect(tool.parameters.properties.query.type).toBe("string");
 expect(tool.parameters.required).toEqual(["query"]);
});
it("accepts bare native arguments through the protected executor",async()=>{
 const {tool,execute}=fixture();
 const out=await tool.execute("good",{query:"health",limit:2});
 expect(execute).toHaveBeenCalledTimes(1);
 expect(execute.mock.calls[0][1]).toEqual({query:"health",limit:2});
 expect(JSON.parse(out.content[0].text)).toEqual({answer:"health"});
});
it("rejects invalid arguments before execution and preserves corrective hints",async()=>{
 const {tool,execute}=fixture();
 await expect(tool.execute("bad",{})).rejects.toThrow(/INVALID_ARGUMENTS/);
 await expect(tool.execute("bad-again",{})).rejects.toThrow(/hint/);
 expect(execute).not.toHaveBeenCalled();
});
it("does not expose card-launch tools in ordinary chat mode",()=>{
 const c=buildRoleToolCatalog({role:"secretary",mode:"work",runId:"native-chat",chatId:"chat",messageId:"message"});
 expect(c.activeNames).not.toContain("taskflow_plan_request");
});

it("preserves root constraints in the real Anthropic SDK payload",async()=>{
 const {tool}=fixture();
 const {streamSimple}=await import("../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js");
 let captured:any;
 const model:any={id:"MiniMax-M3.1-Flash",provider:"minimax",api:"anthropic-messages",baseUrl:"https://api.minimax.io/anthropic",reasoning:true,contextWindow:1000000,maxTokens:2048,name:"MiniMax fixture",cost:{input:0,output:0,cacheRead:0,cacheWrite:0},input:["text"],compat:{forceAdaptiveThinking:true}};
 const stream=streamSimple(model,{messages:[{role:"user",content:"fixture",timestamp:1}],tools:[tool]}, {apiKey:"audit-dummy-no-network",reasoning:"low",onPayload:(payload:any)=>{
  captured=restoreNativeToolSchemas(payload,[tool]);
  throw new Error("STOP_BEFORE_NETWORK");
 }});
 const result=await stream.result();
 expect(result.errorMessage).toBe("STOP_BEFORE_NETWORK");
 expect(captured.tools[0].name).toBe(tool.name);
 expect(captured.tools[0].input_schema).toEqual(JSON.parse(JSON.stringify(tool.parameters)));
});

it("accounts for SDK validation refusal without storing argument values",()=>{
 const {catalog,tool}=fixture();
 const before=db.prepare("SELECT COUNT(*) AS n FROM role_tool_audit WHERE operation=?").get(tool.name) as {n:number};
 catalog.onToolExecutionEnd({type:"tool_execution_end",toolCallId:"sdk-rejected",toolName:tool.name,args:{limit:"PRIVATE_VALUE"},isError:true,result:{content:[{type:"text",text:"PRIVATE_VALUE"}]}});
 const rows=db.prepare("SELECT error_code,error_message FROM role_tool_audit WHERE operation=? ORDER BY rowid DESC").all(tool.name) as any[];
 expect(rows.length).toBe(before.n+1);
 expect(rows[0].error_code).toBe("INVALID_ARGUMENTS");
 expect(rows[0].error_message).not.toContain("PRIVATE_VALUE");
});

it("bounds repeated SDK validation failures",()=>{
 const {catalog,tool}=fixture();
 const event=(id:string)=>({type:"tool_execution_end",toolCallId:id,toolName:tool.name,args:{},isError:true});
 expect(catalog.onToolExecutionEnd(event("sdk-1"))).toBe(false);
 expect(catalog.onToolExecutionEnd(event("sdk-2"))).toBe(false);
 expect(catalog.onToolExecutionEnd(event("sdk-3"))).toBe(true);
});
