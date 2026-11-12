import {beforeAll,afterAll,afterEach,describe,it,expect,vi} from "vitest";
import type {FastifyInstance} from "fastify";
const runs=vi.hoisted(()=>({start:vi.fn()}));
vi.mock("../src/runtime/inProcessRun.js",async original=>({...await original<any>(),runRoleInProcess:async()=>{runs.start();return {runId:"test",completion:Promise.resolve()};}}));
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {processOnePreparation} from "../src/runtime/autoPreparation.js";
import {createDraftPlan} from "../src/routes/task-collaboration-plans.js";
import {demoteSeededOwner,seedRoleAccounts} from "./helpers/seedOwner.js";
const result=(question:string|null=null)=>({schema_version:1,status:"recommendation_only",question,card:{preparation:{intent:"executable_task",representation:"role_plan",reason:"Два результата",question,workstreams:[{key:"build",title:"Изменение",result:"Проверяемое изменение",role:"builder",depends_on:[],parallel_with:[]},{key:"verify",title:"Проверка",result:"Отчёт проверки",role:"qa",depends_on:["build"],parallel_with:[]}]}}}) as any;
describe("Автоматическая подготовка",()=>{
 let app:FastifyInstance,auth:any,ownerId:string,projectId:string;
 beforeAll(async()=>{
  app=await buildApp();demoteSeededOwner(db);seedRoleAccounts(db);
  const u=(await app.inject({method:"POST",url:"/api/auth/register",payload:{name:"PrepOwner",email:`prep-${Date.now()}@test`,password:"password123"}})).json();ownerId=u.user.id;db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);auth={authorization:`Bearer ${u.token}`};
  projectId=(await app.inject({method:"POST",url:"/api/projects",headers:auth,payload:{name:"Подготовка"}})).json().id;
 });
 afterAll(async()=>{await app.close();});
 afterEach(()=>{db.prepare("UPDATE task_preparation_jobs SET status='skipped' WHERE status IN ('queued','running')").run();runs.start.mockClear();});
 const task=async(title="Работа А")=>(await app.inject({method:"POST",url:"/api/tasks",headers:auth,payload:{title,project_id:projectId}})).json().task.id as string;
 const job=(id:string)=>db.prepare("SELECT * FROM task_preparation_jobs WHERE task_id=? ORDER BY id DESC LIMIT 1").get(id) as any;
 const process=(analyze:any=async()=>result())=>processOnePreparation({workerId:"test-worker",analyze});
 it("API и прямой импорт дают очередь без дублей и исполнения",async()=>{
  const id=await task();expect(job(id).status).toBe("queued");
  const imported=`import-${Date.now()}`;db.prepare("INSERT INTO tasks(id,title,status,creator_id,project_id) VALUES (?,'Из Linear','active',?,?)").run(imported,ownerId,projectId);
  db.prepare("UPDATE tasks SET title=title,description=description WHERE id=?").run(imported);
  expect((db.prepare("SELECT COUNT(*) AS n FROM task_preparation_jobs WHERE task_id=?").get(imported) as any).n).toBe(1);
  await process();expect(job(id).status).toBe("ready");
  expect((db.prepare("SELECT status FROM task_collaboration_plans WHERE id=?").get(job(id).plan_id) as any).status).toBe("draft");
  expect(db.prepare("SELECT 1 FROM subtasks WHERE task_id=?").get(id)).toBeUndefined();expect(runs.start).not.toHaveBeenCalled();
  // Комната задачи не заводится ни при создании, ни на подготовке плана:
  // задача ещё не в работе (владелец 11.11.2026).
  expect(db.prepare("SELECT 1 FROM chats WHERE task_id=? AND room_kind='task'").get(id)).toBeUndefined();
  expect((db.prepare("SELECT artifact_key FROM task_collaboration_plan_edges WHERE plan_id=?").get(job(id).plan_id) as any).artifact_key).toBeTruthy();
  expect((db.prepare("SELECT start_condition FROM task_collaboration_plan_edges WHERE plan_id=?").get(job(id).plan_id) as any).start_condition).toBe("submitted");
 });
 it("устаревший анализ не пишет новый план",async()=>{
  const id=await task();await process(async()=>{db.prepare("UPDATE tasks SET description='Новая версия' WHERE id=?").run(id);return result();});
  expect((db.prepare("SELECT status FROM task_preparation_jobs WHERE task_id=? ORDER BY id LIMIT 1").get(id) as any).status).toBe("superseded");
  await process();expect(job(id).status).toBe("ready");
 });
 it("ручной план сохраняется",async()=>{
  const id=await task();const plan=createDraftPlan(id,ownerId,"manual","Мой план",null,{nodes:[{slot_key:"executor",role_key:"builder",required:true,expected_result:"Мой результат",output_artifact:null,source_subtask_id:null}],edges:[]});
  const analyze=vi.fn(async()=>result());await process(analyze);expect(analyze).not.toHaveBeenCalled();expect(job(id).status).toBe("skipped");
  expect((db.prepare("SELECT status FROM task_collaboration_plans WHERE id=?").get(plan.id) as any).status).toBe("draft");
 });
 it("правка владельца во время анализа сохраняется",async()=>{
  const id=await task("Исследовать источник");const plan=db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id=? AND status='draft'").get(id) as any;expect(plan).toBeTruthy();
  await process(async()=>{const r=await app.inject({method:"PATCH",url:`/api/tasks/${id}/collaboration-plans/${plan.id}`,headers:auth,payload:{rationale:"Выбрано мной"}});expect(r.statusCode).toBe(200);return result();});
  expect(job(id).status).toBe("skipped");expect((db.prepare("SELECT rationale FROM task_collaboration_plans WHERE id=?").get(plan.id) as any).rationale).toBe("Выбрано мной");
 });
 it("уточнение блокирует автоматический черновик и даёт уведомление",async()=>{
  const id=await task("Исследовать источник");await process(async()=>result("Какой регион?"));expect(job(id).status).toBe("needs_clarification");
  expect((db.prepare("SELECT needs_clarification FROM tasks WHERE id=?").get(id) as any).needs_clarification).toBe(1);
  expect(db.prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id=? AND status='draft'").get(id)).toBeUndefined();
  expect(db.prepare("SELECT text FROM notifications WHERE task_id=?").all(id)).toEqual([{text:"Какой регион?"}]);
 });
 it("lease восстанавливается; потерявший владение не записывает план",async()=>{
  const id=await task();db.prepare("UPDATE task_preparation_jobs SET status='running',worker_id='dead',lease_until=datetime('now','-1 second') WHERE task_id=?").run(id);
  await process(async()=>{db.prepare("UPDATE task_preparation_jobs SET worker_id='other' WHERE task_id=?").run(id);return result();});expect(job(id).plan_id).toBeNull();
  db.prepare("UPDATE task_preparation_jobs SET lease_until=datetime('now','-1 second') WHERE task_id=?").run(id);await process();expect(job(id).status).toBe("ready");
 });
 it("ошибка ограничивает повторы и доступна через API",async()=>{
  const id=await task();const fail=async()=>{throw new Error("Модель недоступна");};for(let i=0;i<3;i++){db.prepare("UPDATE task_preparation_jobs SET available_at=datetime('now') WHERE task_id=?").run(id);await process(fail);}
  expect(job(id).status).toBe("failed");expect(job(id).attempts).toBe(3);
  const status=await app.inject({method:"GET",url:`/api/tasks/${id}/preparation`,headers:auth});expect(status.json().preparation.error).toBe("Модель недоступна");
  expect((await app.inject({method:"POST",url:`/api/tasks/${id}/preparation/retry`,headers:auth,payload:{}})).statusCode).toBe(200);
 });
 it("владелец согласует план и после изменения постановки — подготовка не блокирует",async()=>{
  const id=await task();await process();const plan=job(id).plan_id;db.prepare("UPDATE tasks SET description='Изменено' WHERE id=?").run(id);
  const responsibility=await app.inject({method:"PATCH",url:`/api/tasks/${id}/integration-responsibility`,headers:auth,payload:{mode:"manual",owner_id:"role_builder"}});expect(responsibility.statusCode).toBe(200);
  const r=await app.inject({method:"POST",url:`/api/tasks/${id}/collaboration-plans/${plan}/approve`,headers:auth,payload:{}});expect(r.statusCode).toBe(200);
 });
 it("предложенные дочерние карточки ждут согласования и не создаются автоматически",async()=>{
  const id=await task();await process(async()=>{const r=result();r.card.preparation.representation="child_cards";return r;});
  expect(job(id).status).toBe("structure_review");
  expect(db.prepare("SELECT id FROM tasks WHERE parent_id=?").all(id)).toEqual([]);
  expect(runs.start).not.toHaveBeenCalled();
 });
 it("ошибка устаревшего анализа не возвращает старую версию в очередь",async()=>{
  const id=await task();const old=job(id).id;
  await process(async()=>{db.prepare("UPDATE tasks SET description='Новая постановка' WHERE id=?").run(id);throw new Error("Старый запрос упал");});
  expect((db.prepare("SELECT status FROM task_preparation_jobs WHERE id=?").get(old) as any).status).toBe("superseded");
  expect(job(id).status).toBe("queued");
 });

 it("владелец согласует дочерние карточки один раз, зависимости сохраняются без запуска",async()=>{
  const id=await task();await process(async()=>{const r=result();r.card.preparation.representation="child_cards";return r;});
  const url=`/api/tasks/${id}/preparation/approve-structure`,payload={input_version:job(id).input_version};
  const r=await app.inject({method:"POST",url,headers:auth,payload});expect(r.statusCode).toBe(200);
  const children=r.json().child_ids;expect(children).toHaveLength(2);
  expect(db.prepare("SELECT task_id,depends_on_task_id,policy FROM task_dependencies WHERE task_id=?").get(children[1])).toEqual({task_id:children[1],depends_on_task_id:children[0],policy:"completed"});
  expect((await app.inject({method:"POST",url,headers:auth,payload})).json().child_ids).toEqual(children);
  expect(db.prepare("SELECT id FROM tasks WHERE parent_id=?").all(id)).toHaveLength(2);expect(runs.start).not.toHaveBeenCalled();
 });
 it("уточнение или старая версия не позволяют согласовать структуру",async()=>{
  const id=await task();await process(async()=>{const r=result("Уточните границы");r.card.preparation.representation="child_cards";return r;});
  const url=`/api/tasks/${id}/preparation/approve-structure`,payload={input_version:job(id).input_version};
  expect((await app.inject({method:"POST",url,headers:auth,payload})).statusCode).toBe(409);
  db.prepare("UPDATE tasks SET description='Новые границы' WHERE id=?").run(id);
  expect((await app.inject({method:"POST",url,headers:auth,payload})).statusCode).toBe(409);
  expect(db.prepare("SELECT id FROM tasks WHERE parent_id=?").all(id)).toEqual([]);
 });

 it("роль без прав владельца не может согласовать структуру",async()=>{
  const id=await task();await process(async()=>{const r=result();r.card.preparation.representation="child_cards";return r;});
  const u=(await app.inject({method:"POST",url:"/api/auth/register",payload:{name:"PrepAgent",email:`prep-agent-${Date.now()}@test`,password:"password123"}})).json();
  db.prepare("UPDATE users SET role='agent' WHERE id=?").run(u.user.id);
  db.prepare("UPDATE tasks SET assignee_id=? WHERE id=?").run(u.user.id,id);
  const r=await app.inject({method:"POST",url:`/api/tasks/${id}/preparation/approve-structure`,headers:{authorization:`Bearer ${u.token}`},payload:{input_version:job(id).input_version}});
  expect(r.statusCode).toBe(403);expect(db.prepare("SELECT id FROM tasks WHERE parent_id=?").all(id)).toEqual([]);
 });

});
