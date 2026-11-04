import fs from "node:fs";

/** Sole owner-controlled system instruction for secretary text chat. No fallback to the common canon. */
export function secretaryChatPrompt():string {
 const text=fs.readFileSync(new URL("../../scripts/secretary-chat-system.md",import.meta.url),"utf8");
 if(!text.trim())throw new Error("Secretary chat system instruction is empty");
 return text;
}
export function chatTurnSystemText(role:string,base:string,extras:string[]):string {
 return role==="secretary" ? base : [base,...extras.filter(Boolean)].join("\n\n");
}
/** Preserve the current tool loadout, but remove every old/server/SDK system message, including resumed history. */
export function projectSecretarySystem(messages:any[],text:string):any[] {
 const tools=new Map<string,any>();
 for(const m of messages)if(m.role==="system"){
  for(const name of m.toolsRemoved??[])tools.delete(name);
  for(const tool of m.toolsAdded??[])tools.set(tool.name,tool);
 }
 return [{role:"system",content:text,timestamp:messages.find(m=>m.role==="system")?.timestamp??Date.now(),
  ...(tools.size?{toolsAdded:[...tools.values()]}:{})},...messages.filter(m=>m.role!=="system")];
}
export function installSecretarySystem(session:any,role:string,text:string):void {
 if(role!=="secretary")return;
 const previous=session.agent.transformContext;
 session.agent.transformContext=async(messages:any[],signal?:AbortSignal)=>
  projectSecretarySystem(previous?await previous(messages,signal):messages,text);
}
export function secretaryChatInput(values:Record<string,string>):string {
 return JSON.stringify({participants:values.participants??"",history:values.history??"",message:values.userText??""},null,2);
}


/** Permanent mode prefixes are omitted for secretary. Targeted tool-time feedback remains enabled. */
export function chatUserTurnText(role:string,modeInstruction:string,text:string):string {
 return role==="secretary" || !modeInstruction ? text : modeInstruction+"\n\n"+text;
}
export function chatRuntimeGuidanceEnabled(_role:string):boolean { return true; }
