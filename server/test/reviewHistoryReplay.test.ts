
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { roleReport } from "./helpers/roleReport.js";

const replay = vi.hoisted(() => ({
  mode: "", taskId: "", prompts: 0, contexts: 0, critics: 0, workers: 0,
  error: null as any, handler: null as null | ((prompt:string)=>Promise<void>),
}));
vi.mock("@earendil-works/pi-coding-agent", async original => ({
  ...await original<any>(),
  createAgentSession: async () => ({
    session: {
      get state() { return {messages:[replay.mode==="loop" ? replay.error :
        {role:"assistant",stopReason:"stop",content:[{type:"text",text:"Recorded historical result"}]}]}; },
      subscribe: () => () => {},
      prompt: async (text:string) => { replay.prompts++; await replay.handler?.(text); },
      steer: async()=>{}, abort: async()=>{}, dispose:()=>{},
    },
  }),
}));
vi.mock("../src/runtime/PiRuntimeAdapter.js", async original => ({
  ...await original<any>(),
  getModelRuntime: async()=>({getModel:(_p:string,id:string)=>({id,provider:"minimax"})}),
}));
vi.mock("../src/routes/agent-service.js", async original => ({
  ...await original<any>(),unitState:async()=>({active:true,enabled:true}),
}));
vi.mock("../src/runtime/taskContextBridge.js",()=>({
  buildInProcessTaskContext:async(args:any)=>{
    replay.contexts++;
    return {prompt:"[REPLAY_SLOT:"+(args.collaboration_context?.slot_key ?? "")+"]",summary:"Historical replay",knowledgeStatus:"empty"};
  },
}));
vi.mock("../src/runtime/roleProjectContext.js",async original=>({
  ...await original<any>(),roleProjectContext:async()=>"",
}));
vi.mock("../src/lib/memorySkillsJev.js",()=>({
  selectSkillsByJev:async()=>null,filterMemoryByJev:async()=>null,reviewMemoryWriteByJev:async()=>{},
}));
process.env.TASKFLOW_KICK_IN_TESTS="1";

const fixture=JSON.parse(fs.readFileSync(path.join(process.cwd(),"test/fixtures/review-history-20261022.json"),"utf8"));
const {buildApp}=await import("../src/index.js");
const {default:db}=await import("../src/db.js");
const {demoteSeededOwner,seedRoleAccounts}=await import("./helpers/seedOwner.js");
const {processOneRoleRunJob}=await import("../src/runtime/roleRunWorker.js");
const {enqueueRoleRunJob}=await import("../src/runtime/roleRunQueue.js");
const {currentResultVersion,createResultVersion}=await import("../src/resultVersions.js");
const {reserveReviewRun,assertReviewRunAllowed}=await import("../src/runtime/reviewRunBudget.js");
const {_settleInProcessRunsForTests,kickRoleTaskStrict}=await import("../src/runtime/inProcessRun.js");
const results:any[]=[];

describe("three historical server patterns",()=>{
 let app:FastifyInstance,owner:string,auth:Record<string,string>,criticAuth:Record<string,string>;
 beforeAll(async()=>{
  app=await buildApp();demoteSeededOwner(db);seedRoleAccounts(db);
  owner="history-replay-owner";
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,type,reviewer_first_default,task_intake_mode) VALUES(?,'Replay owner','history-replay@test','!','owner','human',1,'manual')").run(owner);
  db.prepare("UPDATE users SET reviewer=1 WHERE id='role_critic_verifier'").run();
  auth={authorization:"Bearer "+app.jwt.sign({id:owner})};
  criticAuth={authorization:"Bearer "+app.jwt.sign({id:"role_critic_verifier"})};
 });
 afterAll(async()=>{
  fs.writeFileSync("/tmp/taskflow-three-history-results.json",JSON.stringify(results,null,2)+"\n");
  await app.close();
 });
 function reset(mode:string,taskId:string){
  Object.assign(replay,{mode,taskId,prompts:0,contexts:0,critics:0,workers:0,handler:null});
 }
 function makeReview(id:string,title:string){
  db.prepare("INSERT INTO tasks(id,title,status,agent_state,assignee_id,creator_id) VALUES(?,?,'active','review','role_critic_verifier',?)").run(id,title,owner);
  createResultVersion({taskId:id,createdBy:owner,result:fixture.loop.version.result});
 }
 async function drain(){
  for(let i=0;i<800;i++){
   db.prepare("UPDATE role_run_jobs SET available_at=datetime('now') WHERE task_id=? AND status='retry_wait'").run(replay.taskId);
   const handled=await processOneRoleRunJob({workerId:"historical-replay"});
   await _settleInProcessRunsForTests();
   if(!handled) {
    if(replay.mode!=="normal")return;
    const count=(db.prepare("SELECT COUNT(*) n FROM reviews WHERE task_id=?").get(replay.taskId) as any).n;
    const working=(db.prepare("SELECT COUNT(*) n FROM subtasks WHERE task_id=? AND agent_state='in_progress' AND done=0").get(replay.taskId) as any).n;
    if(count===2 && working===0)return;
    await new Promise(resolve=>setTimeout(resolve,20));
   }
  }
  throw Error("Replay did not quiesce: "+JSON.stringify({critics:replay.critics,workers:replay.workers,task:db.prepare("SELECT agent_state,blocked_reason FROM tasks WHERE id=?").get(replay.taskId),steps:db.prepare("SELECT title,done,agent_state FROM subtasks WHERE task_id=?").all(replay.taskId)}));
 }
 it("1. today's 359 queued repeats and recorded SDK 400 stop after one model request",async()=>{
  const id=fixture.loop.task.id;makeReview(id,fixture.loop.task.title);reset("loop",id);
  const plan=fixture.loop.plan;
  db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,created_by) VALUES(?,?,?,'approved',?,?,?)").run(plan.id,id,plan.revision,plan.profile,plan.rationale,owner);
  for(const node of fixture.loop.nodes){
    db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result,output_artifact_json,instructions,iteration,origin,skipped_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(node.id,plan.id,node.slot_key,node.role_key,node.required,node.expected_result,node.output_artifact_json,node.instructions,node.iteration,node.origin,node.skipped_at);
  }
  for(const step of fixture.loop.steps){
    db.prepare("INSERT INTO subtasks(id,task_id,title,done,position,agent_id,result,plan_node_key,collaboration_plan_id,agent_state) VALUES(?,?,?,?,?,?,?,?,?,?)").run(step.id,id,step.title,step.done,step.position,step.done ? step.agent_id : "role_critic_verifier",step.result,step.plan_node_key,plan.id,step.done ? null : "todo");
  }
  replay.error=fixture.loop.sdkError.message;
  for(const job of fixture.loop.jobs)enqueueRoleRunJob({taskId:id,reason:job.reason,dedupeKey:job.dedupe_key});
  await drain();
  expect(replay.prompts).toBe(1);expect(replay.contexts).toBe(1);
  expect(db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(id)).toEqual({agent_state:"blocked"});
  expect(db.prepare("SELECT COUNT(*) n FROM reviews WHERE task_id=?").get(id)).toEqual({n:0});
  expect(db.prepare("SELECT COUNT(*) n FROM role_run_jobs WHERE task_id=? AND status IN ('queued','running','retry_wait')").get(id)).toEqual({n:0});
  for(let i=0;i<5;i++){
   enqueueRoleRunJob({taskId:id,reason:"review",dedupeKey:"late-historical-wake-"+i});
   await drain();
  }
  expect(replay.prompts).toBe(1);
  const pendingStep=fixture.loop.steps.find((step:any)=>!step.done);
  expect(db.prepare("SELECT agent_state FROM subtasks WHERE id=?").get(pendingStep.id)).toEqual({agent_state:"blocked"});
  const queue=db.prepare("SELECT status,count(*) n FROM role_run_jobs WHERE task_id=? GROUP BY status").all(id);
  results.push({case:"today_loop",sourceTask:id,historicalJobs:fixture.loop.jobs.length,historicalPlan:plan.id,blockedFinalStep:pendingStep.id,sdkTimestamp:fixture.loop.sdkError.timestamp,sdkError:replay.error.errorMessage,modelRequests:replay.prompts,contextBuilds:replay.contexts,lateWakeAttempts:5,finalState:"blocked",pendingJobs:0,queue});
 });
 it("2. recorded changes_requested, executor resubmission, new-version approved review",async()=>{
  const normal=fixture.normal;
  const created=await app.inject({method:"POST",url:"/api/tasks",headers:auth,payload:{title:normal.task.title}});
  expect(created.statusCode,created.body).toBe(200);
  const id=created.json().task.id;reset("normal",id);
  replay.handler=async text=>{
   const slot=text.match(/\[REPLAY_SLOT:([^\]]*)\]/)?.[1];
   if(slot){
    replay.workers++;
    const step=db.prepare("SELECT s.id,s.title,n.iteration,n.role_key FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key WHERE s.task_id=? AND s.plan_node_key=?").get(id,slot) as any;
    expect(step,"recorded executor slot").toBeTruthy();
    const pool=step.iteration ? normal.reworkOutputs : normal.work;
    const baseTitle=step.title.replace(/^Доработка \d+: /,"");
    const output=pool.find((n:any)=>n.expected_result.replace(/^Доработка \d+: /,"")===baseTitle) ??
      pool.find((n:any)=>n.role_key===step.role_key && !n.slot_key.startsWith("integration_"));
    expect(output?.result,"historically saved executor result").toBeTruthy();
    const done=await app.inject({method:"PATCH",url:"/api/subtasks/"+step.id,headers:auth,payload:{done:true,result:output.result,report_markdown:roleReport}});
    expect(done.statusCode,done.body).toBe(200);
    return;
   }
   replay.critics++;
   const historic=normal.reviews[replay.critics-1];
   expect(historic,"no unexpected extra review").toBeTruthy();
   const version=currentResultVersion(id)!;
   const payload:any={task_id:id,version_id:version.id,task_revision:version.task_revision,artifact_hash:version.artifact_hash,criteria_version:"1",verdict:historic.verdict,findings:historic.findings ?? "Историческая приёмка",report_markdown:roleReport};
   if(historic.verdict==="changes_requested")payload.rework_steps=["builder_1","builder_2"];
   const verdict=await app.inject({method:"POST",url:"/api/reviews",headers:criticAuth,payload});
   expect(verdict.statusCode,verdict.body).toBe(201);
  };
  const nodes=normal.work.map((n:any)=>({slot_key:n.slot_key,role_key:n.role_key,expected_result:n.expected_result}));
  nodes.push({slot_key:normal.critic.slot_key,role_key:"critic_verifier",expected_result:normal.critic.expected_result});
  const planResponse=await app.inject({method:"POST",url:"/api/tasks/"+id+"/collaboration-plans",headers:auth,payload:{profile:"manual",nodes,edges:normal.edges.map((e:any)=>({...e,start_condition:"submitted"}))}});
  expect(planResponse.statusCode,planResponse.body).toBe(201);
  const plan=planResponse.json().plan.id;
  const responsibility=await app.inject({method:"PATCH",url:"/api/tasks/"+id+"/integration-responsibility",headers:auth,payload:{mode:"manual",owner_id:"role_qa"}});
  expect(responsibility.statusCode,responsibility.body).toBe(200);
  const approve=await app.inject({method:"POST",url:"/api/tasks/"+id+"/collaboration-plans/"+plan+"/approve",headers:auth});
  expect(approve.statusCode,approve.body).toBe(200);
  await _settleInProcessRunsForTests();await drain();
  const verdicts=db.prepare("SELECT verdict,version_id FROM reviews WHERE task_id=? ORDER BY rowid").all(id) as any[];
  expect(verdicts.map(r=>r.verdict)).toEqual(["changes_requested","approved"]);
  expect(verdicts[0].version_id).not.toBe(verdicts[1].version_id);
  expect(replay.critics).toBe(2);
  expect(db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND kind='review_run_blocked'").get(id)).toEqual({n:0});
  results.push({case:"ordinary_resubmission",sourceTask:normal.task.id,replayTask:id,modelRequests:replay.prompts,criticRequests:replay.critics,executorRequests:replay.workers,verdicts:verdicts.map(r=>r.verdict),distinctVersions:new Set(verdicts.map(r=>r.version_id)).size,falseBlocks:0,finalState:(db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(id) as any).agent_state});
 });
 it("3. real process restart after admission without output cannot authorize a repeat",async()=>{
  const id="history-crash-"+crypto.randomUUID();makeReview(id,fixture.loop.task.title);reset("crash",id);
  assertReviewRunAllowed(reserveReviewRun(id));
  const program=[
   'const {runRoleInProcess}=await import("./src/runtime/inProcessRun.ts");',
   'try {await runRoleInProcess({taskId:'+JSON.stringify(id)+',role:"critic_verifier",mode:"review"}); throw Error("repeat was admitted");}',
   'catch(error){if(!String(error.message).includes("предыдущий заход не оставил"))throw error;console.log(JSON.stringify({blocked:true,reason:error.message}));}',
  ].join("\n");
  const output=execFileSync(process.execPath,["--import","tsx","--input-type=module","-e",program],{cwd:process.cwd(),env:{...process.env},encoding:"utf8",timeout:30000});
  expect(output).toContain('"blocked":true');
  expect(db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(id)).toEqual({agent_state:"blocked"});
  expect(db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND kind='review_run_started'").get(id)).toEqual({n:1});
  expect(replay.prompts).toBe(0);
  results.push({case:"restart_without_output",sourcePattern:"interrupted review admission",separateOSProcess:true,admittedRuns:1,postRestartNewModelRequests:0,finalState:"blocked"});
 });
});
