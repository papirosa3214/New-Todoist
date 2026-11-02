import { beforeAll, afterAll, expect, it } from 'vitest';
import db, { migrate } from '../src/db.js';
import { runMigrations } from '../src/migrations.js';
import { addClient, removeClient } from '../src/ws.js';
const messages: any[]=[];
const socket={readyState:1,send:(s:string)=>messages.push(JSON.parse(s))};
const tick=()=>new Promise<void>(r=>queueMicrotask(r));
beforeAll(()=>{migrate();runMigrations();addClient('u1',socket);db.prepare("INSERT INTO tasks(id,title,creator_id,status) VALUES('ws-energy-card','Card','u1','active')").run();});
afterAll(()=>removeClient('u1',socket));
it('publishes committed plan/task changes without polling and coalesces a transaction',async()=>{
 await tick();messages.length=0;
 db.transaction(()=>{db.prepare("UPDATE tasks SET title='First' WHERE id='ws-energy-card'").run();db.prepare("UPDATE tasks SET title='Second' WHERE id='ws-energy-card'").run();})();
 await tick();
 expect(messages.filter(m=>m.type==='task:changed'&&m.task_id==='ws-energy-card')).toHaveLength(1);
});
it('does not publish rolled-back changes',async()=>{
 await tick();messages.length=0;
 expect(()=>db.transaction(()=>{db.prepare("UPDATE tasks SET title='Rollback' WHERE id='ws-energy-card'").run();throw Error('rollback');})()).toThrow();
 await tick();expect(messages).toHaveLength(0);
});
it('ignores unchanged data and agent lease renewals',async()=>{
 await tick();messages.length=0;
 db.prepare("UPDATE tasks SET title=title, agent_heartbeat_at=datetime('now') WHERE id='ws-energy-card'").run();
 await tick();expect(messages).toHaveLength(0);
});

it('publishes preparation states and plan edits to the owning card',async()=>{
 await tick();messages.length=0;
 db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,profile,created_by) VALUES('energy-plan','ws-energy-card',1,'manual','u1')").run();
 await tick();expect(messages.some(m=>m.type==='task:changed'&&m.task_id==='ws-energy-card')).toBe(true);
 messages.length=0;
 db.prepare("UPDATE task_collaboration_plans SET rationale='Changed' WHERE id='energy-plan'").run();
 await tick();expect(messages.some(m=>m.type==='task:changed'&&m.task_id==='ws-energy-card')).toBe(true);
});
it('refreshes ancestor cards for child edits',async()=>{
 db.prepare("INSERT INTO tasks(id,title,creator_id,status,parent_id) VALUES('energy-child','Child','u1','active','ws-energy-card')").run();
 await tick();messages.length=0;
 db.prepare("UPDATE tasks SET title='Changed child' WHERE id='energy-child'").run();
 await tick();expect(messages.filter(m=>m.type==='task:changed').map(m=>m.task_id).sort()).toEqual(['energy-child','ws-energy-card']);
});
it('publishes role and job transitions but not queue lease renewals',async()=>{
 await tick();messages.length=0;
 db.prepare("UPDATE roles SET title=title||' test' WHERE key=(SELECT key FROM roles LIMIT 1)").run();
 db.prepare("INSERT INTO role_run_jobs(id,task_id,reason,dedupe_key) VALUES('energy-job','ws-energy-card','assigned','energy-job')").run();
 await tick();expect(messages.some(m=>m.type==='roles:changed')).toBe(true);expect(messages.some(m=>m.type==='role-jobs:changed')).toBe(true);
 messages.length=0;db.prepare("UPDATE role_run_jobs SET lease_owner='worker',lease_expires_at=datetime('now') WHERE id='energy-job'").run();
 await tick();expect(messages).toHaveLength(0);
});

it('publishes preparation completion and failure without a task edit',async()=>{
 await tick();messages.length=0;
 db.prepare("INSERT INTO task_preparation_jobs(task_id,input_version,snapshot) VALUES('ws-energy-card',1,'{}')").run();
 await tick();messages.length=0;
 db.prepare("UPDATE task_preparation_jobs SET status='ready' WHERE task_id='ws-energy-card'").run();
 await tick();expect(messages.some(m=>m.type==='task:changed'&&m.task_id==='ws-energy-card')).toBe(true);
 messages.length=0;
 db.prepare("UPDATE task_preparation_jobs SET status='failed',error='fixture' WHERE task_id='ws-energy-card'").run();
 await tick();expect(messages.some(m=>m.type==='task:changed'&&m.task_id==='ws-energy-card')).toBe(true);
});

// Сущности вне задач (проекты, метки, заметки, рутины) раньше не порождали
// ни события, ни журнала: правка рутины или проекта на одном устройстве не
// доезжала до другого до перезагрузки экрана (владелец 01.11.2026).
it('publishes changes of entities outside tasks',async()=>{
 await tick();messages.length=0;
 db.prepare("INSERT INTO projects(id,name) VALUES('energy-project','Entity project')").run();
 await tick();expect(messages.some(m=>m.type==='project:changed'&&m.id==='energy-project')).toBe(true);

 messages.length=0;
 db.prepare("INSERT INTO labels(id,name) VALUES('energy-label','Entity label')").run();
 await tick();expect(messages.some(m=>m.type==='label:changed'&&m.id==='energy-label')).toBe(true);

 // Заметки лежат в `user_notes`, а не в заброшенной `notes`: сервер
 // следил именно за `notes`, из-за чего правка заметки не порождала
 // событие вообще (У1 в заметке Архитектора, разбор 02.11.2026).
 messages.length=0;
 db.prepare("INSERT INTO user_notes(id,title,content) VALUES('energy-note','Entity note','{}')").run();
 await tick();expect(messages.some(m=>m.type==='note:changed'&&m.id==='energy-note')).toBe(true);

 messages.length=0;
 db.prepare("INSERT INTO task_schedules(id,title,rule_kind,time_local,created_by) VALUES('energy-sched','Entity routine','daily','09:00','u1')").run();
 await tick();expect(messages.some(m=>m.type==='schedule:changed'&&m.id==='energy-sched')).toBe(true);

 messages.length=0;
 db.prepare("UPDATE task_schedules SET title='Entity routine 2' WHERE id='energy-sched'").run();
 await tick();expect(messages.some(m=>m.type==='schedule:changed'&&m.id==='energy-sched')).toBe(true);
});
