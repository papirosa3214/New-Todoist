import {mkdirSync,appendFileSync,writeFileSync,existsSync,chmodSync} from "node:fs";
import {join} from "node:path";
import {homedir} from "node:os";
import {randomUUID,createHash} from "node:crypto";
type AuditInput={role?:string;call_id:string;phase:"context"|"payload";content:unknown;[key:string]:unknown};
function scrub(value:any):any {
 if(Array.isArray(value))return value.map(scrub);
 if(value && typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,/^(api.?key|authorization|headers|cookie|access.?token|refresh.?token|client.?secret)$/i.test(key)?"[REDACTED]":scrub(v)]));
 return value;
}
/** Owner-authorized private archive, separate from metadata-only diagnostics. */
export function recordPromptAudit(input:AuditInput,directory?:string):void {
 if(input.role!=="secretary" || (process.env.VITEST && !directory))return;
 try {
  const root=directory ?? process.env.TASKFLOW_PROMPT_AUDIT_DIR ?? join(homedir(),".local/state/taskflow-prompt-audit");
  mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
  const objects=join(root,"objects");mkdirSync(objects,{recursive:true,mode:0o700});
  const content=JSON.stringify(scrub(input.content),null,2);
  const sha=createHash("sha256").update(content).digest("hex");const object=join(objects,sha+".json");
  if(!existsSync(object))writeFileSync(object,content+"\n",{mode:0o600,flag:"wx"});
  const at=new Date().toISOString();const {content:_,...metadata}=input;
  appendFileSync(join(root,at.slice(0,10)+".jsonl"),JSON.stringify({...metadata,at,sha256:sha,characters:content.length,object:"objects/"+sha+".json"})+"\n",{mode:0o600});
  writeFileSync(join(root,"latest.md"),"# Model request audit\n\n"+JSON.stringify({...metadata,at,sha256:sha},null,2)+"\n\n```json\n"+content+"\n```\n",{mode:0o600});
 }catch{
  console.warn("prompt-audit: recording failed; model request continues");
  void import("../db.js").then(({default:db})=>{
   const type="prompt_audit_watch";
   if(db.prepare("SELECT 1 FROM notifications WHERE type=? AND created_at > datetime(?,?)").get(type,"now","-1 day"))return;
   const owner=db.prepare("SELECT id FROM users WHERE role=? LIMIT 1").get("owner") as {id:string}|undefined;
   if(owner)db.prepare("INSERT INTO notifications(id,user_id,type,text) VALUES(?,?,?,?)").run(randomUUID(),owner.id,type,"Журнал запросов Помощника не записывается. Проверьте место и права ~/.local/state/taskflow-prompt-audit; обращения продолжаются.");
  }).catch(()=>{});
 }
}
