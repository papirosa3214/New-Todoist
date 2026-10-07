import { branchSnapshot,branchCards,branchRoot } from "./branchPlan.js";
import { unlockDependencyPlans } from "./planSubtaskAdmission.js";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, isOwner, isOrchestrator } from "../access.js";
import { prepareTask, validatePreparation } from "../lib/taskPreparation.js";
import { ensurePlanTopic, flushPlanTopicEvents } from "../lib/projectTopics.js";
import { logEvent } from "../agentState.js";
import { getFullTask } from "../routes/subtasks.js";
import { broadcastToUsers, broadcastTaskEvent } from "../ws.js";
import { ROLE_NAMES } from "../roleRouting.js";
import { createDraftPlan,proposalFor } from "../routes/task-collaboration-plans.js";

type Job = {id:number;task_id:string;input_version:number;snapshot:string;attempts:number;worker_id:string};
type Analyzer = (text:string,projects:Array<{id:string;name:string}>,options:any)=>Promise<Awaited<ReturnType<typeof prepareTask>>>;
const autoOrigins = new Set(["auto_template","linear_import","auto_preparation"]);

function protectedTask(task:any): boolean {
  if(!task || task.status!=="active" || !task.project_id || task.agent_state || task.ready_for_pickup || task.owner_selected_role) return true;
  if(db.prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id=? AND status='approved'").get(task.id)) return true;
  if(db.prepare("SELECT 1 FROM role_run_jobs WHERE task_id=? AND status IN ('queued','running')").get(task.id)) return true;
  const origins=db.prepare(`SELECT n.origin FROM task_collaboration_plan_nodes n JOIN task_collaboration_plans p ON p.id=n.plan_id WHERE p.task_id=? AND p.status='draft'`).all(task.id) as Array<{origin:string}>;
  return origins.some(n=>!autoOrigins.has(n.origin));
}

/** Every final write rechecks lease ownership, latest input and manual changes. */
function current(job:Job):any|null {
  const owned=db.prepare("SELECT 1 FROM task_preparation_jobs WHERE id=? AND status='running' AND worker_id=? AND lease_until>datetime('now')").get(job.id,job.worker_id);
  if(!owned) return null;
  const latest=db.prepare("SELECT MAX(id) AS id FROM task_preparation_jobs WHERE task_id=?").get(job.task_id) as {id:number};
  const task=db.prepare("SELECT * FROM tasks WHERE id=?").get(job.task_id) as any;
  const snapshot=JSON.parse(job.snapshot);
  if(latest.id!==job.id || task?.title!==snapshot.title || task?.description!==snapshot.description || task?.project_id!==snapshot.project_id){
    db.prepare("UPDATE task_preparation_jobs SET status='superseded',worker_id=NULL,lease_until=NULL WHERE id=? AND worker_id=?").run(job.id,job.worker_id);
    return null;
  }
  if(protectedTask(task)){
    db.prepare("UPDATE task_preparation_jobs SET status='skipped',worker_id=NULL,lease_until=NULL WHERE id=? AND worker_id=?").run(job.id,job.worker_id);
    return null;
  }
  return task;
}

export async function processOnePreparation(input:{workerId:string;analyze?:Analyzer;leaseSeconds?:number}):Promise<boolean> {
  const lease=Math.max(2,input.leaseSeconds??120);
  const job=db.transaction(()=>{
    db.prepare("UPDATE task_preparation_jobs SET status='queued',worker_id=NULL,lease_until=NULL WHERE status='running' AND lease_until<=datetime('now')").run();
    const row=db.prepare("SELECT * FROM task_preparation_jobs WHERE status='queued' AND available_at<=datetime('now') ORDER BY id LIMIT 1").get() as Job|undefined;
    if(!row) return undefined;
    db.prepare("UPDATE task_preparation_jobs SET status='running',worker_id=?,lease_until=datetime('now',?),attempts=attempts+1,updated_at=datetime('now') WHERE id=?").run(input.workerId,`+${lease} seconds`,row.id);
    return {...row,worker_id:input.workerId,attempts:row.attempts+1};
  })();
  if(!job) return false;
  const heartbeat=setInterval(()=>db.prepare("UPDATE task_preparation_jobs SET lease_until=datetime('now',?) WHERE id=? AND worker_id=? AND status='running'").run(`+${lease} seconds`,job.id,job.worker_id),lease*1000/3);
  heartbeat.unref();
  try {
    const task=db.transaction(()=>current(job))();
    if(!task) return true;
    const project=db.prepare("SELECT id,name,owner_id FROM projects WHERE id=?").get(task.project_id) as {id:string;name:string;owner_id:string};
    ensurePlanTopic(task.id);
    // Imported parents already own their children: never generate another decomposition.
    const children=db.prepare("SELECT id FROM tasks WHERE parent_id=? LIMIT 1").get(task.id);
    const existing=db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id=? AND status='draft' ORDER BY revision DESC LIMIT 1").get(task.id) as {id:string}|undefined;
    const recommendation=children ? null : await (input.analyze??prepareTask)(`${task.title}\n\n${task.description??""}`,[{id:project.id,name:project.name}],{
      provider:"minimax",ownerId:project.owner_id,maxChars:12000,sourceRecordId:`auto:${job.id}`,context:"Это существующая карточка в указанном проекте. Сохрани её цель и границы. Проверь достаточность постановки, предложи участников и зависимости. Не выполняй работу, не меняй даты или проект. При недостатке данных задай конкретный вопрос.",
    });
    const notification=db.transaction(()=>{
      if(!current(job)) return;
      let planId=children && existing ? existing.id : null;
      if(children && !existing){
        const proposal=proposalFor(task.id,'auto');
        planId=createDraftPlan(task.id,project.owner_id,proposal.profile,proposal.rationale,task.context_version??null,{nodes:proposal.nodes,edges:proposal.edges}).id;
        db.prepare("UPDATE task_collaboration_plan_nodes SET origin='auto_preparation' WHERE plan_id=?").run(planId);
      }
      let status="ready",question=recommendation?.question??(children && existing && task.needs_clarification ? task.clarification_question : null);
      if(recommendation && !recommendation.card) question=question||"Уточните поручение и ожидаемый результат.";
      const prep=recommendation?.card ? validatePreparation(recommendation.card.preparation,ROLE_NAMES) : null;
      question=question||prep?.question||null;
      if(prep?.representation==="child_cards"){
        status="structure_review";
        question=question||"Предложено разделение на дочерние карточки. Проверьте и согласуйте структуру перед запуском.";
      } else if(prep && !question){
        if(prep.workstreams.some(w=>!w.role)) question="Уточните исполнителя результата перед согласованием плана.";
        else {
          const consumed=new Set(prep.workstreams.flatMap(w=>w.depends_on));
          const keys=new Map(prep.workstreams.map((w,i)=>[w.key,`${w.key.slice(0,45)}_r${i}`]));
          const key=(slot:string)=>keys.get(slot)!;
          const nodes=prep.workstreams.map(w=>({slot_key:w.key,role_key:w.role!,required:true,expected_result:w.result,source_subtask_id:null,
            output_artifact:consumed.has(w.key)?{key:key(w.key),type:"result_pack",format:"json" as const,required_fields:["summary","evidence","document_refs"]}:null}));
          const edges=prep.workstreams.flatMap(w=>w.depends_on.map(from=>({from_slot_key:from,to_slot_key:w.key,start_condition:"submitted",artifact_key:key(from)})));
          const plan=createDraftPlan(task.id,project.owner_id,prep.workstreams.length===1?"single_executor":"manual",prep.reason,task.context_version??null,{nodes,edges});
          planId=plan.id;
          for(const w of prep.workstreams) db.prepare("UPDATE task_collaboration_plan_nodes SET origin='auto_preparation',instructions=? WHERE plan_id=? AND slot_key=?").run(JSON.stringify(w),plan.id,w.key);
        }
      }
      if(question){
        if(status!=="structure_review") status="needs_clarification";
        // Old automatic proposals must not remain actionable after missing information is found.
        db.prepare("UPDATE task_collaboration_plans SET status='superseded' WHERE task_id=? AND status='draft'").run(task.id);
        planId=null;
      }
      db.prepare("UPDATE tasks SET needs_clarification=?,clarification_question=? WHERE id=?").run(question?1:0,question,task.id);
      db.prepare("UPDATE task_preparation_jobs SET status=?,plan_id=?,result_json=?,worker_id=NULL,lease_until=NULL,error=NULL,updated_at=datetime('now') WHERE id=? AND worker_id=?").run(status,planId,JSON.stringify(recommendation),job.id,job.worker_id);
      const id=crypto.randomUUID();
      db.prepare("INSERT INTO notifications(id,user_id,type,task_id,text,actor_id) VALUES (?,?,'preparation_ready',?,?,NULL)").run(id,project.owner_id,task.id,question??"План подготовлен. Проверьте состав и согласуйте запуск.");
      return {id,owner:project.owner_id};
    })();
    if(notification) broadcastToUsers([notification.owner],{type:"notification:new",notificationId:notification.id,taskId:job.task_id});
  } catch(error){
    const message=error instanceof Error?error.message:String(error);
    db.transaction(()=>{
    if(!current(job)) return;
    db.prepare("UPDATE task_preparation_jobs SET status=?,available_at=datetime('now','+30 seconds'),worker_id=NULL,lease_until=NULL,error=?,updated_at=datetime('now') WHERE id=? AND worker_id=? AND status='running'").run(job.attempts<3?"queued":"failed",message.slice(0,1000),job.id,job.worker_id);
    })();
  } finally {clearInterval(heartbeat);}
  return true;
}

export function startPreparationWorker():()=>Promise<void> {
  let stopped=false,ongoing:Promise<unknown>|null=null;
  const workerId=`prepare_${crypto.randomUUID()}`;
  const tick=()=>{flushPlanTopicEvents();if(!stopped && !ongoing) ongoing=(async()=>{await unlockDependencyPlans();return processOnePreparation({workerId});})().catch(error=>console.error("[preparation]",error)).finally(()=>{ongoing=null;});};
  const timer=setInterval(tick,1000);timer.unref();tick();
  return async()=>{stopped=true;clearInterval(timer);await ongoing;};
}

export function registerPreparationRoutes(app:FastifyInstance):void {
  app.get("/api/tasks/:id/preparation",{preHandler:authOrApiToken},async(req:any,reply)=>{
    if(!getTaskForRead(req.params.id,req.userId)) return reply.code(404).send({error:"Задача не найдена"});
    const job=db.prepare("SELECT id,input_version,status,plan_id,result_json,error,attempts,updated_at FROM task_preparation_jobs WHERE task_id=? ORDER BY id DESC LIMIT 1").get(req.params.id) as any;
    const plan=job?.plan_id?db.prepare("SELECT status FROM task_collaboration_plans WHERE id=?").get(job.plan_id) as {status:string}|undefined:undefined;
    return {preparation:job?{...job,plan_status:plan?.status??null,branch_snapshot:job.plan_id && branchRoot(req.params.id)===req.params.id && branchCards(req.params.id).length>1 ? branchSnapshot(job.plan_id) : null,result:job.result_json?JSON.parse(job.result_json):null,result_json:undefined}:null};
  });
  app.post("/api/tasks/:id/preparation/approve-structure",{preHandler:authOrApiToken},async(req:any,reply)=>{
    const task=getTaskForRead(req.params.id,req.userId);
    if(!task) return reply.code(404).send({error:"Задача не найдена"});
    if(!isOwner(req.userId)) return reply.code(403).send({error:"Структуру согласует владелец"});
    const outcome=db.transaction(()=>{
      const job=db.prepare("SELECT * FROM task_preparation_jobs WHERE task_id=? ORDER BY id DESC LIMIT 1").get(task.id) as any;
      if(!job || job.input_version!==req.body?.input_version) return null;
      const latest=db.prepare("SELECT * FROM tasks WHERE id=?").get(task.id) as any;
      const snapshot=JSON.parse(job.snapshot);
      if(latest.title!==snapshot.title || latest.description!==snapshot.description || latest.project_id!==snapshot.project_id || protectedTask(latest)) return null;
      const result=JSON.parse(job.result_json??"null");
      if(job.status==="ready" && result?.approved_children) return result.approved_children as string[];
      if(job.status!=="structure_review" || !result?.card) return null;
      const prep=validatePreparation(result.card.preparation,ROLE_NAMES);
      if(prep.representation!=="child_cards" || prep.question || result.question || db.prepare("SELECT 1 FROM tasks WHERE parent_id=?").get(task.id)) return null;
      const ids=new Map(prep.workstreams.map(w=>[w.key,crypto.randomUUID()]));
      for(const [index,w] of prep.workstreams.entries()){
        const child=result.card.children?.[index];
        db.prepare("INSERT INTO tasks(id,title,description,project_id,creator_id,parent_id,position,priority,machine_selected_role,needs_clarification,clarification_question) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(ids.get(w.key),w.title,[child?.description,`Результат: ${w.result}`].filter(Boolean).join("\n\n"),latest.project_id,req.userId,task.id,index+1,latest.priority,w.role,child?.question?1:0,child?.question??null);
      }
      for(const w of prep.workstreams) for(const dep of w.depends_on) db.prepare("INSERT INTO task_dependencies(task_id,depends_on_task_id,policy) VALUES(?,?,'completed')").run(ids.get(w.key),ids.get(dep));
      for(const w of prep.workstreams) logEvent({taskId:ids.get(w.key)!,actorId:req.userId,kind:"task_created",field:"task",toValue:w.title});
      result.approved_children=[...ids.values()];
      db.prepare("UPDATE task_preparation_jobs SET status='ready',result_json=?,updated_at=datetime('now') WHERE id=?").run(JSON.stringify(result),job.id);
      db.prepare("UPDATE tasks SET needs_clarification=0,clarification_question=NULL WHERE id=?").run(task.id);
      return result.approved_children as string[];
    })();
    if(!outcome) return reply.code(409).send({error:"Подготовка изменилась, требует уточнения или структура уже задана. Обновите карточку."});
    for(const id of outcome) broadcastTaskEvent([req.userId,task.creator_id],{type:"task:updated",task:getFullTask(id)});
    broadcastTaskEvent([req.userId,task.creator_id],{type:"task:updated",task:getFullTask(task.id)});
    return {child_ids:outcome};
  });
  app.post("/api/tasks/:id/preparation/retry",{preHandler:authOrApiToken},async(req:any,reply)=>{
    const task=getTaskForRead(req.params.id,req.userId);
    if(!task || (!isOwner(req.userId)&&!isOrchestrator(req.userId))) return reply.code(404).send({error:"Задача не найдена"});
    if(protectedTask(task)) return reply.code(409).send({error:"Подготовка не заменяет ручной план или запущенную работу"});
    const job=db.prepare("SELECT id,status FROM task_preparation_jobs WHERE task_id=? ORDER BY id DESC LIMIT 1").get(task.id) as any;
    if(!job || job.status!=="failed") return reply.code(409).send({error:"Повтор доступен для завершившейся ошибкой подготовки"});
    db.prepare("UPDATE task_preparation_jobs SET status='queued',attempts=0,available_at=datetime('now'),error=NULL WHERE id=? AND status='failed'").run(job.id);
    return {queued:true};
  });
}
