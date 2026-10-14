import { beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
vi.mock("../src/runtime/inProcessRun.js", async original => ({...await original<any>(), runRoleInProcess: vi.fn(async()=>({runId:"report-test",completion:Promise.resolve()}))}));
import { taskflowTools, setInProcessApp } from "../src/runtime/inProcessRun.js";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { roleUserId } from "../src/roleRouting.js";
import { seedRoleAccounts, demoteSeededOwner } from "./helpers/seedOwner.js";
import { buildCollaborationPlanContext } from "../src/runtime/collaborationPlanContext.js";
const report = "# Отчёт о работе\n\n## Результат\nПроверка доступна владельцу.\n\n## Что сделано\nДобавлен документ с итогом этапа.\n\n## Проверки\nAPI проверен на временной базе, сценарий сдачи проходит.\n\n## Ограничения\nНа физическом телефоне не проверено.\n\n## Материалы\n[Спецификация](https://example.test/spec)\n";
describe("Читаемый отчёт — часть результата роли",{timeout:15000},()=>{
 let app:any,owner:string,builder:string,critic:string,project:string;
 beforeAll(async()=>{
  app=await buildApp();setInProcessApp(app);demoteSeededOwner(db);seedRoleAccounts(db);db.prepare("UPDATE users SET reviewer=1 WHERE id=?").run(roleUserId("critic_verifier"));
  const u=(await app.inject({method:"POST",url:"/api/auth/register",payload:{name:"Report owner",email:crypto.randomUUID()+"@test",password:"password123"}})).json();
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(u.user.id);
  owner="Bearer "+u.token;builder="Bearer "+app.jwt.sign({id:roleUserId("builder")});critic="Bearer "+app.jwt.sign({id:roleUserId("critic_verifier")});
  project=(await app.inject({method:"POST",url:"/api/projects",headers:{authorization:owner},payload:{name:"Report project"}})).json().id;
 });
 async function fixture(contract=true){
  const task=(await app.inject({method:"POST",url:"/api/tasks",headers:{authorization:owner},payload:{title:"Понятный результат "+crypto.randomUUID(),project_id:project}})).json().task;
  const p=(await app.inject({method:"POST",url:"/api/tasks/"+task.id+"/collaboration-plans",headers:{authorization:owner},payload:{profile:"manual",nodes:[{slot_key:"build",role_key:"builder",expected_result:"Результат работы",...(contract?{output_artifact:{key:"implementation_pack",type:"result_pack",format:"json",required_fields:["summary"]}}:{})},{slot_key:"verify",role_key:"qa",expected_result:"Проверка"}],edges:[{from_slot_key:"build",to_slot_key:"verify",start_condition:"submitted",...(contract?{artifact_key:"implementation_pack"}:{})}]}})).json().plan;
  // Фикстура не про интеграцию, но план содержит builder (код) — владельцу
  // нужен явный ответственный за перенос. Без него approve упирается в 409
  // (карточка be9b61cf), потому что авто-выбор знает только про
  // code_orchestrator/architect (см. также фикс в карточке 39fe9350).
  await app.inject({method:"PATCH",url:"/api/tasks/"+task.id+"/integration-responsibility",headers:{authorization:owner},payload:{mode:"manual",owner_id:roleUserId("builder")}});
  await app.inject({method:"POST",url:"/api/tasks/"+task.id+"/collaboration-plans/"+p.id+"/approve",headers:{authorization:owner},payload:{}});
  const rows=db.prepare("SELECT * FROM subtasks WHERE task_id=?").all(task.id) as any[];
  return {task,plan:p,step:rows.find(s=>s.plan_node_key==="build"),qa:rows.find(s=>s.plan_node_key==="verify")};
 }
 const submit=(id:string,extra:any={})=>app.inject({method:"POST",url:"/api/subtasks/"+id+"/artifact",headers:{authorization:builder},payload:{summary:"Владелец может прочитать итог работы.",payload:{summary:"machine input",answer:42},evidence:[],...extra}});
 it("без отчёта не закрывает шаг и не создаёт артефакт или документ",async()=>{
  const f=await fixture();const r=await submit(f.step.id);expect(r.statusCode).toBe(400);expect(r.json().error).toContain("report_markdown");
  expect((db.prepare("SELECT done FROM subtasks WHERE id=?").get(f.step.id) as any).done).toBe(0);
  expect(db.prepare("SELECT 1 FROM subtask_artifact_versions WHERE subtask_id=?").get(f.step.id)).toBeUndefined();
 });
 it("отчёт сохраняется заметкой в папке задачи, виден в графе; JSON следующей роли прежний",async()=>{
  const f=await fixture();const r=await submit(f.step.id,{report_markdown:report});expect(r.statusCode).toBe(201);
  const a=r.json().artifact;expect(a.note_id).toBeTruthy();
  const n=(await app.inject({method:"GET",url:"/api/notes/"+a.note_id+"?format=markdown",headers:{authorization:owner}})).json();
  expect(n.markdown).toContain("На физическом телефоне не проверено.");expect(n.markdown).not.toContain("machine input");
  const folder=(db.prepare("SELECT artifact_folder_id FROM tasks WHERE id=?").get(f.task.id) as any).artifact_folder_id;expect(n.folder_id).toBe(folder);
  const g=(await app.inject({method:"GET",url:"/api/tasks/"+f.task.id+"/collaboration-plans",headers:{authorization:owner}})).json().plans.find((p:any)=>p.id===f.plan.id);
  expect(g.nodes.find((n:any)=>n.slot_key==="build").result_document.id).toBe(a.note_id);
  const receipt=(await app.inject({method:"GET",url:"/api/subtasks/"+f.step.id+"/submission-receipt",headers:{authorization:builder}})).json();
  expect(receipt).toMatchObject({confirmed:true,authority:"primary",subtask_id:f.step.id,artifact_id:a.id,document_id:a.note_id});
  expect(receipt.confirmed_at).toBeTruthy();
  try {
   process.env.TASKFLOW_QA_SANDBOX="1";
   expect((await app.inject({method:"GET",url:"/api/subtasks/"+f.step.id+"/submission-receipt",headers:{authorization:builder}})).json()).toMatchObject({confirmed:false,authority:"sandbox",artifact_id:null});
  } finally {delete process.env.TASKFLOW_QA_SANDBOX;}

  expect(g.nodes.find((n:any)=>n.slot_key==="build").submission_receipt).toEqual(receipt);
  expect(buildCollaborationPlanContext(f.qa.id).predecessor_artifacts[0].payload).toEqual({summary:"machine input",answer:42});
  const outcome=(await app.inject({method:"GET",url:"/api/tasks/"+f.task.id+"/outcome",headers:{authorization:owner}})).json();
  expect(outcome.documents.some((d:any)=>d.id===a.note_id)).toBe(true);
  db.prepare("UPDATE subtask_artifact_versions SET status='revision_requested' WHERE id=?").run(a.id);
  try {
   expect((await app.inject({method:"GET",url:"/api/subtasks/"+f.step.id+"/submission-receipt",headers:{authorization:builder}})).json().confirmed).toBe(false);
  } finally {db.prepare("UPDATE subtask_artifact_versions SET status='submitted' WHERE id=?").run(a.id);}

  if (process.env.TASKFLOW_REPORT_UI_FIXTURE) {
    const task=(await app.inject({method:"GET",url:"/api/tasks/"+f.task.id,headers:{authorization:owner}})).json();
    const plans=(await app.inject({method:"GET",url:"/api/tasks/"+f.task.id+"/collaboration-plans",headers:{authorization:owner}})).json();
    const note=(await app.inject({method:"GET",url:"/api/notes/"+a.note_id,headers:{authorization:owner}})).json();
    const roles=(await app.inject({method:"GET",url:"/api/roles",headers:{authorization:owner}})).json();
    const me=(await app.inject({method:"GET",url:"/api/auth/me",headers:{authorization:owner}})).json();
    fs.writeFileSync(process.env.TASKFLOW_REPORT_UI_FIXTURE,JSON.stringify({task,plans,note,roles,me,outcome}));
  }

 }, 15000); // Several authenticated API hops; allow full-suite contention.
 it.each(["", '{"summary":"done"}', "# Отчёт\n\n## Результат\nСделано."])("не принимает пустой, JSON или неполный отчёт: %s",async value=>{
  const f=await fixture();expect((await submit(f.step.id,{report_markdown:value})).statusCode).toBe(400);
 });
 it("роль без структурного контракта тоже сдаёт отчёт; повторная правка закрытого результата не создаёт дубль",async()=>{
  const f=await fixture(false);
  const close=(extra:any)=>app.inject({method:"PATCH",url:"/api/subtasks/"+f.step.id,headers:{authorization:builder},payload:{done:true,result:"Результат готов.",...extra}});
  expect((await close({})).statusCode).toBe(400);
  expect((await close({report_markdown:report})).statusCode).toBe(200);
  const notes=()=>db.prepare("SELECT count(*) n FROM task_events WHERE kind='role_result_report' AND field=?").get(f.step.id) as any;
  expect(notes().n).toBe(1);
  expect((await app.inject({method:"PATCH",url:"/api/subtasks/"+f.step.id,headers:{authorization:builder},payload:{result:"Уточнён итог."}})).statusCode).toBe(200);
  expect(notes().n).toBe(1);
 });

 it("финальный проверяющий сдаёт отчёт вместе с вердиктом; повторный вердикт не плодит документ",async()=>{
  const f=await fixture(false);
  // This fixture is a completed builder result awaiting the designated critic.
  db.prepare("UPDATE subtasks SET done=1,agent_state=NULL,result='Результат готов.' WHERE task_id=?").run(f.task.id);
  const key="critic_final";
  db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result,instructions) VALUES(?,?,?,?,1,?,?)").run(crypto.randomUUID(),f.plan.id,key,"critic_verifier","Вердикт","[taskflow:final-review]");
  const id=crypto.randomUUID();
  db.prepare("INSERT INTO subtasks(id,task_id,title,done,position,agent_state,agent_id,collaboration_plan_id,plan_node_key) VALUES(?,?,?,0,99,'in_progress',?,?,?)").run(id,f.task.id,"Проверка результата",roleUserId("critic_verifier"),f.plan.id,key);
  const v=(await app.inject({method:"POST",url:"/api/tasks/"+f.task.id+"/versions",headers:{authorization:owner},payload:{result:"Результат готов."}})).json().version;
  const payload={task_id:f.task.id,version_id:v.id,artifact_hash:v.artifact_hash,criteria_version:"1",task_revision:v.task_revision,verdict:"approved",findings:"Проверено на временной базе."};
  const review=(extra:any)=>app.inject({method:"POST",url:"/api/reviews",headers:{authorization:critic},payload:{...payload,...extra}});
  expect((await review({})).statusCode).toBe(400);
  expect(db.prepare("SELECT 1 FROM reviews WHERE version_id=?").get(v.id)).toBeUndefined();
  try {
   process.env.TASKFLOW_QA_SANDBOX="1";
   expect((await review({report_markdown:report})).statusCode).toBe(409);
  } finally {delete process.env.TASKFLOW_QA_SANDBOX;}
  const verdict=await review({report_markdown:report});expect(verdict.statusCode).toBe(201);
  expect(verdict.json().submission_receipt).toMatchObject({confirmed:true,subtask_id:id});
  // Completion changed the current result version; repeating the stale verdict is rejected.
  expect((await review({report_markdown:report})).statusCode).toBe(409);
  const saved=db.prepare("SELECT to_value FROM task_events WHERE kind='role_result_report' AND field=?").all(id) as any[];
  expect(saved).toHaveLength(1);
  expect((db.prepare("SELECT done FROM subtasks WHERE id=?").get(id) as any).done).toBe(1);
 });

 it("критик со своим ID шага сдаёт вердикт по всей задаче вместо 404",async()=>{
  const f=await fixture(false);
  db.prepare("UPDATE subtasks SET done=1,agent_state=NULL,result='Готово.' WHERE task_id=?").run(f.task.id);
  const key="critic_id"; const id=crypto.randomUUID();
  db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result,instructions) VALUES(?,?,?,?,1,?,?)").run(crypto.randomUUID(),f.plan.id,key,"critic_verifier","Вердикт","[taskflow:final-review]");
  db.prepare("INSERT INTO subtasks(id,task_id,title,done,position,agent_state,agent_id,collaboration_plan_id,plan_node_key) VALUES(?,?,?,0,99,'in_progress',?,?,?)").run(id,f.task.id,"Вердикт",roleUserId("critic_verifier"),f.plan.id,key);
  await app.inject({method:"POST",url:"/api/tasks/"+f.task.id+"/versions",headers:{authorization:owner},payload:{result:"Готово."}});
  const tool=taskflowTools("critic_verifier",null,f.task.id,id).find(t=>t.name==="taskflow_review") as any;
  const output=await tool.execute("wrong-slot-id",{id,verdict:"approved",findings:"Проверено на временной базе.",report_markdown:report});
  expect(JSON.parse(output.content[0].text).submission_receipt).toMatchObject({confirmed:true,authority:"primary",subtask_id:id});
  expect((db.prepare("SELECT task_id FROM reviews WHERE task_id=?").get(f.task.id) as any).task_id).toBe(f.task.id);
 },15000);

 it("песочница не принимает сдачу ни артефактом, ни простым закрытием, ни квитанцией скопированной базы",async()=>{
  const f=await fixture();const simple=await fixture(false);
  try {
   process.env.TASKFLOW_QA_SANDBOX="1";
   const denied=await submit(f.step.id,{report_markdown:report});
   expect(denied.statusCode).toBe(409);expect(denied.json().code).toBe("sandbox_submission_forbidden");
   expect((await app.inject({method:"PATCH",url:"/api/subtasks/"+simple.step.id,headers:{authorization:builder},payload:{done:true,result:"Готово",report_markdown:report}})).statusCode).toBe(409);
   expect((await app.inject({method:"GET",url:"/api/subtasks/"+f.step.id+"/submission-receipt",headers:{authorization:builder}})).json()).toMatchObject({confirmed:false,authority:"sandbox"});
   expect((db.prepare("SELECT done FROM subtasks WHERE id=?").get(f.step.id) as any).done).toBe(0);
  } finally {delete process.env.TASKFLOW_QA_SANDBOX;}
 });

 it("инструмент сдачи возвращает подтверждение основного сервера для артефакта и обычного этапа",async()=>{
  const f=await fixture();const simple=await fixture(false);
  const tool=(step:any,task:any)=>taskflowTools("builder",null,task.id,step.id).find(t=>t.name==="taskflow_subtask_done") as any;
  const output=await tool(f.step,f.task).execute("receipt",{id:f.step.id,artifact:{summary:"Готово",payload:{summary:"machine input"},report_markdown:report}});
  expect(JSON.parse(output.content[0].text).submission_receipt).toMatchObject({confirmed:true,authority:"primary",subtask_id:f.step.id});
  const simpleOutput=await tool(simple.step,simple.task).execute("receipt",{id:simple.step.id,result:"Готово",report_markdown:report});
  expect(JSON.parse(simpleOutput.content[0].text).submission_receipt).toMatchObject({confirmed:true,subtask_id:simple.step.id});
 },15000);

 it.each(["analyst","architect","builder","designer","researcher","qa","critic_verifier","synthesizer"])("%s видит обязательный отчёт в инструменте сдачи",role=>{
  const tools=taskflowTools(role,null,"task","step");
  const submit=tools.find(t=>t.name==="taskflow_subtask_done") as any;
  if (role === "critic_verifier") {
    expect(submit).toBeUndefined();
  } else {
    expect(submit.parameters.properties.artifact.properties.report_markdown.type).toBe("string");
    expect(submit.parameters.properties.artifact.required).toContain("report_markdown");
    expect(submit.description).toContain("## Проверки");
  }
  const review=tools.find(t=>t.name==="taskflow_review") as any;
  // Вердикт — только Критику (14.10.2026, roleToolScope).
  if (role === "critic_verifier") expect(review.parameters.properties.report_markdown.type).toBe("string");
  else expect(review).toBeUndefined();
 });
});
