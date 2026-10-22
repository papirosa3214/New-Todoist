import {chatExecutionMode,type ChatExecutionMode} from "./chatExecutionMode.js";
import {roleHostAccessTools} from "./roleHostAccess.js";
import {taskflowTools} from "./inProcessRun.js";
import {roleToolAllowed} from "../lib/roleToolScope.js";
import {roleUserId} from "../roleRouting.js";
import {createUniversalTaskflow,operationRestriction,UNIVERSAL_INSTRUCTION,type Tool,type Context} from "./universalTaskflow.js";
import {toolRequestStore} from "./toolRequestStore.js";
export {UNIVERSAL_INSTRUCTION};
export type CatalogContext={role:string;model?:string|null;mode:string;runId:string;taskId?:string;subtaskId?:string;chatId?:string;messageId?:string;executionMode?:ChatExecutionMode};
export function buildRoleToolCatalog(input:CatalogContext,adapters:Tool[]=[]){
 const context:Context={...input,executionMode:input.taskId ? "card" : input.executionMode ?? (input.chatId ? chatExecutionMode(input.chatId,input.messageId) : undefined),actor:roleUserId(input.role),authorize:(name)=>
  roleToolAllowed(input.role,name) && (!input.subtaskId || name!=="taskflow_claim") &&
  (input.role!=="critic_verifier" || name!=="taskflow_subtask_done")};
 const taskflowOperations=taskflowTools(input.role,input.model??null,input.taskId,input.subtaskId,true,{chatId:input.chatId??"",messageId:input.messageId??""});
 // Things 3 is also a normal TaskFlow operation for work runs. Chat entrypoints
 // pass its chat-aware adapter; prefer that adapter and keep every other
 // duplicate operation visible as an error.
 const adapterNames=new Set(adapters.map(tool=>tool.name));
 const operations=[...taskflowOperations.filter(tool=>!adapterNames.has(tool.name)),...roleHostAccessTools(input),...adapters];
 const universal=createUniversalTaskflow(operations,context,toolRequestStore);
 // Aliases remain registered for SDK/history compatibility, but only taskflow is active.
 const aliases=operations.filter(t=>!operationRestriction(t.name,context)).map(tool=>({...tool,execute:async(id:string,args:any,signal?:AbortSignal,onUpdate?:any)=>{
  const output=await universal.execute(id,{action:"invoke",operation:tool.name,version:1,arguments:args,request_id:input.runId+":"+id},signal,onUpdate);
  const envelope=JSON.parse(output.content[0].text);
  if(!envelope.ok)throw new Error(envelope.error.code+": "+envelope.error.message);
  if(!envelope.data?.content)throw new Error("Запрос уже выполняется; проверь requests.status");
  return {content:envelope.data.content,details:{operation:tool.name}};
 }}));
 return {activeNames:["taskflow"],customTools:[universal,...aliases],operations,context};
}
