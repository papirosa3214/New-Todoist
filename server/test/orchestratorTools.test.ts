import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {asRole,setInProcessApp,taskflowTools} from "../src/runtime/inProcessRun.js";
import {chatTools} from "../src/runtime/chatTools.js";
import {refreshRoles} from "../src/roleRouting.js";
import {orchestratorTools} from "../src/runtime/orchestratorTools.js";
describe("internal orchestrator tools",()=>{
 let app:any, taskId="coordinator-test-task";
 beforeAll(async()=>{
  app=await buildApp();setInProcessApp(app);
  db.prepare("INSERT OR IGNORE INTO roles(key,title,summary,enabled,position,prompt) VALUES(?,?,?,?,?,?)").run("code_orchestrator","Оркестратор","lead",1,20,"coordinate");
  db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,role_key,type,profile,is_system_bot,permissions) VALUES(?,?,?,?,?,?,?,?,?,?)").run("role_code_orchestrator","Оркестратор","coord@test","hash","agent","code_orchestrator","ai","code_orchestrator",1,JSON.stringify({orchestrate:true}));
  db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,?,?,?)").run("coord-owner","Owner","coord-owner@test","hash","owner","human");
  db.prepare("INSERT INTO tasks(id,title,creator_id,status) VALUES(?,?,?,?)").run(taskId,"Coord parent","coord-owner","active");
  refreshRoles();
 });
 afterAll(async()=>{await app.close();});
 const factory=(name:string,description:string,parameters:any,run:any)=>({name,run,parameters});
 const names=["taskflow_plan_read","taskflow_plan_create","taskflow_plan_propose","taskflow_plan_edit","taskflow_plan_ops","taskflow_plan_approve","taskflow_assign","taskflow_node_run","taskflow_children","taskflow_dependencies","taskflow_team_read"];
 it("exposes controls only to actual orchestrator accounts",()=>{
  expect(orchestratorTools("builder",factory)).toEqual([]);
  const tools=orchestratorTools("code_orchestrator",factory);
  for(const n of names)expect(tools.map(t=>t.name)).toContain(n);
 });
 it("reads children and creates a real draft without executing",async()=>{
  const tools=orchestratorTools("code_orchestrator",factory);
  const create=tools.find(t=>t.name==="taskflow_plan_create");expect(create).toBeDefined();
  await create!.run({task_id:taskId,graph:{profile:"manual",nodes:[{slot_key:"build",role_key:"builder",expected_result:"implementation"}],edges:[]}});
  const p=db.prepare("SELECT status FROM task_collaboration_plans WHERE task_id=?").get(taskId) as any;expect(p.status).toBe("draft");
  const read=tools.find(t=>t.name==="taskflow_children")!;
  expect(await read.run({task_id:taskId})).toEqual([]);
 });
 it("allows assignment but rejects status smuggling and server deletion",async()=>{
  const tool=orchestratorTools("code_orchestrator",factory).find(t=>t.name==="taskflow_assign");expect(tool).toBeDefined();
  await tool!.run({task_id:taskId,assignee_id:"role_code_orchestrator",status:"completed"});
  expect((db.prepare("SELECT status,assignee_id FROM tasks WHERE id=?").get(taskId) as any)).toMatchObject({status:"active",assignee_id:"role_code_orchestrator"});
  await expect(asRole("code_orchestrator","PATCH","/api/tasks/"+taskId,{status:"completed"})).rejects.toThrow("403");
  await expect(asRole("code_orchestrator","DELETE","/api/tasks/"+taskId)).rejects.toThrow("403");
 });
 it("preserves dependency gates and refuses a cycle",async()=>{
  const control=orchestratorTools("code_orchestrator",factory).find(t=>t.name==="taskflow_dependencies")!;
  db.prepare("INSERT INTO tasks(id,title,creator_id,status) VALUES(?,?,?,?)").run("coord-dependency","Upstream","coord-owner","active");
  await control.run({task_id:taskId,depends_on_task_ids:["coord-dependency"]});
  const state=await control.run({task_id:taskId});
  expect(state.unmet_dependency_ids).toContain("coord-dependency");
  await expect(control.run({task_id:"coord-dependency",depends_on_task_ids:[taskId]})).rejects.toThrow();
 });
 it("revocation blocks a previously obtained control",async()=>{
  const tool=orchestratorTools("code_orchestrator",factory).find(t=>t.name==="taskflow_plan_read")!;
  db.prepare("UPDATE users SET permissions=? WHERE id=?").run("{}", "role_code_orchestrator");
  await expect(tool.run({task_id:taskId})).rejects.toThrow("отключено");
  expect(orchestratorTools("code_orchestrator",factory)).toEqual([]);
  db.prepare("UPDATE users SET permissions=? WHERE id=?").run(JSON.stringify({orchestrate:true}), "role_code_orchestrator");
 });
 it("work, chat and catalog report the real same controls",async()=>{
  for(const n of names){
   expect(taskflowTools("code_orchestrator",null,taskId).map(t=>t.name)).toContain(n);
   expect(chatTools("code_orchestrator").map(t=>t.name)).toContain(n);
  }
  const r=await asRole("code_orchestrator","GET","/api/roles/code_orchestrator");
  expect(r.account_id).toBe("role_code_orchestrator");
  for(const n of names)expect(r.tools).toContain(n);
 });
});
