import crypto from "node:crypto";
import db from "../db.js";
import {broadcastToUsers} from "../ws.js";
import {loadChatMessage} from "../lib/chatMessages.js";

type Origin={chat_id:string;message_id:string;requester_id:string};
export type Coordination={
 question_id:string;recipient_id:string;requester_name:string;recipient_name:string;question:string;
 child_chat_id:string;origin_message_id:string;status:string;activity:string;
 created_at:string;last_activity_at:string;answer?:string;terminal:boolean;
};
const parse=(raw:string|null)=>{try{return JSON.parse(raw??"{}");}catch{return {};}};
const title=(id:string)=>(db.prepare("SELECT name FROM users WHERE id=?").get(id) as {name:string}|undefined)?.name??"Роль";
const member=(chat:string,id:string)=>!!db.prepare("SELECT 1 FROM chat_members WHERE chat_id=? AND member_id=?").get(chat,id);
let probing=false;
function publish(id:string){
 if(probing)return;
 const message=loadChatMessage(id);if(!message)return;
 const audience=(db.prepare("SELECT member_id FROM chat_members WHERE chat_id=?").all(message.chat_id) as {member_id:string}[]).map(r=>r.member_id);
 broadcastToUsers(audience,{type:"chat:new",message});
}
export function registerCoordinationOrigin(questionId:string,parentId:string,senderId:string){
 const parent=db.prepare("SELECT chat_id,steps FROM chat_messages WHERE id=?").get(parentId) as {chat_id:string;steps:string|null}|undefined;
 if(!parent || !member(parent.chat_id,senderId))return;
 const origin:Origin=parse(parent.steps).coordination_origin??{chat_id:parent.chat_id,message_id:parentId,requester_id:senderId};
 if(!member(origin.chat_id,origin.requester_id))return;
 const row=db.prepare("SELECT steps FROM chat_messages WHERE id=?").get(questionId) as {steps:string|null}|undefined;if(!row)return;
 const steps={duration_ms:0,items:[],...parse(row.steps),coordination_origin:origin};
 db.prepare("UPDATE chat_messages SET steps=? WHERE id=?").run(JSON.stringify(steps),questionId);
}
function card(questionId:string,recipientId:string){
 return db.prepare("SELECT id,chat_id,steps FROM chat_messages WHERE message_type='system' AND json_valid(steps) AND json_extract(steps,'$.coordination.question_id')=? AND json_extract(steps,'$.coordination.recipient_id')=? LIMIT 1").get(questionId,recipientId) as {id:string;chat_id:string;steps:string}|undefined;
}
export function ensureCoordinationCard(questionId:string,recipientId:string){
 if(card(questionId,recipientId))return;
 const question=db.prepare("SELECT chat_id,text,steps,from_user_id FROM chat_messages WHERE id=?").get(questionId) as {chat_id:string;text:string;steps:string;from_user_id:string}|undefined;
 const origin:Origin|undefined=parse(question?.steps??null).coordination_origin;
 if(!question||!origin||!member(origin.chat_id,origin.requester_id))return;
 const id=crypto.randomUUID(),now=new Date().toISOString();
 const c:Coordination={question_id:questionId,recipient_id:recipientId,requester_name:title(question.from_user_id),recipient_name:title(recipientId),question:question.text,child_chat_id:question.chat_id,origin_message_id:origin.message_id,status:"queued",activity:"Вопрос принят сервером и ожидает обработки",created_at:now,last_activity_at:now,terminal:false};
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,message_type,reply_to_message_id,steps) VALUES(?,?,?,'chat',?,'system',?,?)")
  .run(id,origin.requester_id,c.requester_name+" → "+c.recipient_name+": вопрос в очереди",origin.chat_id,origin.message_id,JSON.stringify({duration_ms:0,items:[],coordination:c}));
 publish(id);
}
export function coordinationCardData(row:{steps?:string|null}):Coordination|undefined{
 const c:Coordination|undefined=parse(row.steps??null).coordination;
 if(!c || c.terminal)return c;
 const q=db.prepare("SELECT status FROM chat_message_queue WHERE message_id=? AND role_id=?").get(c.question_id,c.recipient_id) as {status:string}|undefined;
 if(q?.status==="failed" || q?.status==="superseded")return {...c,status:q.status==="failed"?"error":"cancelled",activity:q.status==="failed"?"Не удалось получить ответ":"Обращение отменено или относится к завершённой сессии",terminal:true};
 if(q?.status==="pending" && !["delivered","busy"].includes(c.status))return {...c,status:"queued",activity:"Вопрос находится в очереди; запуск ещё не подтверждён"};
 return c;
}
export function updateCoordination(questionId:string,recipientId:string,patch:Partial<Coordination>){
 const row=card(questionId,recipientId);if(!row)return;
 const c:Coordination=parse(row.steps).coordination;
 // Late tokens from a cancelled/superseded run cannot resurrect it.
 if(c.terminal && patch.status!=='cancelled')return;
 Object.assign(c,patch);
 db.prepare("UPDATE chat_messages SET text=?,steps=? WHERE id=?").run(c.requester_name+" → "+c.recipient_name+": "+c.activity,JSON.stringify({duration_ms:0,items:[],coordination:c}),row.id);
 publish(row.id);
}
export function coordinationDeliveryChanged(deliveryId:string){
 const q=db.prepare("SELECT message_id,role_id,status FROM chat_message_queue WHERE id=?").get(deliveryId) as {message_id:string;role_id:string;status:string}|undefined;if(!q?.message_id)return;
 ensureCoordinationCard(q.message_id,q.role_id);
 const now=new Date().toISOString();
 if(q.status==="picked")updateCoordination(q.message_id,q.role_id,{status:"starting",activity:"Вопрос взят из очереди; готовится запуск",last_activity_at:now});
 if(q.status==="failed"||q.status==="superseded")updateCoordination(q.message_id,q.role_id,{status:q.status==="failed"?"error":"cancelled",activity:q.status==="failed"?"Не удалось получить ответ":"Обращение остановлено или отменено",terminal:true,last_activity_at:now});
 if(q.status==="done"){
  const reply=db.prepare("SELECT text FROM chat_messages WHERE reply_to_message_id=? AND from_user_id=? ORDER BY rowid DESC LIMIT 1").get(q.message_id,q.role_id) as {text:string}|undefined;
  updateCoordination(q.message_id,q.role_id,reply?{status:"answered",activity:"Ответ получен",answer:reply.text,terminal:true,last_activity_at:now}:{status:"delivered",activity:"Вопрос доставлен в рабочую сессию; ответ ещё не получен",last_activity_at:now});
 }
}
const lastUpdate=new Map<string,number>();
export function coordinationActivity(questionId:string|undefined,recipientId:string,event:any){
 if(!questionId)return;
 const sub=event?.assistantMessageEvent?.type;
 let status:string|undefined,activity:string|undefined;
 if(sub==="thinking_start"||sub==="thinking_delta"){status="thinking";activity="Роль думает над вопросом";}
 if(sub==="text_delta"){status="responding";activity="Роль пишет ответ";}
 if(event?.type==="tool_execution_start"){status="working";activity="Выполняет: "+String(event.toolName??"действие");if(event.args?.operation)activity+=" · "+String(event.args.operation);}
 if(!status)return;
 const key=questionId+":"+recipientId,now=Date.now();
 if(event.type!=="tool_execution_start" && now-(lastUpdate.get(key)??0)<2000)return;
 lastUpdate.set(key,now);if(lastUpdate.size>1000)lastUpdate.delete(lastUpdate.keys().next().value!);
 updateCoordination(questionId,recipientId,{status,activity,last_activity_at:new Date(now).toISOString()});
}
export function coordinationAnswered(questionId:string,recipientId:string,answer:string,failed=false){
 updateCoordination(questionId,recipientId,{status:failed?"error":"answered",activity:failed?"Ход завершился ошибкой":"Ответ получен",answer,terminal:true,last_activity_at:new Date().toISOString()});
}

// Probe writes and reads the same card mechanism inside a rolled-back transaction.
// No role is launched and no probe messages are broadcast.
export function checkChatCoordination(){
 const rollback=new Error("probe_complete");probing=true;
 try{db.transaction(()=>{
  const owner=db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as {id:string}|undefined;
  const roles=db.prepare("SELECT id FROM users WHERE role_key IS NOT NULL LIMIT 2").all() as {id:string}[];
  if(!owner || roles.length<2)throw new Error("Нет владельца или двух ролей для пробы");
  const id="coord-probe-"+crypto.randomUUID(),child=id+"-child";
  for(const c of [id,child])db.prepare("INSERT INTO chats(id,kind,title,created_by) VALUES(?,'direct','Проба обращения',?)").run(c,owner.id);
  for(const [c,u] of [[id,owner.id],[id,roles[0].id],[child,roles[0].id],[child,roles[1].id]])
   db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(c,u);
  const insert=db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,'Проба','chat',?)");
  insert.run(id,owner.id,id);insert.run(child,roles[0].id,child);
  registerCoordinationOrigin(child,id,roles[0].id);ensureCoordinationCard(child,roles[1].id);
  coordinationAnswered(child,roles[1].id,"Проба ответа");
  const row=card(child,roles[1].id);
  if(!row || coordinationCardData(row)?.answer!=="Проба ответа")throw new Error("Обращение/ответ не вернулись в исходный чат");
  throw rollback;
 })();}catch(error){return error===rollback?{ok:true}:{ok:false,reason:String(error)};}finally{probing=false;}
 return {ok:false,reason:"Проба не завершилась"};
}
export function startChatCoordinationWatcher(){
 const check=()=>{const r=checkChatCoordination();if(r.ok)return;
  const type="chat_coordination_watch";
  if(db.prepare("SELECT 1 FROM notifications WHERE type=? AND created_at>=datetime('now','-1 day')").get(type))return;
  for(const owner of db.prepare("SELECT id FROM users WHERE role='owner'").all() as {id:string}[])
   db.prepare("INSERT INTO notifications(id,user_id,type,text) VALUES(?,?,?,?)").run(crypto.randomUUID(),owner.id,type,"Цепочка обращений в чате не сохраняется: "+r.reason+". Статусы коллег могут быть не видны. Проверить chatCoordination.ts и выполнить checkChatCoordination.");
 };
 check();const timer=setInterval(check,15*60*1000);timer.unref();return ()=>clearInterval(timer);
}

export function traceCoordination(action:()=>unknown){try{action();}catch(error){console.warn("[chat-coordination] status update failed:",error instanceof Error?error.message:String(error));}}
