import {buildApp} from "../src/index.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import crypto from "node:crypto";
import {beforeAll,afterAll,it,expect} from "vitest";
import db, {migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {purgeTasks} from "../src/lib/taskPurge.js";
import {checkReviewHistory} from "../src/lib/reviewHistory.js";
let app:any;
beforeAll(async()=>{app=await buildApp();seedRoleAccounts(db);});
afterAll(async()=>{await app.close();});
it("first review survives permanent purge and repeated submission is counted once",()=>{
 const id=crypto.randomUUID();
 db.prepare("INSERT INTO tasks(id,title) VALUES(?,?)").run(id,"Test");
 for(const at of ["2026-09-03 10:00:00","2026-09-04 11:00:00"])
  db.prepare("INSERT INTO task_events(id,task_id,kind,field,to_value,created_at) VALUES(?,?,'state_changed','agent_state','review',?)").run(crypto.randomUUID(),id,at);
 expect((db.prepare("SELECT submitted_at FROM task_review_history WHERE task_id=?").get(id) as any).submitted_at).toBe("2026-09-03 10:00:00");
 purgeTasks([id]);
 expect(db.prepare("SELECT id FROM tasks WHERE id=?").get(id)).toBeUndefined();
 expect(db.prepare("SELECT id FROM task_events WHERE task_id=?").get(id)).toBeUndefined();
 expect((db.prepare("SELECT COUNT(*) n FROM task_review_history WHERE task_id=?").get(id) as any).n).toBe(1);
});
it("state transitions record a fact without reopening or modifying other tasks",()=>{
 const id=crypto.randomUUID();db.prepare("INSERT INTO tasks(id,title,status) VALUES(?,?,'active')").run(id,"State");
 db.prepare("UPDATE tasks SET agent_state='review' WHERE id=?").run(id);
 expect(db.prepare("SELECT task_id FROM task_review_history WHERE task_id=?").get(id)).toBeTruthy();
 db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(id);
 purgeTasks([id]);
 expect(db.prepare("SELECT task_id FROM task_review_history WHERE task_id=?").get(id)).toBeTruthy();
});
it("failed transactions do not leave phantom historical activity",()=>{
 const id=crypto.randomUUID();
 expect(()=>db.transaction(()=>{
  db.prepare("INSERT INTO tasks(id,title,agent_state) VALUES(?,?,'review')").run(id,"Rollback");
  throw new Error("reject");
 })()).toThrow("reject");
 expect(db.prepare("SELECT task_id FROM task_review_history WHERE task_id=?").get(id)).toBeUndefined();
});
it("watcher exercises write, duplicate recording and purge without leaving data",()=>{
 const before=(db.prepare("SELECT COUNT(*) n FROM task_review_history").get() as any).n;
 expect(checkReviewHistory()).toEqual({ok:true});
 expect((db.prepare("SELECT COUNT(*) n FROM task_review_history").get() as any).n).toBe(before);
});

it("history endpoint authenticates owner and excludes nonowners",async()=>{
 const owner=await app.inject({method:"GET",url:"/api/stats/review-history",headers:{authorization:"Bearer "+app.jwt.sign({id:"u1"})}});
 expect(owner.statusCode,owner.body).toBe(200);expect(owner.json().entries.length).toBeGreaterThan(0);
 const denied=await app.inject({method:"GET",url:"/api/stats/review-history",headers:{authorization:"Bearer "+app.jwt.sign({id:"role_builder"})}});expect(denied.statusCode).toBe(403);
});
