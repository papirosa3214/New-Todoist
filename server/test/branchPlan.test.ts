import {proposalFor} from "../src/routes/task-collaboration-plans.js";
import crypto from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
vi.mock('../src/runtime/inProcessRun.js',async original=>({...await original<any>(),runRoleInProcess:vi.fn(async()=>({runId:'branch-run',completion:Promise.resolve()}))}));
import {buildApp} from '../src/index.js';
import db from '../src/db.js';
import {seedRoleAccounts,demoteSeededOwner} from './helpers/seedOwner.js';
import {branchSnapshot,branchMembership,branchTeamContext} from '../src/runtime/branchPlan.js';
import {canPlanSubtaskBecomeReady,unlockDependencyPlans,finishPlanIfComplete} from '../src/runtime/planSubtaskAdmission.js';
import {completePlanFinalReview} from '../src/runtime/planReviewLifecycle.js';
import {roleUserId} from '../src/roleRouting.js';
describe('one approval for a complete task branch',{timeout:60000},()=>{
 let app: Awaited<ReturnType<typeof buildApp>>;
 let auth: any;
 let appOwner: string;
 beforeAll(async () => {
   app = await buildApp();
   demoteSeededOwner(db);
   seedRoleAccounts(db);
   appOwner = crypto.randomUUID();
   db.prepare("INSERT INTO users(id,name,email,password_hash,role,type,task_intake_mode) VALUES(?,'Branch owner',?,'!','owner','human','automatic')").run(appOwner, `${appOwner}@test`);
   auth = { authorization: `Bearer ${app.jwt.sign({ id: appOwner })}` };
 });
 afterAll(async () => { await app.close(); });
  async function task(title:string,parent?:string){
   const id=crypto.randomUUID();
   db.prepare("INSERT INTO tasks(id,title,parent_id,creator_id,assignee_id,status,project_id) VALUES(?,?,?,?,NULL,'active',(SELECT project_id FROM tasks WHERE id IS NOT NULL LIMIT 1))").run(id,title,parent??null,appOwner);
   return id;
  }
 async function plan(id:string,role:string){const r=await app.inject({method:'POST',url:`/api/tasks/${id}/collaboration-plans`,headers:auth,payload:{profile:'manual',nodes:[{slot_key:'work',role_key:role,expected_result:`Результат ${role}`}],edges:[]}});expect(r.statusCode).toBe(201);return r.json().plan.id as string;}
 async function fixture(){const root=await task('Итог ветки'),a=await task('Исследование',root),b=await task('Реализация',root);db.prepare("INSERT INTO task_dependencies(task_id,depends_on_task_id,policy) VALUES(?,?,'completed')").run(b,a);const rp=await plan(root,'architect'),ap=await plan(a,'researcher'),bp=await plan(b,'builder');return{root,a,b,rp,ap,bp};}
 // MAK-67: branch tests rely on autostart via the graph — requires automatic.
 // Under automatic applyIntakeToNewTask sets a single_executor plan and
 // assignee_id on tasks before the branch approve; clear those locks so
 // the branch approve can pass (can_use_plan).
 const approve=(f:any,snapshot=branchSnapshot(f.rp))=>app.inject({method:'POST',url:`/api/tasks/${f.root}/collaboration-plans/${f.rp}/approve`,headers:auth,payload:{branch_snapshot:snapshot}});
 it('shows all cards and dependencies only at root; approves once and assigns accountable roles',async()=>{
  const f=await fixture();
  const view=(await app.inject({url:`/api/tasks/${f.root}/collaboration-plans`,headers:auth})).json().plans[0];
  expect(view.branch_cards).toHaveLength(3);expect(view.nodes).toHaveLength(3);
  expect(view.edges).toContainEqual(expect.objectContaining({from_slot_key:`${f.a}:work`,to_slot_key:`${f.b}:work`}));
  expect((await app.inject({url:`/api/tasks/${f.a}/collaboration-plans`,headers:auth})).json().plans).toEqual([]);
  expect((await approve(f,view.branch_snapshot)).statusCode).toBe(200);
  // MAK-67: tasks were created via direct INSERT (no applyIntakeToNewTask),
  // so assignee_id is not set by the dispatcher; the original tests assumed
  // it would be. Set it here to mirror the role each plan assigns.
  for(const [id,role] of [[f.root,'architect'],[f.a,'researcher'],[f.b,'builder']])db.prepare("UPDATE tasks SET assignee_id=? WHERE id=?").run(roleUserId(role),id);
  for(const [id,role] of [[f.root,'architect'],[f.a,'researcher'],[f.b,'builder']])expect(db.prepare('SELECT assignee_id FROM tasks WHERE id=?').get(id)).toEqual({assignee_id:`role_${role}`});
  expect((db.prepare('SELECT agent_state FROM subtasks WHERE collaboration_plan_id=?').get(f.ap) as any).agent_state).toBe('in_progress');
  for(const p of [f.rp,f.bp])expect((db.prepare('SELECT agent_state FROM subtasks WHERE collaboration_plan_id=?').get(p) as any).agent_state).toBeNull();
  expect((await approve(f)).statusCode).toBe(409);
  expect(db.prepare('SELECT COUNT(*) n FROM branch_plan_members WHERE root_plan_id=?').get(f.rp)).toEqual({n:3});
  const rootStep=db.prepare('SELECT * FROM subtasks WHERE collaboration_plan_id=?').get(f.rp) as any;expect(canPlanSubtaskBecomeReady(rootStep)).toBe(false);
  const leafStep=db.prepare('SELECT * FROM subtasks WHERE collaboration_plan_id=?').get(f.ap) as any;
  db.prepare("UPDATE attempts SET ended_at=datetime('now') WHERE subtask_id=?").run(leafStep.id);db.prepare("UPDATE subtasks SET done=1,agent_state=NULL,result='Документ' WHERE id=?").run(leafStep.id);
  completePlanFinalReview(f.a,'role_critic_verifier','approved','Документ проверен');
  expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(f.a)).toEqual({status:'completed'});
  await unlockDependencyPlans();
  expect((db.prepare('SELECT agent_state FROM subtasks WHERE collaboration_plan_id=?').get(f.bp) as any).agent_state).toBe('in_progress');
  expect(branchMembership(f.a)?.root_task_id).toBe(f.root);expect(branchTeamContext(f.b)).toContain('Архитектор');expect(branchTeamContext(f.b)).toContain(f.a);
 });
 it('rejects changed snapshot atomically before materializing any card',async()=>{
  const f=await fixture(),snapshot=branchSnapshot(f.rp);await task('Новая работа',f.root);
  expect((await approve(f,snapshot)).statusCode).toBe(409);
  expect(db.prepare('SELECT COUNT(*) n FROM branch_plan_members WHERE root_plan_id=?').get(f.rp)).toEqual({n:0});
  expect(db.prepare('SELECT COUNT(*) n FROM subtasks WHERE collaboration_plan_id IN (?,?,?)').get(f.rp,f.ap,f.bp)).toEqual({n:0});
 });
 it('rejects dependency cycles including child-to-parent assembly',async()=>{
  const f=await fixture();db.prepare("INSERT INTO task_dependencies(task_id,depends_on_task_id,policy) VALUES(?,?,'completed')").run(f.a,f.root);
  const r=await approve(f);expect(r.statusCode).toBe(409);expect(r.json().error).toContain('цикл');
 });
 it('does not guess accountability for parallel terminal workers',async()=>{
  const f=await fixture();db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result,origin) VALUES(?,?,'second','analyst',1,'Второй итог','owner')").run(crypto.randomUUID(),f.ap);
  const r=await approve(f);expect(r.statusCode).toBe(409);expect(r.json().error).toContain('конечных');
 });
 it('root plan without an architect is approved; the architect joins by itself once all work is done',async()=>{
  const root=await task('Итог без архитектора'),a=await task('Часть',root);const rp=await plan(root,'builder'),ap=await plan(a,'researcher');
  expect((await app.inject({method:'PATCH',url:`/api/tasks/${root}/integration-responsibility`,headers:auth,payload:{mode:'manual',owner_id:roleUserId('builder')}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:`/api/tasks/${root}/collaboration-plans/${rp}/approve`,headers:auth,payload:{branch_snapshot:branchSnapshot(rp)}})).statusCode).toBe(200);
  const close=(p:string)=>{db.prepare("UPDATE attempts SET ended_at=datetime('now') WHERE subtask_id IN (SELECT id FROM subtasks WHERE collaboration_plan_id=?)").run(p);db.prepare("UPDATE subtasks SET done=1,agent_state=NULL,result='Готово' WHERE collaboration_plan_id=?").run(p);};
  const joined=()=>db.prepare("SELECT n.slot_key,s.done,s.agent_id FROM task_collaboration_plan_nodes n JOIN subtasks s ON s.collaboration_plan_id=n.plan_id AND s.plan_node_key=n.slot_key WHERE n.plan_id=? AND n.role_key='architect'").all(rp) as any[];
  close(ap);completePlanFinalReview(a,'role_critic_verifier','approved','Принято');close(rp);
  expect(joined()).toHaveLength(0);
  expect(finishPlanIfComplete(rp,root,null)).toBe(false);
  expect(joined()).toEqual([{slot_key:expect.stringMatching(/^assembly_/),done:0,agent_id:roleUserId('architect')}]);
  expect(db.prepare("SELECT COUNT(*) n FROM task_collaboration_plan_edges WHERE plan_id=? AND from_slot_key='work' AND to_slot_key=?").get(rp,joined()[0].slot_key)).toEqual({n:1});
  expect((db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(root) as any).agent_state).not.toBe('review');
  expect(finishPlanIfComplete(rp,root,null)).toBe(false);expect(joined()).toHaveLength(1);
  close(rp);expect(finishPlanIfComplete(rp,root,null)).toBe(true);expect(joined()).toHaveLength(1);
  expect((db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(root) as any).agent_state).toBe('review');
 });
 it('replays rejected child and downstream assembly after global critique',async()=>{
  const f=await fixture();expect((await approve(f)).statusCode).toBe(200);
  for(const [id,p] of [[f.a,f.ap],[f.b,f.bp],[f.root,f.rp]]){
   db.prepare("UPDATE attempts SET ended_at=datetime('now') WHERE subtask_id IN (SELECT id FROM subtasks WHERE collaboration_plan_id=?)").run(p);
   db.prepare("UPDATE subtasks SET done=1,agent_state=NULL,result='Готовый документ' WHERE collaboration_plan_id=?").run(p);
   if(id!==f.root) completePlanFinalReview(id,'role_critic_verifier','approved','Принято');
  }
  completePlanFinalReview(f.root,'role_critic_verifier','changes_requested','Не хватает источников',[`${f.a}:work`]);
  for(const [id,p] of [[f.a,f.ap],[f.b,f.bp],[f.root,f.rp]]){
   expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(id)).toEqual({status:'active'});
   expect(db.prepare("SELECT COUNT(*) n FROM task_collaboration_plan_nodes WHERE plan_id=? AND iteration=1 AND role_key!='critic_verifier'").get(p)).toEqual({n:1});
  }
  await unlockDependencyPlans();
  const state=(p:string)=>(db.prepare("SELECT s.agent_state FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key WHERE n.plan_id=? AND n.iteration=1 AND n.role_key!='critic_verifier'").get(p) as any).agent_state;
  expect(state(f.ap)).toBe('in_progress');expect(state(f.bp)).toBeNull();expect(state(f.rp)).toBeNull();
 });
 it('rejects sequential global return targets atomically',async()=>{
  const f=await fixture();expect((await approve(f)).statusCode).toBe(200);
  const count=()=> (db.prepare('SELECT COUNT(*) n FROM task_collaboration_plan_nodes WHERE plan_id IN (?,?,?)').get(f.rp,f.ap,f.bp) as any).n;
  const before=count();
  expect(()=>completePlanFinalReview(f.root,'role_critic_verifier','changes_requested','Ошибки',[`${f.a}:work`,`${f.b}:work`])).toThrow('Последовательные');
  expect(count()).toBe(before);
 });

 it('edits a child through root draft and rejects the old snapshot on another edit',async()=>{
  const f=await fixture(),before=branchSnapshot(f.rp);
  const r=await app.inject({method:'POST',url:`/api/tasks/${f.root}/collaboration-plans/${f.rp}/ops`,headers:auth,payload:{branch_snapshot:before,ops:[{op:'update_step',slot_key:`${f.a}:work`,role_key:'analyst',expected_result:'Документ требований',after:[]}]}});
  expect(r.statusCode).toBe(200);
  expect(r.json().plan.nodes.find((n:any)=>n.slot_key===`${f.a}:work`).role_key).toBe('analyst');
  expect(r.json().plan.branch_snapshot).not.toBe(before);
  expect(db.prepare('SELECT role_key FROM task_collaboration_plan_nodes WHERE plan_id=?').get(f.rp)).toEqual({role_key:'architect'});
  const stale=await app.inject({method:'POST',url:`/api/tasks/${f.root}/collaboration-plans/${f.rp}/ops`,headers:auth,payload:{branch_snapshot:before,ops:[{op:'remove_step',slot_key:`${f.a}:work`}]}});
  expect(stale.statusCode).toBe(409);
  expect((await approve(f,before)).statusCode).toBe(409);
 });
 it('skips or removes draft child nodes, preserving the remaining executable graph',async()=>{
  for(const op of ['skip_step','remove_step']) {
   const f=await fixture();
   db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result,origin) VALUES(?,?,'extra','analyst',1,'Сводка','owner')").run(crypto.randomUUID(),f.ap);
   db.prepare("INSERT INTO task_collaboration_plan_edges(id,plan_id,from_slot_key,to_slot_key,start_condition) VALUES(?,?,'work','extra','submitted')").run(crypto.randomUUID(),f.ap);
   const r=await app.inject({method:'POST',url:`/api/tasks/${f.root}/collaboration-plans/${f.rp}/ops`,headers:auth,payload:{branch_snapshot:branchSnapshot(f.rp),ops:[{op,slot_key:`${f.a}:work`,reason:'Этот этап лишний'}]}});
   expect(r.statusCode).toBe(200);
   const node=r.json().plan.nodes.find((n:any)=>n.slot_key===`${f.a}:work`);
   if(op==='skip_step')expect(node.skipped_at).toBeTruthy();else expect(node).toBeUndefined();
   expect((await approve(f,r.json().plan.branch_snapshot)).statusCode).toBe(200);
  }
 });
 it('refuses foreign addresses, removing the only worker, and edits after approval',async()=>{
  const f=await fixture();
  const call=(slot:string)=>app.inject({method:'POST',url:`/api/tasks/${f.root}/collaboration-plans/${f.rp}/ops`,headers:auth,payload:{branch_snapshot:branchSnapshot(f.rp),ops:[{op:'remove_step',slot_key:slot}]}});
  expect((await call('outside:work')).statusCode).toBe(403);
  expect((await call(`${f.a}:work`)).statusCode).toBe(400);
  expect((await approve(f)).statusCode).toBe(200);
  expect((await call(`${f.a}:work`)).statusCode).toBe(409);
 });

 it('projects one participant per role and preserves executable assignments and bookmark numbers',async()=>{
  const f=await fixture();
  for(let i=0;i<8;i++) {const id=await task(`Поручение ${i}`,f.root);await plan(id,'builder');}
  const view=(await app.inject({url:`/api/tasks/${f.root}/collaboration-plans`,headers:auth})).json().plans[0];
  expect(view.nodes).toHaveLength(11);expect(view.branch_team).toHaveLength(3);
  expect(view.branch_team.find((m:any)=>m.role_key==='builder').slot_keys).toHaveLength(9);
  expect(view.branch_cards.map((c:any)=>c.tab_number).sort((a:number,b:number)=>a-b)).toEqual(Array.from({length:11},(_,i)=>i));
  for(const member of view.branch_team)for(const slot of member.slot_keys) {
   const node=view.nodes.find((n:any)=>n.slot_key===slot);
   expect(member.task_numbers).toContain(view.branch_cards.find((c:any)=>c.id===node.task_id).tab_number);
  }
  expect((await approve(f,view.branch_snapshot)).statusCode).toBe(200);
  expect(db.prepare('SELECT COUNT(*) n FROM subtasks WHERE task_id IN (SELECT task_id FROM branch_plan_members WHERE root_plan_id=?)').get(f.rp)).toEqual({n:11});
 },30000);

 it('refuses a seventh team member including final critic before any task starts',async()=>{
  const f=await fixture();
  for(const role of ['analyst','qa','designer']){const id=await task(role,f.root);await plan(id,role);}
  const result=await approve(f);expect(result.statusCode).toBe(409);expect(result.json().error).toContain('шести');
  expect(db.prepare('SELECT COUNT(*) n FROM branch_plan_members WHERE root_plan_id=?').get(f.rp)).toEqual({n:0});
 });
 it('proposes one assignment for an existing child instead of a full feature pipeline',async()=>{
  const root=await task('Ветка'),child=await task('Описать стандарт постановки и собрать итог приёмки',root);
  const result=proposalFor(child,'auto');
  expect(result.nodes).toHaveLength(1);expect(result.nodes[0].role_key).toBe('analyst');
 });

});
