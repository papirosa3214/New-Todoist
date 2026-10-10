import crypto from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {buildApp} from '../src/index.js';
import db from '../src/db.js';
import {seedRoleAccounts} from './helpers/seedOwner.js';
import {readWorkPlan,saveWorkPlan} from '../src/lib/subtaskWorkPlan.js';
import {runMigrations} from '../src/migrations.js';
let app:any;
const items=[{id:'work',title:'Выполнить работу',state:'done' as const},{id:'submit',title:'Сдать отчёт',state:'in_progress' as const}];
function step(done=0, earlierPending=false) {
 const task='wp-task-'+crypto.randomUUID(),id='wp-step-'+crypto.randomUUID();
 db.prepare("INSERT INTO tasks(id,title,creator_id,assignee_id) VALUES(?, 'Проверка','u1','role_builder')").run(task);
 db.prepare("INSERT INTO subtasks(id,task_id,title,done,agent_id,agent_state) VALUES(?,?,'Шаг',?,'role_builder','in_progress')").run(id,task,done);
 saveWorkPlan(id,'role_builder',0,earlierPending?[{...items[0],state:'pending'},items[1]]:items);
 return id;
}
beforeAll(async()=>{app=await buildApp();seedRoleAccounts(db);});
afterAll(async()=>{await app.close();});
it('successful server submission closes last item, repeated done is idempotent',async()=>{
 const id=step();
 const response=await app.inject({method:'PATCH',url:'/api/subtasks/'+id,headers:{authorization:'Bearer '+app.jwt.sign({id:'u1'})},payload:{done:true,result:'Отчёт сдан'}});
 expect(response.statusCode,response.body).toBe(200);
 expect(readWorkPlan(id)?.items.map((i:any)=>i.state)).toEqual(['done','done']);
 expect(readWorkPlan(id)?.revision).toBe(2);
 db.prepare('UPDATE subtasks SET done=1 WHERE id=?').run(id);
 expect(readWorkPlan(id)?.revision).toBe(2);
});
it('rejected submission leaves checklist and revision unchanged',async()=>{
 const id=step();const before=readWorkPlan(id);
 const response=await app.inject({method:'PATCH',url:'/api/subtasks/'+id,headers:{authorization:'Bearer '+app.jwt.sign({id:'role_critic_verifier'})},payload:{done:true}});
 expect(response.statusCode).toBeGreaterThanOrEqual(400);
 expect(readWorkPlan(id)).toEqual(before);
});
it('completion rolls back atomically with submission',()=>{
 const id=step();const before=readWorkPlan(id);
 expect(()=>db.transaction(()=>{db.prepare('UPDATE subtasks SET done=1 WHERE id=?').run(id);throw new Error('rollback');})()).toThrow('rollback');
 expect(readWorkPlan(id)).toEqual(before);
});
it('earlier unfinished items are preserved; removing done does not complete anything',()=>{
 const id=step(0,true);db.prepare('UPDATE subtasks SET done=1 WHERE id=?').run(id);
 expect(readWorkPlan(id)?.items.map((i:any)=>i.state)).toEqual(['pending','done']);
 const before=readWorkPlan(id);db.prepare('UPDATE subtasks SET done=0 WHERE id=?').run(id);
 expect(readWorkPlan(id)).toEqual(before);
});
it('migration repairs previously submitted last items once, leaves active work alone',()=>{
 const old=step(1),active=step();
 db.prepare("DELETE FROM schema_migrations WHERE id='131_work_plan_submission_tail'").run();runMigrations();
 expect(readWorkPlan(old)?.items.at(-1).state).toBe('done');expect(readWorkPlan(old)?.revision).toBe(2);
 expect(readWorkPlan(active)?.items.at(-1).state).toBe('in_progress');
 runMigrations();expect(readWorkPlan(old)?.revision).toBe(2);
});
