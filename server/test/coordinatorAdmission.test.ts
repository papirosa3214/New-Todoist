import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import crypto from 'node:crypto';
const live=vi.hoisted(()=>({runs:[] as any[]}));
vi.mock('../src/runtime/inProcessRun.js',async orig=>({...await orig<any>(),listActiveInProcessRuns:()=>live.runs,activeInProcessRun:(id:string)=>live.runs.find(r=>r.taskId===id&&!r.subtaskId),runRoleInProcess:vi.fn(async()=>({runId:'mock',completion:Promise.resolve()}))}));
import {buildApp} from '../src/index.js';
import db from '../src/db.js';
import {taskExecutionState} from '../src/runtime/taskExecutionState.js';
import {branchSnapshot} from '../src/runtime/branchPlan.js';
import {seedRoleAccounts,demoteSeededOwner} from './helpers/seedOwner.js';
let app:any,auth:any,owner:string;
beforeAll(async()=>{app=await buildApp();demoteSeededOwner(db);seedRoleAccounts(db);owner=crypto.randomUUID();db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES (?,'Owner',?,'!','owner','human')").run(owner,owner+'@test');auth={authorization:'Bearer '+app.jwt.sign({id:owner})};db.prepare("UPDATE users SET permissions=? WHERE id='role_researcher'").run(JSON.stringify({orchestrate:true}));});
afterAll(async()=>app.close());
async function fixture(){
 const root=crypto.randomUUID(),child=crypto.randomUUID();
 db.prepare("INSERT INTO tasks(id,title,creator_id,assignee_id,agent_state) VALUES (?,'Branch',?,'role_researcher','in_progress')").run(root,owner);
 db.prepare("INSERT INTO tasks(id,title,creator_id,parent_id) VALUES (?,'Child',?,?)").run(child,owner,root);
 let rp='';
 for(const [id,role] of [[root,'architect'],[child,'builder']]){
 const r=await app.inject({method:'POST',url:`/api/tasks/${id}/collaboration-plans`,headers:auth,payload:{profile:'manual',nodes:[{slot_key:'work',role_key:role,expected_result:'Result'}],edges:[]}});expect(r.statusCode).toBe(201);if(id===root)rp=r.json().plan.id;
 }
 live.runs=[{taskId:root,role:'researcher',runId:'coordinator'}];
 return {root,child,rp};
}
it('coordinator permits approval and starts only first child',async()=>{
 const f=await fixture();expect(taskExecutionState(f.root)).toMatchObject({busy:true,can_launch:false,can_use_plan:true});
 const r=await app.inject({method:'POST',url:`/api/tasks/${f.root}/collaboration-plans/${f.rp}/approve`,headers:auth,payload:{branch_snapshot:branchSnapshot(f.rp)}});expect(r.statusCode,r.body).toBe(200);
 expect(db.prepare("SELECT agent_state FROM subtasks WHERE task_id=?").get(f.child)).toEqual({agent_state:'in_progress'});
 expect(db.prepare("SELECT agent_state FROM subtasks WHERE task_id=?").get(f.root)).toEqual({agent_state:null});
 expect(live.runs).toHaveLength(1);
});
it('executor slot blocks even if role has coordination permission',async()=>{const f=await fixture();live.runs[0].subtaskId='slot';expect(taskExecutionState(f.root).can_use_plan).toBe(false);});
it('second ordinary worker blocks approval',async()=>{const f=await fixture();live.runs.push({taskId:f.root,role:'builder'});expect(taskExecutionState(f.root).can_use_plan).toBe(false);});
it('ordinary assignee cannot bypass',async()=>{const f=await fixture();db.prepare("UPDATE tasks SET assignee_id='role_builder' WHERE id=?").run(f.root);expect(taskExecutionState(f.root).can_use_plan).toBe(false);});
it('busy child blocks approval atomically',async()=>{const f=await fixture();db.prepare("UPDATE tasks SET agent_state='in_progress' WHERE id=?").run(f.child);const r=await app.inject({method:'POST',url:`/api/tasks/${f.root}/collaboration-plans/${f.rp}/approve`,headers:auth,payload:{branch_snapshot:branchSnapshot(f.rp)}});expect(r.statusCode).toBe(409);expect(db.prepare("SELECT COUNT(*) n FROM branch_plan_members WHERE root_plan_id=?").get(f.rp)).toEqual({n:0});});


it('queued review is not coordination',async()=>{const f=await fixture();db.prepare("INSERT INTO role_run_jobs(id,task_id,reason,dedupe_key,status) VALUES (?,?,'review',?,'queued')").run(crypto.randomUUID(),f.root,crypto.randomUUID());expect(taskExecutionState(f.root).can_use_plan).toBe(false);});
it('revoked permission closes the exception immediately',async()=>{const f=await fixture();db.prepare("UPDATE users SET permissions='{}' WHERE id='role_researcher'").run();expect(taskExecutionState(f.root).can_use_plan).toBe(false);db.prepare("UPDATE users SET permissions=? WHERE id='role_researcher'").run(JSON.stringify({orchestrate:true}));});
