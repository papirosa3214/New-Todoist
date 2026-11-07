// Эффективность JEV (владелец 27.10.2026): польза оценщика — меньше блоков
// и ошибок, меньше токенов и времени. Сравниваем шаги, где направление
// сработало, с шагами, где оно было выключено или не ответило. Это
// наблюдение, а не опыт: шаги разные, поэтому смотрим на число шагов в группе.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db from "../db.js";
import {observationSince} from "./contextObservability.js";

const BAD = ["blocked","error_loop","stalled","stalled_blocked","failed"];
const sessionsDir = () => path.join(process.env.TASKFLOW_RUNS_DIR || path.join(os.homedir(),".local","state","taskflow-runs"),"sessions");

/** Токены и стоимость шага — из файлов сессии роли (`<task>-<role>-<subtask>`). */
export function stepUsage(taskId:string,subtaskId:string,root=sessionsDir()):{tokens:number;costUsd:number}{
 let tokens=0,costUsd=0;
 let dirs:string[]=[];
 try{dirs=fs.readdirSync(root).filter(d=>d.startsWith(taskId+"-")&&d.endsWith("-"+subtaskId));}catch{return {tokens,costUsd};}
 for(const d of dirs){
  let files:string[]=[];try{files=fs.readdirSync(path.join(root,d)).filter(f=>f.endsWith(".jsonl"));}catch{continue;}
  for(const f of files){
   let text="";try{text=fs.readFileSync(path.join(root,d,f),"utf8");}catch{continue;}
   for(const line of text.split("\n")){
    if(!line.includes("\"usage\""))continue;
    try{const u=JSON.parse(line)?.message?.usage;if(u&&typeof u.totalTokens==="number"){tokens+=u.totalTokens;costUsd+=Number(u.cost?.total)||0;}}catch{}
   }
  }
 }
 return {tokens,costUsd};
}

type Group={steps:number;badSteps:number;attempts:number;tokens:number;costUsd:number;minutes:number};
const empty=():Group=>({steps:0,badSteps:0,attempts:0,tokens:0,costUsd:0,minutes:0});
const finish=(g:Group)=>({steps:g.steps,badShare:g.steps?+(g.badSteps/g.steps).toFixed(2):null,attemptsPerStep:g.steps?+(g.attempts/g.steps).toFixed(2):null,
 tokensPerStep:g.steps?Math.round(g.tokens/g.steps):null,costPerStepUsd:g.steps?+(g.costUsd/g.steps).toFixed(4):null,minutesPerStep:g.steps?+(g.minutes/g.steps).toFixed(1):null});

export function readJevEffectiveness(window="week",root?:string){
 const since=observationSince(window);
 // На шаг: сработало ли направление хоть раз (ok) или только пропуск/тайм-аут.
 const marks=db.prepare(`SELECT scenario,task_id taskId,subtask_id subtaskId,max(status='ok') used FROM context_operations
   WHERE kind='jev' AND subtask_id IS NOT NULL AND task_id IS NOT NULL AND started_at>=? GROUP BY scenario,task_id,subtask_id`).all(since) as {scenario:string;taskId:string;subtaskId:string;used:number}[];
 const attempts=db.prepare(`SELECT subtask_id subtaskId,outcome,(julianday(COALESCE(ended_at,heartbeat_at,started_at))-julianday(started_at))*1440 minutes
   FROM attempts WHERE subtask_id IS NOT NULL AND started_at>=?`).all(since) as {subtaskId:string;outcome:string|null;minutes:number|null}[];
 const bySubtask=new Map<string,typeof attempts>();
 for(const a of attempts){const list=bySubtask.get(a.subtaskId)??[];list.push(a);bySubtask.set(a.subtaskId,list);}
 const usage=new Map<string,{tokens:number;costUsd:number}>();
 const out:Record<string,{on:Group;off:Group}>={};
 for(const m of marks){
  const list=bySubtask.get(m.subtaskId);if(!list?.length)continue;
  const key=m.taskId+"/"+m.subtaskId;
  if(!usage.has(key))usage.set(key,stepUsage(m.taskId,m.subtaskId,root));
  const u=usage.get(key)!;const g=(out[m.scenario]??={on:empty(),off:empty()})[m.used?"on":"off"];
  g.steps++;g.attempts+=list.length;g.tokens+=u.tokens;g.costUsd+=u.costUsd;
  g.minutes+=list.reduce((s,a)=>s+Math.max(0,a.minutes??0),0);
  if(list.some(a=>a.outcome&&BAD.includes(a.outcome)))g.badSteps++;
 }
 return {window,since,scenarios:Object.entries(out).map(([scenario,g])=>({scenario,on:finish(g.on),off:finish(g.off)}))};
}
