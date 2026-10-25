import {beforeAll,afterAll,it,expect} from "vitest";
import {buildApp} from "../../src/index.js";
import db from "../../src/db.js";
let app:any, token:string, outsider:string;
beforeAll(async()=>{
 app=await buildApp();
 const owner=(db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as any).id;
 token=app.jwt.sign({id:owner});
 db.prepare("INSERT INTO users(id,name,email,password_hash,role) VALUES('coord-outsider','Other','coord-other@test.local','!','agent')").run();
 outsider=app.jwt.sign({id:"coord-outsider"});
 db.prepare("INSERT INTO tasks(id,title,creator_id,archived_at) VALUES('coord-int-task','Проверка',?,datetime('now'))").run(owner);
 db.prepare("INSERT INTO subtasks(id,task_id,title,done,position) VALUES('coord-int-step','coord-int-task','Реальный шаг',1,0)").run();
 db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at) VALUES('coord-int-attempt','coord-int-task','coord-int-step',?,datetime('now'))").run(owner);
});
afterAll(async()=>{await app.close();});
it("returns a readable completed step with no executable action",async()=>{
 const res=await app.inject({method:"GET",url:"/api/coordination/tasks/coord-int-task/resolve",headers:{authorization:"Bearer "+token}});
 expect(res.statusCode).toBe(200);
 expect(res.json().resolutions[0]).toMatchObject({title:"Реальный шаг",done:true,action:"none",assignee_name:expect.any(String)});
});
it("also explains a task without subtasks",async()=>{
 const owner=(db.prepare("SELECT creator_id FROM tasks WHERE id='coord-int-task'").get() as any).creator_id;
 db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES('coord-empty-task','Без шагов',?)").run(owner);
 const res=await app.inject({method:"GET",url:"/api/coordination/tasks/coord-empty-task/resolve",headers:{authorization:"Bearer "+token}});
 expect(res.json().resolutions).toHaveLength(1);
 expect(res.json().resolutions[0]).toMatchObject({subtask_id:null,title:"Без шагов"});
});
for(const url of ["/api/coordination/tasks/coord-int-task/resolve","/api/coordination/subtasks/coord-int-step/resolve","/api/coordination/attempts/coord-int-attempt/resolve"]){
 it("applies task access to "+url,async()=>{
  const res=await app.inject({method:"GET",url,headers:{authorization:"Bearer "+outsider}});
  expect(res.statusCode).toBe(404);
 });
}

it("does not offer execution for a skipped plan step",async()=>{
 const owner=(db.prepare("SELECT creator_id FROM tasks WHERE id='coord-int-task'").get() as any).creator_id;
 db.prepare("INSERT INTO task_collaboration_plans(id,task_id,status,revision,profile,rationale,created_by) VALUES('coord-skipped-plan','coord-int-task','approved',1,'manual','test',?)").run(owner);
 db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,expected_result,iteration,skipped_at) VALUES('coord-skipped-node','coord-skipped-plan','skip-slot','builder','Пропущенный результат',0,datetime('now'))").run();
 db.prepare("INSERT INTO subtasks(id,task_id,title,done,position,collaboration_plan_id,plan_node_key) VALUES('coord-skipped-step','coord-int-task','Пропущенный шаг',0,1,'coord-skipped-plan','skip-slot')").run();
 const res=await app.inject({method:"GET",url:"/api/coordination/tasks/coord-int-task/resolve",headers:{authorization:"Bearer "+token}});
 expect(res.json().resolutions.find((r:any)=>r.subtask_id==="coord-skipped-step")).toMatchObject({skipped:true,action:"none"});
});

it("uses the same readable contract for the selected-step endpoint",async()=>{
 const res=await app.inject({method:"GET",url:"/api/coordination/subtasks/coord-int-step/resolve",headers:{authorization:"Bearer "+token}});
 expect(res.json()).toMatchObject({title:"Реальный шаг",done:true,action:"none"});
});
