/** Active chat input, separate from the FIFO of complete model runs.
 * Acceptance by the SDK is not delivery: acknowledge only after a user message
 * event and after the enclosing reply has been persisted. Unconsumed input
 * falls back to the durable FIFO (including the end-of-stream race).
 */
export interface SteeringReceipt {
 consumed: Promise<boolean>;
 outcome: Promise<boolean>;
}
interface Pending {
 text: string;
 receipt: SteeringReceipt;
 resolve: (consumed: boolean) => void;
 seen: boolean;
 ready: Promise<boolean>;
}
interface Input {
 chatId: string;
 roleId: string;
 steer: (text: string) => Promise<void>;
 outcome: Promise<boolean>;
}
const active = new Map<string, {offer:(id:string,text:string)=>Promise<SteeringReceipt|null>}>();
const key=(chatId:string,roleId:string)=>JSON.stringify([chatId,roleId]);

export function registerChatSteering(input: Input) {
 const entries=new Map<string,Pending>();
 let closed=false;
 const registration={
  async offer(id:string,text:string):Promise<SteeringReceipt|null> {
   if(closed)return null;
   const previous=entries.get(id);
   if(previous)return await previous.ready ? previous.receipt : null;
   let resolve!:(ok:boolean)=>void;
   const consumed=new Promise<boolean>(r=>resolve=r);
   const entry:Pending={
    text:`Уточнение владельца (сообщение ${id}):\n${text}`,
    receipt:{consumed,outcome:input.outcome},resolve,seen:false,ready:Promise.resolve(false),
   };
   entries.set(id,entry);
   // Install before invoking SDK: a synchronous message event must not be lost.
   entry.ready=(async()=>{
    try {await input.steer(entry.text);return true;}
    catch {entries.delete(id);entry.resolve(false);return false;}
   })();
   return await entry.ready ? entry.receipt : null;
  },
 };
 const id=key(input.chatId,input.roleId);
 active.set(id,registration);
 return {
  observe(event:any) {
   if(event?.type!=="message_start" || event.message?.role!=="user")return;
   const content=event.message.content;
   const text=typeof content==="string" ? content : (content??[]).filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");
   for(const entry of entries.values())if(entry.text===text)entry.seen=true;
  },
  close() {
   if(closed)return;
   closed=true;
   if(active.get(id)===registration)active.delete(id);
   for(const entry of entries.values())entry.resolve(entry.seen);
  },
 };
}

export async function offerChatSteering(chatId:string,roleId:string,messageId:string,text:string):Promise<SteeringReceipt|null> {
 return active.get(key(chatId,roleId))?.offer(messageId,text) ?? null;
}
