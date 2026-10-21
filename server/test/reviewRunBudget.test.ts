import {describe,it,expect,vi} from "vitest";
import crypto from "node:crypto";
import db, {migrate} from "../src/db.js";
import {createResultVersion} from "../src/resultVersions.js";
import {runMigrations} from "../src/migrations.js";
migrate();runMigrations();
import {reserveReviewRun,assertReviewRunAllowed,finishReviewRun,reviewBudgetExhausted} from "../src/runtime/reviewRunBudget.js";

function task() {
 const id=crypto.randomUUID();
 db.prepare("INSERT INTO tasks(id,title,status,agent_state) VALUES(?,'Review budget','active','review')").run(id);
 return id;
}
describe("durable review budget",()=>{
 it("three missing verdicts block and cancel pending jobs",()=>{
  const id=task();
  for(let i=0;i<3;i++){
   const ticket=reserveReviewRun(id);assertReviewRunAllowed(ticket);
   db.prepare("INSERT INTO role_run_jobs(id,task_id,reason,dedupe_key,status) VALUES(?,?,'review',?,'queued')").run(crypto.randomUUID(),id,crypto.randomUUID());
   expect(()=>finishReviewRun(ticket)).toThrow(/без сохранённого вердикта/);
  }
  expect(reviewBudgetExhausted(id)).toBe(true);
  expect(db.prepare("SELECT agent_state,block_type FROM tasks WHERE id=?").get(id)).toMatchObject({agent_state:"blocked",block_type:"needs_input"});
  expect(db.prepare("SELECT 1 FROM role_run_jobs WHERE task_id=? AND status='queued'").get(id)).toBeUndefined();
 });
 it("module restart and new job cannot renew the budget",async()=>{
  const id=task();
  for(let i=0;i<3;i++)assertReviewRunAllowed(reserveReviewRun(id));
  vi.resetModules();
  const reloaded=await import("../src/runtime/reviewRunBudget.js");
  expect(()=>reloaded.assertReviewRunAllowed(reloaded.reserveReviewRun(id))).toThrow(/3/);
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
});
