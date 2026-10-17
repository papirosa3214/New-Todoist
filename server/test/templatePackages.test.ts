import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { TEMPLATE_PROFILES, additionalTemplate, templateInstructions, stageSkillNames } from "../src/lib/collaborationTemplates.js";
vi.mock("../src/runtime/inProcessRun.js", async (original) => ({...await original<typeof import("../src/runtime/inProcessRun.js")>(),runRoleInProcess: async()=>({runId:"test",completion:Promise.resolve()})}));
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { proposalFor } from "../src/routes/task-collaboration-plans.js";
import { stageInstructionsForRun } from "../src/runtime/inProcessRun.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
let app: Awaited<ReturnType<typeof buildApp>>, auth: string;
beforeAll(async()=>{
 app=await buildApp(); demoteSeededOwner(db); seedRoleAccounts(db);
 db.prepare("INSERT OR IGNORE INTO roles(key,title) VALUES('code_orchestrator','Оркестратор')").run();
 db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,role_key,type,is_system_bot) VALUES('role_code_orchestrator','Orchestrator','code-orch@test','','agent','code_orchestrator','ai',1)").run();
 const reg=await app.inject({method:"POST",url:"/api/auth/register",payload:{name:"Templates",email:`template-${Date.now()}@test`,password:"password123"}});
 db.prepare("UPDATE users SET role='owner',task_intake_mode='manual' WHERE id=?").run(reg.json().user.id);
 auth=`Bearer ${reg.json().token}`;
});
afterAll(async()=>{await app.close();});
async function propose(profile:string) {
 const card=await app.inject({method:"POST",url:"/api/tasks",headers:{authorization:auth},payload:{title:"SwiftUI API: проверить поведение",description:"Работа в текущих границах"}});
 const taskId=card.json().task.id;
 const response=await app.inject({method:"POST",url:`/api/tasks/${taskId}/collaboration-plans/propose`,headers:{authorization:auth},payload:{profile}});
 expect(response.statusCode,response.body).toBe(201);
 return {taskId,plan:response.json().plan};
}
describe("owner-approved template packages",()=>{
 it.each([...TEMPLATE_PROFILES])("%s persists version, prompts and stage skill candidates",async(profile)=>{
   const {plan}=await propose(profile);
   expect(plan.profile).toBe(profile); expect(plan.nodes.length).toBeGreaterThan(0);
   for(const n of plan.nodes) {
     expect(n.instructions).toContain(`Шаблон: ${profile}@1.`);
     expect(n.instructions).toContain(n.expected_result);
     expect(stageSkillNames(n.instructions)).not.toBeNull();
     const stored=db.prepare("SELECT instructions FROM task_collaboration_plan_nodes WHERE plan_id=? AND slot_key=?").get(plan.id,n.slot_key) as {instructions:string};
     expect(stored.instructions).toBe(n.instructions);
   }
 });
 it("fixed defaults include architecture/design/QA and diagnosis/QA without extra choices",async()=>{
   expect((await propose("product_feature")).plan.nodes.map((n:any)=>n.slot_key)).toEqual(["analysis","architecture","design","delivery","qa"]);
   expect((await propose("bug_regression")).plan.nodes.map((n:any)=>n.slot_key)).toEqual(["analysis","root_cause","fix","regression_test"]);
 });
 it("API verification waits for implementation AND parallel test preparation",()=>{
   const graph=additionalTemplate("api_integration")!;
   expect(graph.edges.filter(e=>e.from_slot_key==="architecture").map(e=>e.to_slot_key).sort()).toEqual(["delivery","qa_prepare"]);
   expect(graph.edges.filter(e=>e.to_slot_key==="qa_verify").map(e=>e.from_slot_key).sort()).toEqual(["delivery","qa_prepare"]);
   for(const e of graph.edges) {
     expect(e.start_condition).toBe("artifact_ready");
     expect(graph.nodes.find(n=>n.slot_key===e.from_slot_key)?.output_artifact.key).toBe(e.artifact_key);
   }
 });
 it("audit has independent reviewers and no implementation step or live-fix gate",()=>{
   const g=additionalTemplate("audit")!;
   expect(g.nodes.map(n=>n.role_key)).toEqual(["analyst","architect","critic_verifier"]);
   for(const n of g.nodes) {
     const prompt=templateInstructions("audit",n,"аудит кода")!;
     expect(prompt).toContain("автоматически в аудит НЕ входят");
     expect(stageSkillNames(prompt)).not.toContain("verdict-requires-live-scenario");
   }
 });
 it("platform skills do not leak into non-Apple work; manual keeps individual selection",()=>{
   const n={slot_key:"design",role_key:"designer",expected_result:"Концепция"};
   expect(stageSkillNames(templateInstructions("ux_concept",n,"сайт для браузера"))).not.toContain("ios-hig-design");
   expect(stageSkillNames(templateInstructions("ux_concept",n,"iPhone SwiftUI"))).toContain("ios-hig-design");
   expect(templateInstructions("manual",n,"iPhone")).toBeNull();
   expect(stageSkillNames("произвольное задание")).toBeNull();
   const saved=templateInstructions("ux_concept",n,"iPhone")!;
   expect(stageSkillNames("[taskflow:final-review]\n"+saved)).toEqual(stageSkillNames(saved));
 });
 it.each(["ux_concept","api_integration","audit"] as const)("JEV-selected %s resolves to its full graph",async(profile)=>{
   const {taskId}=await propose(profile);
   const chosen=proposalFor(taskId,"auto",undefined,undefined,{profile,confidence:0.95});
   expect(chosen.profile).toBe(profile);
   expect(chosen.nodes.map(n=>n.slot_key)).toEqual(additionalTemplate(profile)!.nodes.map(n=>n.slot_key));
 });
 it("final-review card jobs recover the saved packet without leaking to other roles",async()=>{
   const {taskId,plan}=await propose("audit");
   db.prepare("UPDATE task_collaboration_plans SET status='approved' WHERE id=?").run(plan.id);
   const instructions="[taskflow:final-review]\n"+plan.nodes.find((n:any)=>n.slot_key==="review").instructions;
   db.prepare("UPDATE task_collaboration_plan_nodes SET instructions=? WHERE plan_id=? AND slot_key='review'").run(instructions,plan.id);
   db.prepare("INSERT INTO subtasks(id,task_id,title,collaboration_plan_id,plan_node_key,agent_state) VALUES('review-packet',?,'Review',?,'review','todo')").run(taskId,plan.id);
   expect(stageInstructionsForRun(taskId,"critic_verifier",undefined,"review")).toBe(instructions);
   expect(stageInstructionsForRun(taskId,"builder",undefined,"work")).toBeNull();
   expect(stageInstructionsForRun(taskId,"builder","review-packet","work")).toBeNull();
   expect(stageInstructionsForRun("unrelated","critic_verifier","review-packet","review")).toBeNull();
 });
 it("legacy graph edits preserve snapshots, explicit instructions remain editable",async()=>{
   const {taskId,plan}=await propose("ux_concept");
   const nodes=plan.nodes.map(({instructions,...n}:any)=>n);
   const edit=await app.inject({method:"PATCH",url:`/api/tasks/${taskId}/collaboration-plans/${plan.id}`,headers:{authorization:auth},payload:{nodes,edges:plan.edges}});
   expect(edit.statusCode,edit.body).toBe(200);
   expect(edit.json().plan.nodes.map((n:any)=>n.instructions)).toEqual(plan.nodes.map((n:any)=>n.instructions));
   nodes[0].instructions="Уточнённое задание владельца";
   const again=await app.inject({method:"PATCH",url:`/api/tasks/${taskId}/collaboration-plans/${plan.id}`,headers:{authorization:auth},payload:{nodes,edges:plan.edges}});
   expect(again.statusCode,again.body).toBe(200);
   expect(again.json().plan.nodes[0].instructions).toBe(nodes[0].instructions);
 });
});
