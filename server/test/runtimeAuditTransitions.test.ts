import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
let app:any,headers:any;
beforeAll(async()=>{app=await buildApp();seedRoleAccounts(db);headers={authorization:"Bearer "+app.jwt.sign({id:"u1"})};});
afterAll(async()=>{await app?.close();});
function running(name:string,withPlan=false){
 const taskId="audit-transition-"+name,id=taskId+"-step",attempt=id+"-attempt",plan=taskId+"-plan";
 db.prepare("INSERT INTO tasks(id,title,status,agent_state,assignee_id) VALUES (?,?,'active','in_progress','role_builder')").run(taskId,name);
 if(withPlan){
 db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,created_by) VALUES (?,?,1,'approved','manual','fixture','u1')").run(plan,taskId);
 db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result) VALUES (?,?,'work','builder',1,'fixture')").run(plan+"-node",plan);
 }
 db.prepare("INSERT INTO subtasks(id,task_id,title,done,agent_state,agent_id,current_attempt_id,collaboration_plan_id,plan_node_key) VALUES (?,?,'fixture',0,'in_progress','role_builder',?,?,?)")
 .run(id,taskId,null,withPlan?plan:null,withPlan?"work":null);
 db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at) VALUES (?,?,?,'role_builder',datetime('now'))").run(attempt,taskId,id);
 db.prepare("UPDATE subtasks SET current_attempt_id=? WHERE id=?").run(attempt,id);
 return {id,attempt};
}
describe("runtime audit: atomic subtask transitions",()=>{
 it("releases the active attempt when owner clears a step",async()=>{
 const {id,attempt}=running("release");
 const res=await app.inject({method:"POST",url:`/api/subtasks/${id}/work`,headers,payload:{state:null}});
 expect(res.statusCode).toBe(200);
 expect(db.prepare("SELECT current_attempt_id,agent_state FROM subtasks WHERE id=?").get(id)).toEqual({current_attempt_id:null,agent_state:null});
 expect((db.prepare("SELECT ended_at FROM attempts WHERE id=?").get(attempt) as any).ended_at).toBeTruthy();
 });
 it("rejects an invalid block snapshot before changing the state",async()=>{
 const {id,attempt}=running("invalid-snapshot",true);
 const res=await app.inject({method:"POST",url:`/api/subtasks/${id}/work`,headers,payload:{state:"blocked",result:"fixture blocker",block_type:"needs_input",snapshot:42}});
 expect(res.statusCode).toBe(400);
 expect(db.prepare("SELECT agent_state,agent_id,current_attempt_id FROM subtasks WHERE id=?").get(id)).toEqual({agent_state:"in_progress",agent_id:"role_builder",current_attempt_id:attempt});
 expect((db.prepare("SELECT ended_at FROM attempts WHERE id=?").get(attempt) as any).ended_at).toBeNull();
 });
});
