import {beforeAll,afterAll,it,expect} from 'vitest';
import {buildApp} from '../src/index.js';
import db from '../src/db.js';
import {seedRoleAccounts} from './helpers/seedOwner.js';
import {taskflowTools,setInProcessApp} from '../src/runtime/inProcessRun.js';
import {checkWorkPlanStore,raiseWorkPlanAlert,repairWorkPlanTriggers} from '../src/lib/workPlanWatcher.js';
import {WORK_PLAN_INSTRUCTION} from '../src/lib/subtaskWorkPlan.js';
let app:any;
const items=[{id:'inspect',title:'Изучить контракт',state:'done'},{id:'implement',title:'Реализовать',state:'in_progress'},{id:'verify',title:'Проверить',state:'pending'}];
function headers(id='role_builder'){return {authorization:'Bearer '+app.jwt.sign({id})};}
const read=()=>app.inject({method:'GET',url:'/api/subtasks/work-plan-step/work-plan',headers:headers('u1')});
const put=(payload:any,id='role_builder')=>app.inject({method:'PUT',url:'/api/subtasks/work-plan-step/work-plan',headers:headers(id),payload});
beforeAll(async()=>{
 app=await buildApp();await app.ready();setInProcessApp(app);seedRoleAccounts(db);
 db.prepare("INSERT INTO tasks(id,title,creator_id,assignee_id,agent_state) VALUES('work-plan-task','Задача','u1','role_builder','in_progress')").run();
 db.prepare("INSERT INTO subtasks(id,task_id,title,agent_id,agent_state) VALUES('work-plan-step','work-plan-task','Работа','role_builder','in_progress')").run();
});
afterAll(async()=>{await app.close();});
it('protects access and honestly returns absent plan',async()=>{
 expect((await app.inject({method:'GET',url:'/api/subtasks/work-plan-step/work-plan'})).statusCode).toBe(401);
 expect((await read()).json()).toEqual({plan:null});
 expect((await put({base_revision:0,items},'u1')).statusCode).toBe(403);
 expect((await put({base_revision:0,items},'role_critic_verifier')).statusCode).toBe(403);
});
it('executor persists progress and version fence without changing slot or task',async()=>{
 const before=db.prepare("SELECT done,agent_id,agent_state FROM subtasks WHERE id='work-plan-step'").get();
 const result=await put({base_revision:0,items});expect(result.statusCode,result.body).toBe(200);
 expect(result.json().plan.revision).toBe(1);expect((await read()).json().plan.items).toEqual(items);
 expect((await put({base_revision:0,items})).statusCode).toBe(409);
 expect(db.prepare("SELECT done,agent_id,agent_state FROM subtasks WHERE id='work-plan-step'").get()).toEqual(before);
 expect((db.prepare("SELECT agent_state FROM tasks WHERE id='work-plan-task'").get() as any).agent_state).toBe('in_progress');
});
it('rejects invalid and ambiguous current stages',async()=>{
 expect((await put({base_revision:1,items:[]})).statusCode).toBe(400);
 expect((await put({base_revision:1,items:[items[1],{...items[1],id:'other'}]})).statusCode).toBe(400);
 expect((await put({base_revision:1,items:[items[0],items[0]]})).statusCode).toBe(400);
});
it('runtime tool is usable in the current slot and cannot choose another slot',async()=>{
 const tool=taskflowTools('builder',null,'work-plan-task','work-plan-step').find(t=>t.name==='taskflow_work_plan')!;
 expect(tool.description).toContain(WORK_PLAN_INSTRUCTION);
 const readResult:any=await tool.execute('read',{});expect(readResult.content[0].text).toContain('Изучить контракт');
 const update:any=await tool.execute('update',{base_revision:1,items:items.map(i=>({...i,state:'done'}))});expect(update.content[0].text).toContain('"revision": 2');
 expect((db.prepare("SELECT done FROM subtasks WHERE id='work-plan-step'").get() as any).done).toBe(0);
 db.prepare("UPDATE subtasks SET done=1,agent_state=NULL WHERE id='work-plan-step'").run();
 expect((await put({base_revision:2,items})).statusCode).toBe(403);
});
it('probe heals the stale ledger trigger that broke it on 25.10.2026',()=>{
 // Воспроизводим причину: триггер сборки d96358f9 ссылается на OLD в INSERT,
 // где строки OLD нет. Любая вставка в task_events падает с «no such column: OLD.id»,
 // а проба чек-листа вставляет через журнал изменений задач.
 db.exec("DROP TRIGGER IF EXISTS tf_task_changes_task_events_insert");
 db.exec(`CREATE TRIGGER tf_task_changes_task_events_insert AFTER INSERT ON task_events
   WHEN NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT,'no such column: OLD.id'); END`);
 expect(checkWorkPlanStore().ok).toBe(false);
 repairWorkPlanTriggers();
 expect(checkWorkPlanStore()).toEqual({ok:true});
 expect(db.prepare("SELECT COUNT(*) n FROM tasks WHERE id LIKE 'work-plan-probe-%'").get()).toEqual({n:0});
});
it('probe heals the stale ledger trigger that broke it on 25.10.2026',()=>{
 // Точная копия сломанного триггера сборки d96358f9: условие «изменилось»
 // с OLD стоит на INSERT, где строки OLD нет. Любая вставка в tasks падает
 // с «no such column: OLD.id», а проба чек-листа заводит служебные карточку
 // и подзадачу — падала она.
 db.exec("DROP TRIGGER IF EXISTS tf_task_changes_ins");
 db.exec(`CREATE TRIGGER tf_task_changes_ins AFTER INSERT ON tasks
   WHEN NEW.id IS NOT OLD.id BEGIN INSERT INTO task_changes(task_id,changed_at) VALUES(NEW.id,datetime('now')); END`);
 expect(checkWorkPlanStore().ok).toBe(false);
 repairWorkPlanTriggers();
 expect(checkWorkPlanStore()).toEqual({ok:true});
 expect((db.prepare("SELECT COUNT(*) n FROM tasks WHERE id LIKE 'work-plan-probe-%'").get() as any).n).toBe(0);
});
it('probe exercises writes and leaves no rows; alert deduplicates',()=>{
 expect(checkWorkPlanStore()).toEqual({ok:true});
 expect((db.prepare("SELECT COUNT(*) n FROM tasks WHERE id LIKE 'work-plan-probe-%'").get() as any).n).toBe(0);
 raiseWorkPlanAlert('Пробная ошибка');raiseWorkPlanAlert('Та же ошибка');
 expect((db.prepare("SELECT COUNT(*) n FROM tasks WHERE incident_key = 'work-plan-watch'").get() as any).n).toBe(1);
});
