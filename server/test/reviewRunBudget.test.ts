import {describe,it,expect,vi} from "vitest";
import crypto from "node:crypto";
import db, {migrate} from "../src/db.js";
import {createResultVersion} from "../src/resultVersions.js";
import {runMigrations} from "../src/migrations.js";
migrate();runMigrations();
import {reserveReviewRun,assertReviewRunAllowed,finishReviewRun,reviewBudgetExhausted,voidReviewRunAfterRestart} from "../src/runtime/reviewRunBudget.js";

function task() {
 db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES('role_critic_verifier','Critic','critic-progress@test','!','agent','ai')").run();
 const id=crypto.randomUUID();
 db.prepare("INSERT INTO tasks(id,title,status,agent_state) VALUES(?,'Review budget','active','review')").run(id);
 return id;
}
function progress(id:string,text:string) {
 db.prepare("INSERT OR IGNORE INTO subtasks(id,task_id,title,agent_id,result) VALUES(?,?,'Partial review','role_critic_verifier',?)").run(id+"-output",id,text);
 db.prepare("UPDATE subtasks SET result=? WHERE id=?").run(text,id+"-output");
}
/** Шаг финальной ревизии критика — слот, заход которого может сорвать перезапуск. */
function reviewStep(taskId:string):string {
 const plan="p_"+crypto.randomUUID(), step="s_"+crypto.randomUUID();
 db.prepare("INSERT INTO task_collaboration_plans(id,task_id,profile,status,rationale,revision,created_by) VALUES(?,?,'single_executor','approved','test',1,'role_critic_verifier')").run(plan,taskId);
 db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,expected_result,instructions) VALUES(?,?,'final_review_x','critic_verifier','Итоговая проверка результата','[taskflow:final-review]')").run("n_"+crypto.randomUUID(),plan);
 db.prepare("INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key,done,agent_id) VALUES(?,?,'Итоговая проверка результата',1,?,'final_review_x',0,'role_critic_verifier')").run(step,taskId,plan);
 return step;
}
describe("durable review budget",()=>{
 it("no output blocks after first run, without spending two more retries",()=>{
  const id=task(),ticket=reserveReviewRun(id);
  assertReviewRunAllowed(ticket);
  expect(()=>finishReviewRun(ticket,new Error("400 context window exceeds limit"))).toThrow();
  expect(db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(id)).toEqual({agent_state:"blocked"});
  expect(()=>reserveReviewRun(id)).toThrow(/заблокирован/);
 });
 it("three runs with saved progress but no verdict block and cancel pending jobs",()=>{
  const id=task();
  for(let i=0;i<3;i++){
   const ticket=reserveReviewRun(id);assertReviewRunAllowed(ticket);
   db.prepare("INSERT INTO role_run_jobs(id,task_id,reason,dedupe_key,status) VALUES(?,?,'review',?,'queued')").run(crypto.randomUUID(),id,crypto.randomUUID());
   progress(id,"Finding "+i);
   expect(()=>finishReviewRun(ticket)).toThrow(/без сохранённого вердикта/);
  }
  expect(reviewBudgetExhausted(id)).toBe(true);
  expect(db.prepare("SELECT agent_state,block_type FROM tasks WHERE id=?").get(id)).toMatchObject({agent_state:"blocked",block_type:"needs_input"});
  expect(db.prepare("SELECT 1 FROM role_run_jobs WHERE task_id=? AND status='queued'").get(id)).toBeUndefined();
 });
 it("module restart and new job cannot renew the budget",async()=>{
  const id=task();
  assertReviewRunAllowed(reserveReviewRun(id));
  vi.resetModules();
  const reloaded=await import("../src/runtime/reviewRunBudget.js");
  expect(()=>reloaded.assertReviewRunAllowed(reloaded.reserveReviewRun(id))).toThrow(/предыдущий заход/);
 });
 it("old output, comments and identical result rewrites do not authorize another run",()=>{
  const id=task();
  progress(id,"Existing finding");
  const ticket=reserveReviewRun(id);
  db.prepare("INSERT INTO comments(id,task_id,user_id,text) VALUES(?,?,'role_critic_verifier','Still working')").run(crypto.randomUUID(),id);
  progress(id,"Existing finding");
  expect(()=>finishReviewRun(ticket)).toThrow();
  expect(db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(id)).toEqual({agent_state:"blocked"});
 });
 it("new saved document allows continuation; rewriting identical contents does not",()=>{
  const id=task(),note=crypto.randomUUID(),first=reserveReviewRun(id);
  const content=JSON.stringify({type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Confirmed finding"}]}]});
  db.prepare("INSERT INTO user_notes(id,title,content,updated_by) VALUES(?,'Review',?,'role_critic_verifier')").run(note,content);
  db.prepare("INSERT INTO task_events(id,task_id,actor_id,kind,field) VALUES(?,?,'role_critic_verifier','doc_written',?)").run(crypto.randomUUID(),id,note);
  expect(()=>finishReviewRun(first)).toThrow();
  expect(db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(id)).toEqual({agent_state:"review"});
  const second=reserveReviewRun(id);assertReviewRunAllowed(second);
  db.prepare("UPDATE user_notes SET updated_at=datetime('now'),content=? WHERE id=?").run(content,note);
  expect(()=>finishReviewRun(second)).toThrow();
  expect(db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(id)).toEqual({agent_state:"blocked"});
 });
 it("another role editing a previous critic document is not critic progress",()=>{
  const id=task(),note=crypto.randomUUID();
  db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES('role_builder','Builder','builder-progress@test','!','agent','ai')").run();
  const content=(text:string)=>JSON.stringify({type:"doc",content:[{type:"text",text}]});
  db.prepare("INSERT INTO user_notes(id,title,content,updated_by) VALUES(?,'Review',?,'role_critic_verifier')").run(note,content("Old finding"));
  db.prepare("INSERT INTO task_events(id,task_id,actor_id,kind,field) VALUES(?,?,'role_critic_verifier','doc_written',?)").run(crypto.randomUUID(),id,note);
  const ticket=reserveReviewRun(id);
  db.prepare("UPDATE user_notes SET content=?,updated_by='role_builder' WHERE id=?").run(content("Builder output"),note);
  expect(()=>finishReviewRun(ticket)).toThrow();
  expect(db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(id)).toEqual({agent_state:"blocked"});
 });
 it("reviewed version is a success, a new version has a fresh budget",()=>{
  const id=task(), user=crypto.randomUUID();
  db.prepare("INSERT INTO users(id,name,email,password_hash,role) VALUES(?,'Reviewer',?,'!','agent')").run(user,user+"@test");
  createResultVersion({taskId:id,createdBy:user,result:"Result"});
  const ticket=reserveReviewRun(id);
  db.prepare("INSERT INTO reviews(id,task_id,version_id,reviewer_id,task_revision,artifact_hash,criteria_version,verdict,findings) VALUES(?,?,?,?,1,'test','1','approved','OK')").run(crypto.randomUUID(),id,ticket.versionId,user);
  expect(()=>finishReviewRun(ticket)).not.toThrow();
  createResultVersion({taskId:id,createdBy:user,result:"New result"});
  expect(reserveReviewRun(id).number).toBe(1);
 });
 it("перезапуск сервера, сорвавший заход проверки, не съедает её бюджет (31.10.2026)",()=>{
  const id=task(), step=reviewStep(id);
  const ticket=reserveReviewRun(id);assertReviewRunAllowed(ticket);
  // Заход сорван перезапуском: вердикта нет, нового вывода нет — бюджет исчерпан.
  expect(reviewBudgetExhausted(id)).toBe(true);
  expect(voidReviewRunAfterRestart(id,step)).toBe(true);
  expect(reviewBudgetExhausted(id)).toBe(false);
  const next=reserveReviewRun(id);
  expect(next.denied).toBeUndefined();
  expect(next.number).toBe(1);
  expect(()=>assertReviewRunAllowed(next)).not.toThrow();
 });
 it("освобождение захода не трогает чужие шаги и повторный вызов",()=>{
  const id=task(), step=reviewStep(id);
  assertReviewRunAllowed(reserveReviewRun(id));
  expect(voidReviewRunAfterRestart(id,"чужой-шаг")).toBe(false);
  expect(reviewBudgetExhausted(id)).toBe(true);
  expect(voidReviewRunAfterRestart(id,step)).toBe(true);
  expect(voidReviewRunAfterRestart(id,step)).toBe(false);
  expect(reviewBudgetExhausted(id)).toBe(false);
 });
});
