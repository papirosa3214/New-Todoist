import crypto from 'node:crypto';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {buildApp} from '../src/index.js';
import db from '../src/db.js';
import {taskExecutionState} from '../src/runtime/taskExecutionState.js';

describe('single executor launch',()=>{
 let app:Awaited<ReturnType<typeof buildApp>>;let auth:string;let id:string;
 const owner=`launch-owner-${crypto.randomUUID()}`;
 beforeAll(async()=>{
  app=await buildApp();
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES(?, 'Launch Owner',?,'!','owner','human')").run(owner,`${owner}@test`);
  db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES('role_researcher','Researcher','role-researcher-launch@test','!','agent','ai')").run();
  auth=`Bearer ${app.jwt.sign({id:owner})}`;
  id=`launch-${crypto.randomUUID()}`;
  db.prepare("INSERT INTO tasks(id,title,creator_id,assignee_id,status) VALUES(?,'Assigned researcher',?,'role_researcher','active')").run(id,owner);
 });
 afterAll(async()=>{db.prepare('DELETE FROM role_run_jobs WHERE task_id=?').run(id);db.prepare('DELETE FROM task_events WHERE task_id=?').run(id);db.prepare('DELETE FROM tasks WHERE id=?').run(id);db.prepare('DELETE FROM users WHERE id=?').run(owner);await app.close()});
 it('accepts one concurrent launch from assigned role and locks conflicting actions',async()=>{
  const responses=await Promise.all([1,2].map(()=>app.inject({method:'POST',url:`/api/tasks/${id}/run`,headers:{authorization:auth},payload:{mode:'executor'}})));
  expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM role_run_jobs WHERE task_id=?').get(id)).toEqual({n:1});
  expect(taskExecutionState(id)).toMatchObject({status:'queued',scheme:'single',can_launch:false,can_change_executor:false,can_use_plan:false});
  const patch=await app.inject({method:'PATCH',url:`/api/tasks/${id}`,headers:{authorization:auth},payload:{assignee_id:owner}});expect(patch.statusCode).toBe(409);
  const plan=await app.inject({method:'POST',url:`/api/tasks/${id}/collaboration-plans/propose`,headers:{authorization:auth},payload:{profile:'research'}});expect(plan.statusCode).toBe(409);
 });
 it('allows explicit retry after terminal startup failure without changing the chosen scheme',async()=>{
  db.prepare("UPDATE role_run_jobs SET status='dead',last_error='model unavailable' WHERE task_id=?").run(id);
  expect(taskExecutionState(id)).toMatchObject({status:'failed',can_launch:true,can_change_executor:false,error:'model unavailable'});
  const retry=await app.inject({method:'POST',url:`/api/tasks/${id}/run`,headers:{authorization:auth},payload:{mode:'executor'}});expect(retry.statusCode).toBe(200);
  expect(taskExecutionState(id).status).toBe('queued');
 });
});
