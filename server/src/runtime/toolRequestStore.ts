import crypto from "node:crypto";
import db from "../db.js";
import type {RequestStore,RequestRecord} from "./universalTaskflow.js";

const instance=crypto.randomUUID();
export const TOOL_REQUEST_SCHEMA=`CREATE TABLE IF NOT EXISTS role_tool_requests (
 actor TEXT NOT NULL, id TEXT NOT NULL, scope TEXT NOT NULL, hash TEXT NOT NULL,
 operation TEXT NOT NULL, state TEXT NOT NULL, instance TEXT NOT NULL, result TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(actor,id));`;
export const toolRequestStore:RequestStore={
 get(actor,id){
  const r=db.prepare("SELECT * FROM role_tool_requests WHERE actor=? AND id=?").get(actor,id??"") as any;
  if(!r)return;
  return {actor:r.actor,id:r.id,scope:r.scope,hash:r.hash,operation:r.operation,state:r.state==="running"&&r.instance!==instance?"unknown_outcome":r.state,result:r.result?JSON.parse(r.result):undefined};
 },
 begin(r){
  return db.prepare("INSERT OR IGNORE INTO role_tool_requests(actor,id,scope,hash,operation,state,instance) VALUES(?,?,?,?,?,?,?)").run(r.actor,r.id,r.scope,r.hash,r.operation,r.state,instance).changes===1;
 },
 finish(actor,id,state,result){
  const changed=db.prepare("UPDATE role_tool_requests SET state=?,result=?,updated_at=datetime('now') WHERE actor=? AND id=? AND instance=?").run(state,JSON.stringify(result),actor,id,instance).changes;
  if(changed!==1)throw new Error("Не удалось сохранить результат запроса");
 }
};
export function checkToolRequestStore(){
 const rollback=new Error("probe_complete");
 try {db.transaction(()=>{
  const r:RequestRecord={actor:"tool-store-probe",id:crypto.randomUUID(),scope:"probe",hash:"probe",operation:"probe",state:"running"};
  if(!toolRequestStore.begin(r)||toolRequestStore.begin(r))throw new Error("Дубликат запроса не отсечён");
  toolRequestStore.finish(r.actor,r.id,"succeeded",{ok:true});
  if(toolRequestStore.get(r.actor,r.id)?.result?.ok!==true)throw new Error("Результат запроса потерян");
  throw rollback;
 })();}catch(error){return error===rollback?{ok:true}:{ok:false,reason:String(error)};}
 return {ok:false,reason:"Проба не завершилась"};
}
export function startToolRequestWatcher(){
 const check=()=>{
  const r=checkToolRequestStore();if(r.ok)return;
  const type="role_tool_requests_watch";
  if(db.prepare("SELECT 1 FROM notifications WHERE type=? AND created_at>=datetime('now','-1 day') LIMIT 1").get(type))return;
  for(const owner of db.prepare("SELECT id FROM users WHERE role='owner'").all() as {id:string}[])
   db.prepare("INSERT INTO notifications(id,user_id,type,text) VALUES(?,?,?,?)").run(crypto.randomUUID(),owner.id,type,"Журнал операций ролей не работает: "+r.reason+". Защита от повторов недоступна. Проверить миграцию 151_unified_role_tool_requests и выполнить checkToolRequestStore.");
 };
 check();const timer=setInterval(check,15*60*1000);timer.unref();return ()=>clearInterval(timer);
}
