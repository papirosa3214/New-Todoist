import { beforeAll, describe, expect, it } from "vitest";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {applyPlanOps} from "../src/runtime/planMutations.js";
import {finishPlanIfComplete,finishCompletedPlans} from "../src/runtime/planSubtaskAdmission.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
beforeAll(()=>{migrate();runMigrations();seedRoleAccounts(db);});
function plan(name:string,status="draft"){
 const taskId="audit-task-"+name,planId="audit-plan-"+name;
 db.prepare("INSERT INTO tasks(id,title,status,creator_id,requires_reviewer_review) VALUES (?,?,'active','u1',0)").run(taskId,name);
 db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,created_by) VALUES (?,?,1,?,'manual','fixture','u1')").run(planId,taskId,status);
 return {taskId,planId};
}
describe("runtime audit: plan and card state consistency",()=>{
 it("preserves semantic deduplication of identical work across roles",()=>{
  const {planId}=plan("different-roles");
  applyPlanOps(planId,[{op:"add_step",role_key:"builder",expected_result:"Independent result"}],{kind:"owner",id:"u1"});
  applyPlanOps(planId,[{op:"add_step",role_key:"qa",expected_result:"Independent result"}],{kind:"owner",id:"u1"});
  const roles=db.prepare("SELECT role_key FROM task_collaboration_plan_nodes WHERE plan_id=? ORDER BY role_key").all(planId);
  expect(roles).toEqual([{role_key:"builder"}]);
 });
 it("does not move an archived card into review during completion recovery",()=>{
  const {taskId,planId}=plan("archived","approved");
  db.prepare("UPDATE tasks SET archived_at=datetime('now'),agent_state=NULL WHERE id=?").run(taskId);
  db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result) VALUES (?,?,'delivery','builder',1,'fixture')").run(planId+"-node",planId);
  db.prepare("INSERT INTO subtasks(id,task_id,title,done,collaboration_plan_id,plan_node_key,result) VALUES (?,?,'fixture',1,?,'delivery','done')").run(taskId+"-step",taskId,planId);
  expect(finishPlanIfComplete(planId,taskId,"u1")).toBe(false);
  expect(finishCompletedPlans()).toBe(0);
  expect(db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(taskId)).toEqual({agent_state:null});
  expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_versions WHERE task_id=?").get(taskId)).toEqual({n:0});
 });
});
