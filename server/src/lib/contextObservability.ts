import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import db from "../db.js";
export const OBSERVABILITY_SCHEMA = `
 CREATE TABLE IF NOT EXISTS context_operations (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, scenario TEXT NOT NULL,
 task_id TEXT, subtask_id TEXT, role TEXT, run_id TEXT, key_id TEXT,
 started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'running', reason TEXT, input_count INTEGER, output_count INTEGER,
 input_tokens INTEGER, output_tokens INTEGER, details TEXT NOT NULL DEFAULT '[]');
 CREATE INDEX IF NOT EXISTS idx_context_operations_time ON context_operations(started_at);
 CREATE INDEX IF NOT EXISTS idx_context_operations_key ON context_operations(key_id,started_at);
 CREATE TABLE IF NOT EXISTS context_observability_meta (id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL);
 INSERT OR IGNORE INTO context_observability_meta VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;
export type ObservationContext={taskId?:string;subtaskId?:string;role?:string;runId?:string};
const scope=new AsyncLocalStorage<ObservationContext>();
export function withObservationContext<T>(context:ObservationContext, fn:()=>T):T {return scope.run({...scope.getStore(),...Object.fromEntries(Object.entries(context).filter(([,v])=>v!==undefined))},fn);}
export function keyIdentity(base:string,key:string):string{return createHash('sha256').update(new URL(base).origin+'\0'+key).digest('hex');}
export function startObservation(kind:string,scenario:string,extra:ObservationContext & {keyId?:string}={}):string|null {
 try{const c={...scope.getStore(),...Object.fromEntries(Object.entries(extra).filter(([,v])=>v!==undefined))},id=randomUUID();db.prepare(`INSERT INTO context_operations(id,kind,scenario,task_id,subtask_id,role,run_id,key_id,started_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(id,kind,scenario,c.taskId??null,c.subtaskId??null,c.role??null,c.runId??null,extra.keyId??null,new Date().toISOString());return id;}
 catch{console.warn('context-observability: запись запуска недоступна');return null;}
}
const count=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
export type ObservationResult={status:string;reason?:string;inputCount?:number;outputCount?:number;durationMs?:number;details?:string[];usage?:{input_tokens?:number;output_tokens?:number}};
export function finishObservation(id:string|null,result:ObservationResult):void {
 if(!id)return;
 try{db.prepare(`UPDATE context_operations SET ended_at=?,duration_ms=COALESCE(?,MAX(0,CAST((julianday(?)-julianday(started_at))*86400000 AS INTEGER))),status=?,reason=?,input_count=?,output_count=?,input_tokens=?,output_tokens=?,details=? WHERE id=?`).run(new Date().toISOString(),count(result.durationMs),new Date().toISOString(),result.status,result.reason??null,count(result.inputCount),count(result.outputCount),count(result.usage?.input_tokens),count(result.usage?.output_tokens),JSON.stringify((result.details??[]).slice(0,30).map(x=>String(x).slice(0,300))),id);}
 catch{console.warn('context-observability: запись результата недоступна');}
}
export function updateObservation(id:string|null|undefined,result:Partial<ObservationResult>):void {
 if(!id)return;
 try{const row=db.prepare('SELECT status,reason,input_count,output_count,input_tokens,output_tokens,details,duration_ms FROM context_operations WHERE id=?').get(id) as any;if(!row)return;
 finishObservation(id,{status:row.status,reason:row.reason??undefined,inputCount:row.input_count,outputCount:row.output_count,durationMs:row.duration_ms,usage:{input_tokens:row.input_tokens,output_tokens:row.output_tokens},details:JSON.parse(row.details),...result,...(result.details?{details:[...(JSON.parse(row.details) as string[]).filter(x=>x.startsWith("model: ")),...result.details.filter(x=>!x.startsWith("model: "))]}:{})});}catch{console.warn('context-observability: уточнение результата недоступно');}
}
export function skippedObservation(scenario:string,reason:string,extra:ObservationContext={}):void{finishObservation(startObservation('jev',scenario,extra),{status:'skipped',reason});}
export function observationSince(window:string,now=Date.now()):string {
 const days=window==='24h'?1:window==='3d'?3:window==='week'?7:window==='month'?30:null;
 if(days===null)throw new Error('invalid_window');return new Date(now-days*86400000).toISOString();
}
function startedAt():string{return (db.prepare('SELECT started_at FROM context_observability_meta WHERE id=1').get() as any).started_at;}
const select=`SELECT o.id,o.kind,o.scenario,o.task_id taskId,o.subtask_id subtaskId,o.role,o.run_id runId,t.title taskTitle,o.started_at startedAt,o.ended_at endedAt,o.duration_ms durationMs,o.status,o.reason,o.input_count inputCount,o.output_count outputCount,o.input_tokens inputTokens,o.output_tokens outputTokens,o.details FROM context_operations o LEFT JOIN tasks t ON t.id=o.task_id`;
export function readObservability(window='24h') {
 const since=observationSince(window);
 const events=(db.prepare(select+' WHERE o.started_at>=? ORDER BY o.started_at DESC,o.rowid DESC LIMIT 100').all(since) as any[]).map(e=>({...e,details:JSON.parse(e.details)}));
 const summary=db.prepare(`SELECT kind,scenario,count(*) calls,sum(status='ok') succeeded,sum(status='skipped') skipped,sum(status IN ('error','timeout')) failed,sum(status='running') running,sum(duration_ms) durationMs,sum(input_count) inputCount,sum(output_count) outputCount FROM context_operations WHERE started_at>=? GROUP BY kind,scenario ORDER BY kind,scenario`).all(since);
 return {window,since,trackingSince:startedAt(),events,summary,limit:100};
}
export function readJevUsage(keyId:string|null,window='24h') {
 const since=observationSince(window);
 const where="kind='jev' AND key_id=? AND started_at>=? AND status<>'skipped'";
 const totals=db.prepare(`SELECT count(*) calls,COALESCE(sum(status='ok'),0) succeeded,COALESCE(sum(status IN ('error','timeout')),0) failed,COALESCE(sum(status='running'),0) running,COALESCE(sum(input_tokens),0) inputTokens,COALESCE(sum(output_tokens),0) outputTokens,COALESCE(sum(input_tokens IS NULL OR output_tokens IS NULL),0) unknownUsageCalls FROM context_operations WHERE ${where}`).get(keyId,since) as any;
 const scenarios=db.prepare(`SELECT scenario,count(*) calls,COALESCE(sum(input_tokens),0) inputTokens,COALESCE(sum(output_tokens),0) outputTokens,COALESCE(sum(input_tokens IS NULL OR output_tokens IS NULL),0) unknownUsageCalls FROM context_operations WHERE ${where} GROUP BY scenario ORDER BY scenario`).all(keyId,since);
 return {window,since,trackingSince:startedAt(),scope:'taskflow_current_key',hasKey:keyId!==null,...totals,scenarios,moneyStatus:'unavailable',balance:null,cost:null};
}
