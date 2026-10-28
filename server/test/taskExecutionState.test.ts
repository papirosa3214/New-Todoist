import crypto from 'node:crypto';
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import type { FastifyInstance } from 'fastify';

// MAK-71: единая схема исполнения — план. Ручной запуск (`POST /run`) идёт
// через `tryStartSingleExecutorPlan` → план `single_executor` + узел, а не
// через `role_run_jobs`/`assignee_id`. Роль запуска берётся заранее, чтобы
// подбор не ходил в модель. Роль в процессе подменена заглушкой, чтобы
// тест не поднимал Pi-агента (как в mak68SingleExecutorEntries).
vi.mock('../src/runtime/inProcessRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtime/inProcessRun.js')>();
  return {
    ...actual,
    runRoleInProcess: async () => ({ runId: 'launch-test-run', completion: Promise.resolve() }),
  };
});

import {buildApp} from '../src/index.js';
import db from '../src/db.js';
import {taskExecutionState} from '../src/runtime/taskExecutionState.js';

describe('single executor launch',()=>{
 let app:FastifyInstance;let auth:string;let id:string;
 const owner=`launch-owner-${crypto.randomUUID()}`;
 beforeAll(async()=>{
  app=await buildApp();
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,type,task_intake_mode) VALUES(?, 'Launch Owner',?,'!','owner','human','manual')").run(owner,`${owner}@test`);
  db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES('role_researcher','Researcher','role-researcher-launch@test','!','agent','ai')").run();
  auth=`Bearer ${app.jwt.sign({id:owner})}`;
  id=`launch-${crypto.randomUUID()}`;
  db.prepare("INSERT INTO tasks(id,title,creator_id,status,owner_selected_role) VALUES(?,'Один исполнитель через план',?,'active','researcher')").run(id,owner);
 });
 afterAll(async()=>{
  db.prepare('DELETE FROM attempts WHERE task_id=?').run(id);
  db.prepare('DELETE FROM role_run_jobs WHERE task_id=?').run(id);
  db.prepare('DELETE FROM subtasks WHERE task_id=?').run(id);
  db.prepare('DELETE FROM task_collaboration_plan_nodes WHERE plan_id IN (SELECT id FROM task_collaboration_plans WHERE task_id=?)').run(id);
  db.prepare('DELETE FROM task_collaboration_plans WHERE task_id=?').run(id);
  db.prepare('DELETE FROM task_events WHERE task_id=?').run(id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(owner);
  await app.close();
 });
 it('запуск создаёт один план и запирает конфликтующие действия',async()=>{
  const first=await app.inject({method:'POST',url:`/api/tasks/${id}/run`,headers:{authorization:auth},payload:{mode:'executor'}});
  expect(first.statusCode).toBe(200);
  // Схема одна — план; различия single/team больше нет, но признак
  // активного плана запирает смену исполнителя. Явный запуск владельца разрешён.
  // can_use_plan не запирается планом: поверх утверждённого плана можно
  // завести новую revision (POST /collaboration-plans).
  expect(taskExecutionState(id)).toMatchObject({scheme:'team',can_launch:true,can_change_executor:false});
  // Ручной повтор запускает тот же шаг; план ровно один.
  const second=await app.inject({method:'POST',url:`/api/tasks/${id}/run`,headers:{authorization:auth},payload:{mode:'executor'}});
  expect(second.statusCode,second.body).toBe(200);
  const plans=db.prepare('SELECT profile,status FROM task_collaboration_plans WHERE task_id=?').all(id);
  expect(plans).toEqual([{profile:'single_executor',status:'approved'}]);
  const patch=await app.inject({method:'PATCH',url:`/api/tasks/${id}`,headers:{authorization:auth},payload:{assignee_id:owner}});
  expect(patch.statusCode).toBe(409);
 });
 it('терминальный сбой захода виден в состоянии, повторный старт узла работает',async()=>{
  // Имитируем терминальный сбой захода: узел отпущен, в очереди мёртвая
  // запись с причиной. taskExecutionState должен показать failed+error.
  const sub=db.prepare('SELECT id FROM subtasks WHERE task_id=?').get(id) as {id:string}|undefined;
  expect(sub).toBeTruthy();
  db.prepare('UPDATE subtasks SET agent_state=NULL, agent_id=NULL, current_attempt_id=NULL WHERE id=?').run(sub!.id);
  db.prepare("UPDATE attempts SET ended_at=datetime('now'), outcome='failed' WHERE subtask_id=? AND ended_at IS NULL").run(sub!.id);
  db.prepare(`INSERT INTO role_run_jobs(id,task_id,reason,dedupe_key,status,last_error)
              VALUES(?,?, 'after_run', ?, 'dead', 'model unavailable')`).run(crypto.randomUUID(), id, `launch-test:${id}`);
  const st=taskExecutionState(id);
  expect(st.status).toBe('failed');
  expect(st.error).toBe('model unavailable');
  // Канонический повтор — ручной старт узла плана.
  const retry=await app.inject({method:'POST',url:`/api/subtasks/${sub!.id}/run`,headers:{authorization:auth}});
  expect(retry.statusCode).toBe(200);
 });
});
