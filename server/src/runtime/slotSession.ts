import { branchMembership } from "./branchPlan.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import db from "../db.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const tails=new Map<string,Promise<void>>();
/** Занят ли слот: кто-то держит или ждёт сессию шага. Для диагностики. */
export function isSlotSessionHeld(subtaskId:string):boolean{return tails.has(subtaskId);}
/** Принудительно отпустить слот, если прежний держатель повис и уже не
 *  отпустит его сам (поток модели оборвался, completion не разрешился).
 *  Звать только когда живого запуска шага нет — иначе получим двух писателей.
 *  Прецедент 15.10.2026, карточка caecdeee: /restart отвечал «Сессия слота
 *  занята», пока процесс сервера не перезапустили. */
export function forceReleaseSlotSession(subtaskId:string):boolean{return tails.delete(subtaskId);}
/** Work and discussion share one writer, including preparation before activeRuns registration.
 *  Короткая аренда (владелец 21.10.2026, карточка c8083c2a, раздел И4): 
 *  ожидание прежнего держателя не бесконечно. Держатель без живого запуска
 *  слот сам не отпустит — это потерянная аренда, из-за которой слот висит
 *  пустым, а новый ход ждёт вечно (прецедент 15.10.2026, карточка caecdeee:
 *  /restart отвечал «Сессия слота занята», пока не перезапустили сервер).
 *  Поэтому: ждём до `leaseWaitMs`, затем спрашиваем `holderAlive` — если
 *  живого хода по слоту нет, берём слот себе. */
function leaseWaitMs():number{
  const raw=Number(process.env.TASKFLOW_SLOT_LEASE_WAIT_MS);
  return Number.isFinite(raw)&&raw>0?raw:3_000;
}
export async function acquireSlotSession(subtaskId:string,signal?:AbortSignal,holderAlive?:()=>boolean):Promise<()=>void> {
  const previous=tails.get(subtaskId) ?? Promise.resolve();
  let releaseGate!:()=>void;
  const next=new Promise<void>(resolve=>{releaseGate=resolve;});
  tails.set(subtaskId,next);
  let released=false;
  const release=()=>{if(released)return;released=true;releaseGate();if(tails.get(subtaskId)===next)tails.delete(subtaskId);};
  let abort=()=>{};
  try {
    await new Promise<void>((resolve,reject)=>{
      abort=()=>reject(signal?.reason ?? new Error("Сессия отменена"));
      if(signal?.aborted){abort();return;}
      signal?.addEventListener("abort",abort,{once:true});
      const done=()=>{signal?.removeEventListener("abort",abort);resolve();};
      void previous.then(done);
      if(!holderAlive)return;
      // Короткая аренда: если прежнего держателя нет среди живых ходов —
      // это не ожидание, а потерянная запись о занятости.
      const timer=setTimeout(()=>{
        if(!holderAlive()){done();return;}
        void previous.then(done);
      },leaseWaitMs());
      const stop=()=>clearTimeout(timer);
      void previous.then(stop,stop);
      signal?.addEventListener("abort",stop,{once:true});
    });
  } catch(error){void previous.then(release);throw error;}
  finally{signal?.removeEventListener("abort",abort);}
  return release;
}
export function slotSessionDirectory(taskId:string,role:string,subtaskId:string):string {
  const root=process.env.TASKFLOW_RUNS_DIR || path.join(os.homedir(),".local","state","taskflow-runs");
  return path.join(root,"sessions",`${taskId}-${role}-${subtaskId}`);
}

/* ── Обсуждение карточки: своя аренда и своя сессия ───────────────────────
 *
 * Обсуждение НЕ берёт аренду рабочего слота (контракт архитектора
 * f3ada2e0, §1.4): иначе обсуждение блокирует работу исполнителя, а
 * требование — «работа продолжается во время обсуждения». Аренда
 * обсуждения отдельная и keyed по discussion_id.
 */
const discussionTails=new Map<string,Promise<void>>();
export function isDiscussionSessionHeld(discussionId:string):boolean{return discussionTails.has(discussionId);}
export function forceReleaseDiscussionSession(discussionId:string):boolean{return discussionTails.delete(discussionId);}
/** Аренда обсуждения: один ход обсуждения за раз, рабочий слот не трогаем. */
export async function acquireDiscussionSession(discussionId:string,signal?:AbortSignal):Promise<()=>void>{
  const previous=discussionTails.get(discussionId) ?? Promise.resolve();
  let releaseGate!:()=>void;
  const next=new Promise<void>(resolve=>{releaseGate=resolve;});
  discussionTails.set(discussionId,next);
  let released=false;
  const release=()=>{if(released)return;released=true;releaseGate();if(discussionTails.get(discussionId)===next)discussionTails.delete(discussionId);};
  let abort=()=>{};
  try{
    await new Promise<void>((resolve,reject)=>{
      abort=()=>reject(signal?.reason ?? new Error("Обсуждение отменено"));
      if(signal?.aborted){abort();return;}
      signal?.addEventListener("abort",abort,{once:true});
      void previous.then(()=>{signal?.removeEventListener("abort",abort);resolve();});
    });
  }catch(error){void previous.then(release);throw error;}
  finally{signal?.removeEventListener("abort",abort);}
  return release;
}
/** Каталог сессии обсуждения: свой, рабочий файл сюда не попадает. */
export function discussionSessionDirectory(taskId:string,role:string,subtaskId:string,discussionId:string):string {
  const root=process.env.TASKFLOW_RUNS_DIR || path.join(os.homedir(),".local","state","taskflow-runs");
  return path.join(root,"sessions",`${taskId}-${role}-${subtaskId}-discussion`,discussionId);
}
/** Сессия обсуждения: отдельный файл, рабочая история не наследуется. */
export function openDiscussionSession(taskId:string,role:string,subtaskId:string,discussionId:string,fallbackCwd:string):SessionManager {
  const dir=discussionSessionDirectory(taskId,role,subtaskId,discussionId);
  fs.mkdirSync(dir,{recursive:true});
  const candidates=fs.readdirSync(dir).filter(name=>name.endsWith(".jsonl")).map(name=>path.join(dir,name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  const file=candidates[0];
  const manager=file ? SessionManager.open(file,dir) : SessionManager.create(fallbackCwd,dir);
  return manager;
}
/** Adopt the original work file, regardless of its cwd; never fork to a chat session. */
export function openSlotSession(taskId:string,role:string,subtaskId:string,fallbackCwd:string,fresh=false):SessionManager {
  const dir=slotSessionDirectory(taskId,role,subtaskId);
  fs.mkdirSync(dir,{recursive:true});
  const saved=db.prepare("SELECT session_file FROM slot_sessions WHERE subtask_id=?").get(subtaskId) as {session_file:string}|undefined;
  const candidates=fs.readdirSync(dir).filter(name=>name.endsWith(".jsonl")).map(name=>path.join(dir,name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  const file=saved && path.dirname(saved.session_file)===dir && fs.existsSync(saved.session_file) ? saved.session_file : candidates[0];
  const manager=!fresh && file ? SessionManager.open(file,dir) : SessionManager.create(fallbackCwd,dir);
  rememberSlotSession(subtaskId,manager);
  return manager;
}
/**
 * Выжимка прежней сессии шага — для свежего агента при замене исполнителя
 * (владелец 16.10.2026: «почему у них памяти о прошлых заходах нет»).
 * Раньше свежий старт выбрасывал всё, что прежний агент выяснил и не записал
 * в карточку. Без модели: последние выводы агента и его последние действия.
 */
export function previousSessionDigest(taskId:string,role:string,subtaskId:string,maxChars=8000):string|null {
  try {
    const dir=slotSessionDirectory(taskId,role,subtaskId);
    if(!fs.existsSync(dir))return null;
    const saved=db.prepare("SELECT session_file FROM slot_sessions WHERE subtask_id=?").get(subtaskId) as {session_file:string}|undefined;
    const files=fs.readdirSync(dir).filter(n=>n.endsWith(".jsonl")).map(n=>path.join(dir,n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
    const file=saved&&fs.existsSync(saved.session_file)?saved.session_file:files[0];
    if(!file)return null;
    const thoughts:string[]=[]; const actions:string[]=[];
    for(const line of fs.readFileSync(file,"utf8").split("\n")){
      if(!line.trim())continue;
      let row:any; try{row=JSON.parse(line);}catch{continue;}
      const m=row?.message; if(m?.role!=="assistant"||!Array.isArray(m.content))continue;
      for(const c of m.content){
        if(c?.type==="text"&&String(c.text??"").trim())thoughts.push(String(c.text).trim().slice(0,500));
        if(c?.type==="toolCall"){const a=c.arguments??{};actions.push(`${c.name}: ${String(a.command??a.path??JSON.stringify(a)).replace(/\s+/g," ").slice(0,180)}`);}
      }
    }
    if(!thoughts.length&&!actions.length)return null;
    const out=["Выводы и сообщения прежнего исполнителя (последние):",...thoughts.slice(-12).map(t=>"— "+t),"","Его последние действия:",...actions.slice(-25).map(a=>"· "+a)].join("\n");
    return out.length>maxChars?out.slice(out.length-maxChars):out;
  } catch { return null; }
}
export function rememberSlotSession(subtaskId:string,manager:SessionManager):void {
  const file=manager.getSessionFile();
  if(!file)return;
  // finally в runRoleInProcess может сработать после удаления субтаска
  // (тестовая уборка, ручной DELETE из админки). FK CASCADE не спасёт
  // INSERT — субтаска уже нет. Проглатываем код SQLITE_CONSTRAINT_FOREIGNKEY,
  // остальные ошибки пробрасываем: упавший апдейт — это уже потеря данных.
  try {
    db.prepare("INSERT INTO slot_sessions(subtask_id,session_file,cwd,session_id) VALUES(?,?,?,?) ON CONFLICT(subtask_id) DO UPDATE SET session_file=excluded.session_file,cwd=excluded.cwd,session_id=excluded.session_id,updated_at=datetime('now')").run(subtaskId,file,manager.getCwd(),manager.getSessionId());
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") return;
    throw error;
  }
}
export type TopicSlot={id:string;task_id:string;title:string;plan_node_key:string;agent_state:string|null;done:number};
export function topicSlots(taskId:string,role:string):TopicSlot[] {
  return db.prepare("SELECT s.id,s.task_id,s.title,s.plan_node_key,s.agent_state,s.done FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key JOIN task_collaboration_plans p ON p.id=n.plan_id WHERE s.task_id=? AND p.status='approved' AND n.role_key=? AND n.skipped_at IS NULL ORDER BY s.position,s.rowid").all(taskId,role) as TopicSlot[];
}
export function resolveTopicSlot(taskId:string,role:string,key?:string,recipientId?:string):TopicSlot|null {
  const rows=topicSlots(taskId,role);
  if(recipientId){
    const local=rows.find(row=>row.id===recipientId);if(local)return local;
    const other=db.prepare("SELECT task_id FROM subtasks WHERE id=?").get(recipientId) as {task_id:string}|undefined;
    const branch=branchMembership(taskId);
    return other && branch && branchMembership(other.task_id)?.root_plan_id===branch.root_plan_id ? topicSlots(other.task_id,role).find(row=>row.id===recipientId) ?? null : null;
  }
  if(key)return rows.find(row=>row.plan_node_key===key || row.title===key) ?? null;
  return rows.length===1 ? rows[0] : null;
}
