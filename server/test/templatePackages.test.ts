vi.mock("../src/runtime/PiRuntimeAdapter.js",async original=>({...await original<any>(),startChatRun:vi.fn(async()=>({sessionId:null,text:"Вердикт получил, обсуждаю с владельцем."}))}));
import {startChatRun} from "../src/runtime/PiRuntimeAdapter.js";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { TEMPLATE_PROFILES, additionalTemplate, templateInstructions, stageSkillNames } from "../src/lib/collaborationTemplates.js";
vi.mock("../src/runtime/inProcessRun.js", async (original) => ({...await original<typeof import("../src/runtime/inProcessRun.js")>(),runRoleInProcess: async()=>({runId:"test",completion:Promise.resolve()}),deliverChatToWork:vi.fn(async()=>"idle")}));
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { proposalFor } from "../src/routes/task-collaboration-plans.js";
import { stageInstructionsForRun } from "../src/runtime/inProcessRun.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
let app: Awaited<ReturnType<typeof buildApp>>, auth: string;
beforeAll(async()=>{
 app=await buildApp(); demoteSeededOwner(db); seedRoleAccounts(db);
 db.prepare("UPDATE users SET reviewer=1 WHERE id='role_critic_verifier'").run();
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

import {integrationResponsibility} from "../src/lib/integrationResponsibility.js";
it.each(["result_review","code_review"])("%s проверяет готовый результат без повторной разработки",async profile=>{
 const {taskId,plan}=await propose(profile);
 expect(plan.nodes.map((n:any)=>n.role_key)).toEqual(["critic_verifier"]);
 const prompt=plan.nodes[0].instructions;
 expect(prompt.startsWith("[taskflow:final-review]")).toBe(true);
 expect(prompt).toContain("Проблема:");expect(prompt).toContain("Ожидается:");
 expect(stageSkillNames(prompt)).not.toContain("verdict-requires-live-scenario");
 const integration=integrationResponsibility(taskId);
 if(profile==="result_review")expect(integration).toMatchObject({mode:"not_required",owner_id:null,valid:true});
 else expect(integration).toMatchObject({mode:"auto",owner_id:"role_architect",valid:true});
});

import {createResultVersion} from "../src/resultVersions.js";
it.each(["result_review","code_review"].flatMap(profile=>["approved","changes_requested","blocked"].map(verdict=>({profile,verdict}))))("$profile: разовый $verdict возвращает результат без доработки",async ({profile,verdict})=>{
 const {taskId,plan}=await propose(profile);
 db.prepare("UPDATE task_collaboration_plans SET status='approved' WHERE id=?").run(plan.id);
 db.prepare("INSERT INTO subtasks(id,task_id,title,position,agent_id,agent_state,collaboration_plan_id,plan_node_key) VALUES(?,?,?,1,'role_critic_verifier','in_progress',?,?)").run("once-"+taskId,taskId,"Проверка",plan.id,plan.nodes[0].slot_key);
 const owner=(db.prepare("SELECT creator_id FROM tasks WHERE id=?").get(taskId) as any).creator_id;
 const chat="review-source-"+taskId, original="source-"+taskId;
 db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES(?,'Исходный разговор','direct',?)").run(chat,owner);
 for(const id of [owner,"role_builder"])db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chat,id);
 db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,channel) VALUES(?,?,?,'Проверь результат','chat')").run(original,chat,owner);
 db.prepare("INSERT INTO chat_work_launches(id,chat_id,task_id,plan_id,title,steps_json,status,role_key) VALUES(?,?,?,?,? ,?,'started','builder')").run("launch-"+taskId,chat,taskId,plan.id,"Проверка",JSON.stringify([{slot:"review",role_key:"critic_verifier",message_id:original}]));
 const v=createResultVersion({taskId,createdBy:"role_critic_verifier",result:"Материал для разовой проверки"});
 const body={task_id:taskId,version_id:v.id,task_revision:v.task_revision,artifact_hash:v.artifact_hash,criteria_version:"1",verdict,findings:"Нет итогового документа",report_markdown:verdict==="approved"?"Принято: результат соответствует поручению.":"Проблема: итоговый документ отсутствует. Исправить: автору приложить результат. Ожидается: доступный документ."};
 vi.mocked(deliverChatToWork).mockImplementation(async()=>"busy");
 const response=await app.inject({method:"POST",url:"/api/reviews",headers:{authorization:"Bearer "+app.jwt.sign({id:"role_critic_verifier"})},payload:body});
 expect(response.statusCode,response.body).toBe(201);
 const returned=db.prepare("SELECT m.text,q.role_id,m.chat_id FROM chat_messages m JOIN chat_message_queue q ON q.message_id=m.id WHERE m.id=?").get("review-return:"+response.json().review_id) as any;
 expect(returned).toMatchObject({role_id:"role_builder",chat_id:chat});expect(returned.text).toContain("Нет итогового документа");
 await vi.waitFor(()=>expect(vi.mocked(startChatRun).mock.calls.some(([input])=>input.role==="builder" && input.chatId===chat)).toBe(true));
 vi.mocked(deliverChatToWork).mockImplementation(async()=>"idle");
 expect(db.prepare("SELECT count(*) n FROM task_collaboration_plan_nodes WHERE plan_id=?").get(plan.id)).toEqual({n:profile==="code_review"&&verdict==="approved"?2:1});
 expect(db.prepare("SELECT done FROM subtasks WHERE id=?").get("once-"+taskId)).toEqual({done:1});
 expect(db.prepare("SELECT count(*) n FROM worktree_merge_queue WHERE task_id=?").get(taskId)).toEqual({n:0});
 const duplicate=await app.inject({method:"POST",url:"/api/reviews",headers:{authorization:"Bearer "+app.jwt.sign({id:"role_critic_verifier"})},payload:body});expect(duplicate.statusCode).toBe(201);
});

import {deliverChatToWork,reviewPromptFor,taskflowTools} from "../src/runtime/inProcessRun.js";
it("разовый критик получает короткий контракт, а не общий цикл доработки",async()=>{
 const {taskId,plan}=await propose("result_review");
 db.prepare("UPDATE task_collaboration_plans SET status='approved' WHERE id=?").run(plan.id);
 expect(reviewPromptFor(taskId)).toContain("разовая проверка");
 expect(reviewPromptFor(taskId)).toContain("Проблема:");
 const tool=taskflowTools("critic_verifier",null,taskId).find(t=>t.name==="taskflow_review")!;
 expect(tool.description).toContain("result_review");
});
