import {beforeAll, afterAll, it, expect} from "vitest";
import crypto from "node:crypto";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {seedRoleAccounts, demoteSeededOwner} from "./helpers/seedOwner.js";
import {createResultVersion} from "../src/resultVersions.js";
import {ensureIntegrationPlanStep, integrationStepContext, isIntegrationPlanStep} from "../src/runtime/integrationHandoff.js";
import {canPlanSubtaskBecomeReady} from "../src/runtime/planSubtaskAdmission.js";
let app:any, owner:string;
beforeAll(async()=> {
 app=await buildApp(); demoteSeededOwner(db); seedRoleAccounts(db);
 owner=crypto.randomUUID();
 db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES (?,'Owner',?,'!','owner','human')").run(owner,owner+"@test");
});
afterAll(async()=>app.close());
function fixture(opts:{mode?:string;withPlan?:boolean;reviewDone?:boolean}={}){
 const id=crypto.randomUUID(), plan="p_"+id;
 db.prepare("INSERT INTO tasks(id,title,creator_id,integration_mode,integration_owner_id,agent_state) VALUES (?,'Accepted code',?,?,'role_builder','review')").run(id,owner,opts.mode??"manual");
 if(opts.withPlan!==false){
  db.prepare("INSERT INTO task_collaboration_plans(id,task_id,profile,status,rationale,revision,created_by) VALUES (?,?,'manual','approved','test',1,?)").run(plan,id,owner);
  db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,expected_result) VALUES (?,?,'build','builder','Code')").run("n_"+id,plan);
  db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,expected_result,instructions) VALUES (?,?,'final_review_x','critic_verifier','Итоговая проверка результата','[taskflow:final-review]')").run("r_"+id,plan);
  db.prepare("INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key,done,result) VALUES (?,?,'Code',1,?,'build',1,'done')").run(crypto.randomUUID(),id,plan);
  db.prepare("INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key,done,result) VALUES (?,?,'Итоговая проверка результата',2,?,'final_review_x',?,'approved: ok')").run(crypto.randomUUID(),id,plan,opts.reviewDone===false?0:1);
 }
 const v=createResultVersion({taskId:id,createdBy:"role_builder",result:"Commit abc123; checks passed"});
 const review=crypto.randomUUID();
 db.prepare("INSERT INTO reviews(id,task_id,version_id,task_revision,reviewer_id,artifact_hash,criteria_version,verdict,findings) VALUES (?,?,?,?,'role_critic_verifier',?,1,'approved','Checked')").run(review,id,v.id,v.task_revision,v.artifact_hash);
 return {id,plan,review,v};
}
it("принятая проверка плана добавляет один шаг интеграции на ответственного, готовый к запуску",()=>{
 const f=fixture(), step=ensureIntegrationPlanStep(f.review)!;
 expect(step).not.toBeNull();
 const node=db.prepare("SELECT * FROM task_collaboration_plan_nodes WHERE plan_id=? AND slot_key=?").get(f.plan,step.slotKey) as any;
 expect(node.role_key).toBe("builder");
 expect(JSON.parse(node.output_artifact_json).required_fields).toEqual(["summary","evidence","document_refs"]);
 const subtask=db.prepare("SELECT * FROM subtasks WHERE id=?").get(step.subtaskId) as any;
 expect(subtask.agent_id).toBe("role_builder");expect(subtask.done).toBe(0);expect(subtask.agent_state).toBeNull();
 expect(db.prepare("SELECT from_slot_key FROM task_collaboration_plan_edges WHERE plan_id=? AND to_slot_key=?").get(f.plan,step.slotKey)).toEqual({from_slot_key:"final_review_x"});
 expect(canPlanSubtaskBecomeReady(subtask)).toBe(true);
 expect(isIntegrationPlanStep(step.subtaskId)).toBe(true);
 expect(integrationStepContext(step.subtaskId)).toContain(f.v.id);
 expect(ensureIntegrationPlanStep(f.review)!.subtaskId).toBe(step.subtaskId);
 expect((db.prepare("SELECT count(*) n FROM subtasks WHERE task_id=?").get(f.id) as any).n).toBe(3);
});
it("без плана, без закрытой проверки и при «не требуется» шаг не создаётся",()=>{
 expect(ensureIntegrationPlanStep(fixture({withPlan:false}).review)).toBeNull();
 expect(ensureIntegrationPlanStep(fixture({reviewDone:false}).review)).toBeNull();
 expect(ensureIntegrationPlanStep(fixture({mode:"not_required"}).review)).toBeNull();
});
it("обычный шаг не интеграционный; при новой версии результата поручение запрещает перенос",()=>{
 const f=fixture(), step=ensureIntegrationPlanStep(f.review)!;
 const build=db.prepare("SELECT id FROM subtasks WHERE task_id=? AND plan_node_key='build'").get(f.id) as any;
 expect(isIntegrationPlanStep(build.id)).toBe(false);expect(integrationStepContext(build.id)).toBeNull();
 createResultVersion({taskId:f.id,createdBy:"role_builder",result:"New unreviewed changes"});
 expect(integrationStepContext(step.subtaskId)).toContain("УСТАРЕЛ");
});
