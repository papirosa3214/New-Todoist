import {createHash} from "node:crypto";
import db from "../db.js";

let schemaReady = false;
export function ensureModelUsageSchema() {
 if(schemaReady)return;
 db.exec(`CREATE TABLE IF NOT EXISTS model_usage (
 id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
 input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read INTEGER NOT NULL,
 cache_write INTEGER NOT NULL, estimated_cost_usd REAL, source TEXT NOT NULL, task_id TEXT);
 CREATE INDEX IF NOT EXISTS idx_model_usage_time ON model_usage(occurred_at);`);
 schemaReady=true;
}
const count=(v:unknown): v is number => typeof v==="number" && Number.isSafeInteger(v) && v>=0;
function canonical(v:any):string {
 if(Array.isArray(v))return "["+v.map(canonical).join(",")+"]";
 if(v && typeof v==="object")return "{"+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}";
 return JSON.stringify(v)??"null";
}
/** Only numerical metadata is stored. Stable fingerprint deduplicates replayed/copied session messages. */
export function recordModelUsage(message:unknown,source:string,taskId:string|null=null):boolean {
 const m=message as any,u=m?.usage;
 if(m?.role!=="assistant" || !u || !count(m.timestamp) || !Number.isFinite(new Date(m.timestamp).getTime()))return false;
 if(![u.input,u.output,u.cacheRead??0,u.cacheWrite??0].every(count))return false;
 const provider=typeof m.provider==="string"?m.provider:"unknown";
 const model=typeof m.model==="string"?m.model:"unknown";
 const cost=typeof u.cost?.total==="number" && Number.isFinite(u.cost.total) && u.cost.total>0?u.cost.total:null;
 const id=createHash("sha256").update(canonical({timestamp:m.timestamp,provider,model,usage:u,content:m.content})).digest("hex");
 ensureModelUsageSchema();
 const r=db.prepare("INSERT OR IGNORE INTO model_usage(id,occurred_at,provider,model,input_tokens,output_tokens,cache_read,cache_write,estimated_cost_usd,source,task_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
 id,new Date(m.timestamp).toISOString(),provider,model,u.input,u.output,u.cacheRead??0,u.cacheWrite??0,cost,source,taskId);
 return r.changes>0;
}
const aggregate=`count(*) calls,COALESCE(sum(input_tokens),0) inputTokens,COALESCE(sum(output_tokens),0) outputTokens,
 COALESCE(sum(cache_read),0) cacheReadTokens,COALESCE(sum(cache_write),0) cacheWriteTokens,
 sum(estimated_cost_usd) estimatedCostUsd,COALESCE(sum(estimated_cost_usd IS NULL),0) unpricedCalls`;
function decorate(r:any) {
 const input=r.inputTokens+r.cacheReadTokens+r.cacheWriteTokens;
 return {...r,totalTokens:input+r.outputTokens,cacheHitRate:input>0?r.cacheReadTokens/input:null};
}
export function readModelUsage(window:string) {
 const days=window==="today"?0:window==="week"?7:window==="month"?30:null;
 if(days===null)throw new Error("invalid_window");
 ensureModelUsageSchema();
 // Today uses the owner's Moscow calendar; rolling windows use exact elapsed days.
 const now=Date.now(),day=new Date(now+3*3600000).toISOString().slice(0,10);
 const since=days===0?new Date(day+"T00:00:00+03:00").toISOString():new Date(now-days*86400000).toISOString();
 const totals=decorate(db.prepare(`SELECT ${aggregate} FROM model_usage WHERE occurred_at>=?`).get(since));
 const models=(db.prepare(`SELECT provider,model,${aggregate} FROM model_usage WHERE occurred_at>=? GROUP BY provider,model ORDER BY sum(input_tokens+output_tokens+cache_read+cache_write) DESC`).all(since) as any[]).map(decorate);
 const daily=(db.prepare(`SELECT date(occurred_at,'+3 hours') day,${aggregate} FROM model_usage WHERE occurred_at>=? GROUP BY day ORDER BY day`).all(since) as any[]).map(decorate);
 const dailyByModel=(db.prepare(`SELECT date(occurred_at,'+3 hours') day,provider,model,${aggregate} FROM model_usage WHERE occurred_at>=? GROUP BY day,provider,model ORDER BY day`).all(since) as any[]).map(decorate);
 const trackingSince=(db.prepare("SELECT min(occurred_at) first FROM model_usage").get() as any).first;
 return {window,since,trackingSince,scope:"taskflow_roles",currency:"USD",costBasis:"sdk_estimate",totals,models,daily,dailyByModel};
}
