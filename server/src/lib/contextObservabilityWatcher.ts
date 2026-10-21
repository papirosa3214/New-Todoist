import { randomUUID } from "node:crypto";
import db from "../db.js";
import {startObservation,finishObservation,readJevUsage} from "./contextObservability.js";
export function checkContextObservability():{ok:boolean} {
 const rollback=new Error('context-observability probe rollback'),probeKey='probe-'+randomUUID();
 try{db.transaction(()=>{const id=startObservation('jev','probe',{keyId:probeKey});if(!id)throw Error('write failed');finishObservation(id,{status:'ok',usage:{input_tokens:13,output_tokens:2}});const row=readJevUsage(probeKey,'24h');if(row.calls!==1||row.inputTokens!==13||row.unknownUsageCalls!==0)throw Error('read/aggregation failed');throw rollback;})();}catch(error){return {ok:error===rollback};}return {ok:false};
}
export function startContextObservabilityWatcher():()=>void {
 const check=()=>{try{if(checkContextObservability().ok)return;
 const type='context_observability_failed';if(db.prepare("SELECT 1 FROM notifications WHERE type=? AND created_at>=datetime('now','-1 day')").get(type))return;
 const owners=db.prepare("SELECT id FROM users WHERE role='owner'").all() as {id:string}[];
 for(const owner of owners)db.prepare('INSERT INTO notifications(id,user_id,type,text) VALUES(?,?,?,?)').run(randomUUID(),owner.id,type,'Учёт контекста и расхода JEV не проходит проверку записи и чтения. Данные в «Загрузке ролей» и настройках JEV могут быть неполными. Проверьте журнал сервера и docs/watchers.md.');}catch{console.warn('context-observability: сторож не смог проверить журнал');}};
 const first=setTimeout(check,60_000),timer=setInterval(check,15*60_000);first.unref();timer.unref();return()=>{clearTimeout(first);clearInterval(timer);};
}
