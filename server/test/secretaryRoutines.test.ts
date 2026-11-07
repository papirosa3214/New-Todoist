import {beforeAll,afterAll,it,expect} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {buildRoleToolCatalog} from "../src/runtime/roleToolCatalog.js";
import {setInProcessApp} from "../src/runtime/inProcessRun.js";
import {roleToolAllowed} from "../src/lib/roleToolScope.js";
import {isReadOperation,operationRestriction} from "../src/runtime/universalTaskflow.js";
let app:any;
const names=['taskflow_routines','taskflow_routine_read','taskflow_routine_create','taskflow_routine_update','taskflow_routine_pause','taskflow_routine_resume','taskflow_routine_run_now','taskflow_routine_delete','taskflow_routine_runs','taskflow_routine_preview'];
beforeAll(async()=>{app=await buildApp();await app.ready();seedRoleAccounts(db);setInProcessApp(app);});
afterAll(async()=>{await app.close();});
const catalog=(mode='work')=>buildRoleToolCatalog({role:'secretary',mode,runId:'routine-tools-'+Math.random(),chatId:'routine-fixture',executionMode:'chat'});
const body={title:'Тестовая рутина',rule_kind:'daily',time_local:'09:00',timezone:'Europe/Moscow',catch_up:false,overlap_policy:'skip',task_payload:{title:'Тестовое задание',description:'Полное задание',needs_research:true,requires_reviewer_review:true}};
async function call(c:any,name:string,args:any,id='call-'+Math.random()){
 const tool=c.customTools.find((t:any)=>t.name===name);expect(tool,name).toBeDefined();
 const result=await tool.execute(id,args);
 return JSON.parse(result.content[0].text);
}
it('registers precise routine operations and exposes discovery in the secretary core',()=>{
 const c=catalog();for(const name of names)expect(c.registeredNames).toContain(name);
 expect(c.activeNames).toContain('taskflow_routines');expect(c.activeNames).toContain('taskflow_routine_read');
 expect(c.customTools.find(t=>t.name==='taskflow_routine_create')!.parameters.required).toContain('task_payload');
});
it("routines are available to every role; secretary deletion stays forbidden",()=>{
 for(const name of names)for(const role of ["builder","researcher","code_orchestrator"])expect(roleToolAllowed(role,name)).toBe(true);
 for(const name of names)if(!/delete|purge|remove/i.test(name))expect(roleToolAllowed("secretary",name)).toBe(true);
 expect(roleToolAllowed("secretary","taskflow_delete")).toBe(false);expect(roleToolAllowed("secretary","apple_reminders_delete")).toBe(false);
});
it('read operations work in plan mode; mutations remain restricted',()=>{
 for(const name of ['taskflow_routines','taskflow_routine_read','taskflow_routine_runs','taskflow_routine_preview']){
  expect(isReadOperation(name)).toBe(true);expect(operationRestriction(name,{actor:'u-secretary',role:'secretary',mode:'plan',runId:'plan'})).toBeUndefined();
 }
 expect(operationRestriction('taskflow_routine_create',{actor:'u-secretary',role:'secretary',mode:'plan',runId:'plan'})?.code).toBe('MODE_RESTRICTED');
});
it('supports create/read/edit/pause/resume/run/history/delete through native tools and real API',async()=>{
 const c=catalog();const made=await call(c,'taskflow_routine_create',body);const id=made.schedule.id;
 expect((await call(c,'taskflow_routines',{})).schedules.some((s:any)=>s.id===id)).toBe(true);
 expect((await call(c,'taskflow_routine_read',{id})).schedule.task_payload.description).toBe('Полное задание');
 await call(c,'taskflow_routine_update',{id,task_payload:{description:'Исправленное задание'}});
 const updated=(await call(c,'taskflow_routine_read',{id})).schedule;
 expect(updated.task_payload).toMatchObject({description:'Исправленное задание',needs_research:true,requires_reviewer_review:true});
 expect((await call(c,'taskflow_routine_pause',{id})).schedule.status).toBe('paused');
 await expect(call(c,'taskflow_routine_run_now',{id})).rejects.toThrow(/409|пауз/);
 expect((await call(c,'taskflow_routine_resume',{id})).schedule.status).toBe('active');
 const run=await call(c,'taskflow_routine_run_now',{id},'run-once-'+id);
 expect(run.run.task_id).toBeTruthy();const taskId=run.run.task_id;
 const replay=await call(c,'taskflow_routine_run_now',{id},'run-once-'+id);expect(replay.run.task_id).toBe(taskId);
 expect((await call(c,'taskflow_routine_runs',{id})).runs.length).toBe(1);
 expect((await call(c,'taskflow_routine_delete',{id})).ok).toBe(true);
 expect(db.prepare('SELECT id FROM tasks WHERE id=?').get(taskId)).toBeTruthy();
 expect(db.prepare('SELECT id FROM task_schedules WHERE id=?').get(id)).toBeUndefined();
});
it('previews a schedule without creating a routine',async()=>{
 const c=catalog();const count=(db.prepare('SELECT count(*) AS n FROM task_schedules').get() as any).n;
 expect((await call(c,'taskflow_routine_preview',{rule_kind:'daily',time_local:'10:00',timezone:'Europe/Moscow'})).next_run_at).toBeTruthy();
 expect((db.prepare('SELECT count(*) AS n FROM task_schedules').get() as any).n).toBe(count);
});
it('does not open unrelated DELETE routes for secretary',async()=>{
 const headers={authorization:`Bearer ${app.jwt.sign({id:'u-secretary'})}`};
 expect((await app.inject({method:'DELETE',url:'/api/tasks/nonexistent',headers})).statusCode).toBe(403);
});
it('rejects invalid tool arguments before any write',async()=>{
 const c=catalog();await expect(call(c,'taskflow_routine_create',{...body,rule_kind:'not-a-rule'})).rejects.toThrow(/INVALID_ARGUMENTS/);
 expect((db.prepare('SELECT count(*) AS n FROM task_schedules').get() as any).n).toBe(0);
});
it('allows the secretary DELETE schedule route, other agents remain forbidden',async()=>{
 const headers={authorization:`Bearer ${app.jwt.sign({id:'u1'})}`};
 const res=await app.inject({method:'POST',url:'/api/schedules',headers,payload:body});expect(res.statusCode).toBe(201);
 const id=res.json().schedule.id;
 expect((await app.inject({method:'DELETE',url:'/api/schedules/'+id,headers:{authorization:`Bearer ${app.jwt.sign({id:'role_builder'})}`}})).statusCode).toBe(403);
 expect((await app.inject({method:'DELETE',url:'/api/schedules/'+id,headers:{authorization:`Bearer ${app.jwt.sign({id:'u-secretary'})}`}})).statusCode).toBe(200);
});
