// GET /api/coordination/role-load: только фактическая работа на открытых карточках.
// Завершённые карточки, сданные шаги и старые интервалы не создают нагрузку.
// Состояние агента важнее наличия записи запуска; история в БД не переписывается.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";
import type { FastifyInstance } from "fastify";
import { seedRoleAccounts } from "../helpers/seedOwner.js";

const uid = (): string => crypto.randomUUID();

let serverApp: FastifyInstance;
let token: string;
let ownerId: string;

function bearer(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  serverApp = await buildApp();
  await serverApp.ready();

  // Сидим seed-учётку 'u1' до обычного владельца (общий приём, см.
  // test/helpers/seedOwner.ts), иначе ownerId() в общих маршрутах будет
  // возвращать её и тест потеряет изолированность.
  const u1 = db.prepare("SELECT id FROM users WHERE id = 'u1'").get() as { id: string } | undefined;
  if (u1) db.prepare("UPDATE users SET role = 'agent' WHERE id = ?").run("u1");
  // role_* учётки нужны для FOREIGN KEY в attempts.executor_id.
  seedRoleAccounts(db);

  // Регистрация владельца через /api/auth/register (test/setup.ts
  // поднимает ALLOW_REGISTRATION=1) и повышение до owner.
  const email = `role-load-${Date.now()}@test.local`;
  const password = "test-password-strong-1";
  const reg = await serverApp.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password, name: "Role Load Owner" },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const regBody = reg.json() as { user: { id: string; role: string }; token: string };
  ownerId = regBody.user.id;
  token = regBody.token;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

  // Включённая роль builder (уже есть в seed миграции 056). Учётка
  // role_builder — тоже.
  const roleBuilder = db.prepare("SELECT id FROM users WHERE id = 'role_builder'").get() as
    | { id: string }
    | undefined;
  if (!roleBuilder) throw new Error("role_builder учётка не засеяна — тест требует её");

  // Задача с активной попыткой — для active_now.
  const activeTaskId = `task_active_${uid()}`;
  db.prepare(
    `INSERT INTO tasks
       (id, title, status, creator_id, assignee_id, agent_state, position, archived_at,
        ready_for_pickup, ready_set_at)
     VALUES (?, 'role-load active', 'active', ?, 'role_builder', 'in_progress', 0, NULL, 1, datetime('now'))`,
  ).run(activeTaskId, ownerId);
  const activeAttemptId = `att_active_${uid()}`;
  db.prepare(
    `INSERT INTO attempts
       (id, task_id, subtask_id, executor_id, runner, model, routing_role,
        started_at, heartbeat_at, ended_at, outcome, reason)
     VALUES (?, ?, NULL, ?, 'in-process', 'gpt-x', 'builder',
             datetime('now', '-5 minutes'), datetime('now'), NULL, NULL, NULL)`,
  ).run(activeAttemptId, activeTaskId, "role_builder");
  db.prepare("UPDATE tasks SET current_attempt_id = ? WHERE id = ?").run(activeAttemptId, activeTaskId);

  // Задача с ЗАКРЫТЫМ заходом 12 часов назад — попадёт в attempts,
  // но не в active_now.
  const doneTaskId = `task_done_${uid()}`;
  db.prepare(
    `INSERT INTO tasks
       (id, title, status, creator_id, assignee_id, agent_state, position, archived_at,
        ready_for_pickup, ready_set_at)
     VALUES (?, 'role-load done', 'active', ?, 'role_builder', 'review', 0, NULL, 1, datetime('now'))`,
  ).run(doneTaskId, ownerId);
  db.prepare(
    `INSERT INTO attempts
       (id, task_id, subtask_id, executor_id, runner, model, routing_role,
        started_at, heartbeat_at, ended_at, outcome, reason)
     VALUES (?, ?, NULL, ?, 'in-process', 'gpt-x', 'builder',
             datetime('now', '-12 hours'), datetime('now', '-11 hours'),
             datetime('now', '-11 hours'), 'done', NULL)`,
  ).run(`att_done_${uid()}`, doneTaskId, "role_builder");

  // Задача БЕЗ исполнителя, но активная — попадёт в open_slots.
  const orphanTaskId = `task_orphan_${uid()}`;
  db.prepare(
    `INSERT INTO tasks
       (id, title, status, creator_id, assignee_id, agent_state, position, archived_at,
        ready_for_pickup, ready_set_at)
     VALUES (?, 'role-load orphan', 'active', ?, NULL, 'in_progress', 0, NULL, 1, datetime('now', '-2 hours'))`,
  ).run(orphanTaskId, ownerId);

  // Задача В АРХИВЕ — должна быть отфильтрована из всех трёх списков.
  const archivedTaskId = `task_arch_${uid()}`;
  db.prepare(
    `INSERT INTO tasks
       (id, title, status, creator_id, assignee_id, agent_state, position, archived_at,
        ready_for_pickup, ready_set_at)
     VALUES (?, 'role-load archived', 'active', ?, NULL, 'in_progress', 0, datetime('now', '-1 day'), 1, datetime('now'))`,
  ).run(archivedTaskId, ownerId);
  db.prepare(
    `INSERT INTO attempts
       (id, task_id, subtask_id, executor_id, runner, model, routing_role,
        started_at, heartbeat_at, ended_at, outcome, reason)
     VALUES (?, ?, NULL, ?, 'in-process', 'gpt-x', 'builder',
             datetime('now', '-2 days'), datetime('now', '-2 days'),
             datetime('now', '-47 hours'), 'done', NULL)`,
  ).run(`att_arch_${uid()}`, archivedTaskId, "role_builder");
});

afterAll(async () => {
  if (serverApp) await serverApp.close();
});

describe("GET /api/coordination/role-load", () => {
  it("401 без токена", async () => {
    const res = await serverApp.inject({
      method: "GET",
      url: "/api/coordination/role-load?window=24h",
    });
    expect(res.statusCode).toBe(401);
  });

  it("200 + структура ответа", async () => {
    const res = await serverApp.inject({
      method: "GET",
      url: "/api/coordination/role-load?window=24h",
      headers: bearer(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      window: string;
      from: string;
      to: string;
      now: string;
      roles: Array<{ key: string; title: string; position: number; executor_id: string | null }>;
      attempts: Array<{
        id: string;
        task_id: string;
        task_title: string;
        routing_role: string | null;
        started_at: string;
        ended_at: string | null;
        active: boolean;
      }>;
      active_now: Array<{
        kind: string;
        id: string;
        task_id: string;
        role_key: string | null;
      }>;
      open_slots: Array<{ id: string; task_title: string; role_key: string | null }>;
    };
    expect(body.window).toBe("24h");
    expect(typeof body.from).toBe("string");
    expect(typeof body.to).toBe("string");
    expect(typeof body.now).toBe("string");
    expect(Array.isArray(body.roles)).toBe(true);
    expect(Array.isArray(body.attempts)).toBe(true);
    expect(Array.isArray(body.active_now)).toBe(true);
    expect(Array.isArray(body.open_slots)).toBe(true);
    // builder включена и идёт сразу — должен быть в roles.
    const builder = body.roles.find((r) => r.key === "builder");
    expect(builder).toBeTruthy();
    expect(builder!.title).toBe("Разработчик");
    expect(builder!.executor_id).toBe("role_builder");
  });

  it("активная попытка попадает и в attempts, и в active_now", async () => {
    const res = await serverApp.inject({
      method: "GET",
      url: "/api/coordination/role-load?window=24h",
      headers: bearer(),
    });
    const body = res.json() as {
      attempts: Array<{ active: boolean; routing_role: string | null; task_title: string }>;
      active_now: Array<{ kind: string; role_key: string | null; task_title: string }>;
    };
    const activeAttempt = body.attempts.find(
      (a) => a.active && a.task_title === "role-load active",
    );
    expect(activeAttempt).toBeTruthy();
    expect(activeAttempt!.routing_role).toBe("builder");
    const activeSlot = body.active_now.find(
      (s) => s.task_title === "role-load active",
    );
    expect(activeSlot).toBeTruthy();
    expect(activeSlot!.role_key).toBe("builder");
    expect(activeSlot!.kind).toBe("task");
  });

  it("завершённая работа видна в истории, но не в текущей загрузке", async () => {
    const res = await serverApp.inject({
      method: "GET",
      url: "/api/coordination/role-load?window=24h",
      headers: bearer(),
    });
    const body = res.json() as {
      attempts: Array<{ active: boolean; task_title: string }>;
      active_now: Array<{ task_title: string }>;
    };
    const closedAttempt = body.attempts.find(
      (a) => a.task_title === "role-load done",
    );
    expect(closedAttempt).toBeTruthy();
    expect(closedAttempt!.active).toBe(false);
    const inActive = body.active_now.find((s) => s.task_title === "role-load done");
    expect(inActive).toBeUndefined();
  });

  it("открытый слот (assignee_id=NULL) попадает в open_slots", async () => {
    const res = await serverApp.inject({
      method: "GET",
      url: "/api/coordination/role-load?window=24h",
      headers: bearer(),
    });
    const body = res.json() as {
      open_slots: Array<{ task_title: string; role_key: string | null; since: string | null }>;
    };
    const orphan = body.open_slots.find((s) => s.task_title === "role-load orphan");
    expect(orphan).toBeTruthy();
    expect(orphan!.role_key).toBeNull();
    expect(typeof orphan!.since).toBe("string");
  });

  it("окно по умолчанию = 24h; window=week — нормализуется", async () => {
    const def = await serverApp.inject({
      method: "GET",
      url: "/api/coordination/role-load",
      headers: bearer(),
    });
    expect(def.statusCode).toBe(200);
    const defBody = def.json() as { window: string };
    expect(defBody.window).toBe("24h");

    const week = await serverApp.inject({
      method: "GET",
      url: "/api/coordination/role-load?window=week",
      headers: bearer(),
    });
    expect(week.statusCode).toBe(200);
    const weekBody = week.json() as { window: string };
    expect(weekBody.window).toBe("week");

    // Невалидное окно тихо нормализуется до 24h.
    const bad = await serverApp.inject({
      method: "GET",
      url: "/api/coordination/role-load?window=year",
      headers: bearer(),
    });
    const badBody = bad.json() as { window: string };
    expect(badBody.window).toBe("24h");
  });

  it("архивная история не превращается в текущую загрузку", async () => {
    const res = await serverApp.inject({
      method: "GET",
      url: "/api/coordination/role-load?window=week",
      headers: bearer(),
    });
    const body = res.json() as {
      attempts: Array<{ task_title: string }>;
      active_now: Array<{ task_title: string }>;
      open_slots: Array<{ task_title: string }>;
    };
    expect(body.attempts.find((a) => a.task_title === "role-load archived")?.active).toBe(false);
    expect(body.active_now.find((s) => s.task_title === "role-load archived")).toBeUndefined();
    expect(body.open_slots.find((s) => s.task_title === "role-load archived")).toBeUndefined();
  });
});
describe("роль фактического исполнителя старых заходов", () => {
  it("показывает завершённое рабочее время с фактической ролью и сохраняет снимок в БД", async () => {
    const taskId = uid();
    db.prepare("INSERT INTO tasks(id,title,status,creator_id,assignee_id,agent_state) VALUES(?,?,'active',?,'role_qa','in_progress')").run(taskId,"legacy role history",ownerId);
    const rows = [
      { id: uid(), executor: "role_builder", routing: null, expected: "builder" },
      { id: uid(), executor: "role_builder", routing: "architect", expected: "architect" },
      { id: uid(), executor: ownerId, routing: null, expected: null },
    ];
    try {
      for (const row of rows) {
        db.prepare("INSERT INTO attempts(id,task_id,executor_id,routing_role,started_at,ended_at) VALUES(?,?,?,?,datetime('now','-10 minutes'),datetime('now','-5 minutes'))").run(row.id,taskId,row.executor,row.routing);
      }
      const result = await serverApp.inject({method:"GET",url:"/api/coordination/role-load",headers:bearer()});
      expect(result.statusCode).toBe(200);
      for (const row of rows) {
        expect(result.json().attempts.find((a: any) => a.id === row.id)?.routing_role).toBe(row.expected);
      }
      expect(db.prepare("SELECT routing_role FROM attempts WHERE id=?").get(rows[0].id)).toEqual({routing_role:null});
    } finally { db.prepare("DELETE FROM tasks WHERE id=?").run(taskId); }
  });
  it("текущий task-level заход без routing_role остаётся у фактического исполнителя после переназначения", async () => {
    const taskId = uid(), attemptId = uid();
    db.prepare("INSERT INTO tasks(id,title,status,creator_id,assignee_id,agent_state) VALUES(?,?,'active',?,'role_qa','in_progress')").run(taskId,"active executor role",ownerId);
    try {
      db.prepare("INSERT INTO attempts(id,task_id,executor_id,started_at) VALUES(?,?,?,datetime('now','-2 minutes'))").run(attemptId,taskId,"role_builder");
      const result = await serverApp.inject({method:"GET",url:"/api/coordination/role-load",headers:bearer()});
      expect(result.json().active_now.find((a: any) => a.id === taskId)?.role_key).toBe("builder");
    } finally { db.prepare("DELETE FROM tasks WHERE id=?").run(taskId); }
  });
});


describe("статус карточки и работы важнее незакрытого запуска", () => {
  it("completed исключается из всех слоёв даже при in_progress и NULL ended_at", async () => {
    const taskId=uid(), stepId=uid();
    try {
      db.prepare("INSERT INTO tasks(id,title,status,creator_id,agent_state) VALUES(?,?,'completed',?,'in_progress')").run(taskId,"completed ghost",ownerId);
      db.prepare("INSERT INTO subtasks(id,task_id,title,done,agent_state,agent_id) VALUES(?,?,?,0,'in_progress','role_builder')").run(stepId,taskId,"ghost step");
      db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at) VALUES(?,?,?,'role_builder',datetime('now','-7 days'))").run(uid(),taskId,stepId);
      const body=(await serverApp.inject({method:"GET",url:"/api/coordination/role-load",headers:bearer()})).json();
      expect(body.attempts.filter((a:any)=>a.task_id===taskId)).toEqual([]);
      expect(body.active_now.filter((a:any)=>a.task_id===taskId)).toEqual([]);
      expect(body.open_slots.filter((a:any)=>a.id===taskId)).toEqual([]);
    } finally { db.prepare("DELETE FROM tasks WHERE id=?").run(taskId); }
  });
  it("сданный шаг на открытой карточке не продолжает работать из-за NULL ended_at", async () => {
    const taskId=uid(),stepId=uid();
    try {
      db.prepare("INSERT INTO tasks(id,title,status,creator_id) VALUES(?,?,'active',?)").run(taskId,"submitted step",ownerId);
      db.prepare("INSERT INTO subtasks(id,task_id,title,done,agent_state,agent_id) VALUES(?,?,?,1,'in_progress','role_builder')").run(stepId,taskId,"already done");
      db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at) VALUES(?,?,?,'role_builder',datetime('now','-5 days'))").run(uid(),taskId,stepId);
      const body=(await serverApp.inject({method:"GET",url:"/api/coordination/role-load",headers:bearer()})).json();
      expect(body.attempts.filter((a:any)=>a.task_id===taskId)).toEqual([]);
      expect(body.active_now.filter((a:any)=>a.task_id===taskId)).toEqual([]);
    } finally { db.prepare("DELETE FROM tasks WHERE id=?").run(taskId); }
  });
  it("работающий агент виден по состоянию даже без записи запуска", async () => {
    const taskId=uid();
    try {
      db.prepare("INSERT INTO tasks(id,title,status,creator_id,assignee_id,agent_state) VALUES(?,?,'active',?,'role_builder','in_progress')").run(taskId,"state only",ownerId);
      const body=(await serverApp.inject({method:"GET",url:"/api/coordination/role-load",headers:bearer()})).json();
      expect(body.active_now.find((a:any)=>a.task_id===taskId)?.role_key).toBe("builder");
    } finally { db.prepare("DELETE FROM tasks WHERE id=?").run(taskId); }
  });
  it("после завершения агентом работа исчезает без правки attempts", async () => {
    const taskId=uid(),attemptId=uid();
    try {
      db.prepare("INSERT INTO tasks(id,title,status,creator_id,assignee_id,agent_state) VALUES(?,?,'active',?,'role_builder','in_progress')").run(taskId,"agent finishes",ownerId);
      db.prepare("INSERT INTO attempts(id,task_id,executor_id,started_at) VALUES(?,?,'role_builder',datetime('now','-5 minutes'))").run(attemptId,taskId);
      db.prepare("UPDATE tasks SET current_attempt_id=? WHERE id=?").run(attemptId,taskId);
      const read=async()=>(await serverApp.inject({method:"GET",url:"/api/coordination/role-load",headers:bearer()})).json();
      expect((await read()).active_now.some((a:any)=>a.task_id===taskId)).toBe(true);
      db.prepare("UPDATE tasks SET agent_state='review' WHERE id=?").run(taskId);
      const body=await read();
      expect(body.active_now.some((a:any)=>a.task_id===taskId)).toBe(false);
      expect(body.attempts.some((a:any)=>a.id===attemptId)).toBe(false);
    } finally { db.prepare("DELETE FROM tasks WHERE id=?").run(taskId); }
  });
});


describe("подтверждённая история рабочего времени",()=>{
  it("время сданного шага заканчивается сдачей, а не ожиданием закрытия карточки",async()=>{
    const taskId=uid(),stepId=uid(),attemptId=uid();
    try{
      db.prepare("INSERT INTO tasks(id,title,status,creator_id) VALUES(?,?,'completed',?)").run(taskId,"closed with work",ownerId);
      db.prepare("INSERT INTO subtasks(id,task_id,title,done,agent_id) VALUES(?,?,?,1,'role_builder')").run(stepId,taskId,"unique submitted work");
      db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at,ended_at) VALUES(?,?,?,'role_builder',datetime('now','-2 hours'),datetime('now'))").run(attemptId,taskId,stepId);
      db.prepare("INSERT INTO task_events(id,task_id,actor_id,kind,field,to_value,created_at) VALUES(?,?,'role_builder','subtask_done','subtask',?,datetime('now','-90 minutes'))").run(uid(),taskId,"unique submitted work");
      const res=await serverApp.inject({method:"GET",url:"/api/coordination/role-load",headers:bearer()});const body=res.json();
      const work=body.attempts.find((a:any)=>a.id===attemptId);
      expect(work).toBeTruthy();expect(work.active).toBe(false);
      expect(new Date(work.ended_at).getTime()-new Date(work.started_at).getTime()).toBe(30*60*1000);
      expect(body.active_now.some((a:any)=>a.task_id===taskId)).toBe(false);
      db.prepare("UPDATE attempts SET ended_at=NULL WHERE id=?").run(attemptId);
      const recovered=(await serverApp.inject({method:"GET",url:"/api/coordination/role-load",headers:bearer()})).json().attempts.find((a:any)=>a.id===attemptId);
      expect(recovered.ended_at).toBe(work.ended_at);expect(recovered.active).toBe(false);
      expect((db.prepare("SELECT ended_at FROM attempts WHERE id=?").get(attemptId) as any).ended_at).toBeNull();
    }finally{db.prepare("DELETE FROM task_events WHERE task_id=?").run(taskId);db.prepare("DELETE FROM tasks WHERE id=?").run(taskId);}
  });
  it("не приписывает интервалу сдачу чужого исполнителя",async()=>{
    const taskId=uid(),stepId=uid(),attemptId=uid();
    try{
      db.prepare("INSERT INTO tasks(id,title,status,creator_id) VALUES(?,?,'completed',?)").run(taskId,"ambiguous finish",ownerId);
      db.prepare("INSERT INTO subtasks(id,task_id,title,done) VALUES(?,?,?,1)").run(stepId,taskId,"different worker");
      db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at) VALUES(?,?,?,'role_builder',datetime('now','-2 hours'))").run(attemptId,taskId,stepId);
      db.prepare("INSERT INTO task_events(id,task_id,actor_id,kind,to_value,created_at) VALUES(?,?,'role_qa','subtask_done',?,datetime('now','-90 minutes'))").run(uid(),taskId,"different worker");
      const body=(await serverApp.inject({method:"GET",url:"/api/coordination/role-load",headers:bearer()})).json();
      expect(body.attempts.some((a:any)=>a.id===attemptId)).toBe(false);
    }finally{db.prepare("DELETE FROM task_events WHERE task_id=?").run(taskId);db.prepare("DELETE FROM tasks WHERE id=?").run(taskId);}
  });
});

it("перезапуск даёт отдельные неперекрывающиеся интервалы, не время между ними",async()=>{
 const taskId=uid(),stepId=uid(),first=uid(),second=uid();
 try{
  db.prepare("INSERT INTO tasks(id,title,status,creator_id) VALUES(?,?,'completed',?)").run(taskId,"restart history",ownerId);
  db.prepare("INSERT INTO subtasks(id,task_id,title,done,plan_node_key) VALUES(?,?,?,1,'unique-restart')").run(stepId,taskId,"restart work");
  for(const [id,offset] of [[first,'-2 hours'],[second,'-100 minutes']])db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at,ended_at) VALUES(?,?,?,'role_builder',datetime('now',?),CASE WHEN ? THEN datetime('now','-100 minutes') ELSE NULL END)").run(id,taskId,stepId,offset,id===first?1:0);
  db.prepare("INSERT INTO task_events(id,task_id,kind,field,created_at) VALUES(?,?,'plan_subtask_interrupted','unique-restart',datetime('now','-100 minutes'))").run(uid(),taskId);
  db.prepare("INSERT INTO task_events(id,task_id,actor_id,kind,to_value,created_at) VALUES(?,?,'role_builder','subtask_done','restart work',datetime('now','-90 minutes'))").run(uid(),taskId);
  const work=(await serverApp.inject({method:"GET",url:"/api/coordination/role-load",headers:bearer()})).json().attempts;
  const a=work.find((a:any)=>a.id===first),b=work.find((a:any)=>a.id===second);
  expect(a.ended_at).toBe(b.started_at);expect(a.active).toBe(false);expect(b.active).toBe(false);
  expect(new Date(b.ended_at).getTime()-new Date(b.started_at).getTime()).toBe(10*60*1000);
 }finally{db.prepare("DELETE FROM task_events WHERE task_id=?").run(taskId);db.prepare("DELETE FROM tasks WHERE id=?").run(taskId);}
});

describe("task_created_at в слоях role-load", () => {
  it("отдаёт время создания задачи в attempts, active_now и open_slots", async () => {
    const taskId = `task_created_${uid()}`;
    db.prepare(
      `INSERT INTO tasks (id, title, status, creator_id, assignee_id, agent_state, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(taskId, "created at stamp", "active", ownerId, "role_builder", "in_progress", "2026-10-12 13:10:00");
    const attemptId = `attempt_created_${uid()}`;
    db.prepare(
      `INSERT INTO attempts (id, task_id, executor_id, started_at, ended_at, routing_role)
       VALUES (?,?,?,datetime('now','-30 minutes'),datetime('now','-20 minutes'),?)`,
    ).run(attemptId, taskId, "role_builder", "builder");
    const openId = `task_open_created_${uid()}`;
    db.prepare(
      `INSERT INTO tasks (id, title, status, creator_id, assignee_id, agent_state, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(openId, "open created stamp", "active", ownerId, null, "in_progress", "2026-10-11 09:05:00");
    try {
      const body = (await serverApp.inject({
        method: "GET",
        url: "/api/coordination/role-load",
        headers: bearer(),
      })).json() as {
        attempts: Array<{ task_id: string; task_created_at: string }>;
        active_now: Array<{ task_id: string; task_created_at: string }>;
        open_slots: Array<{ id: string; task_created_at: string }>;
      };
      const attempt = body.attempts.find((a) => a.task_id === taskId);
      expect(attempt, "попытка должна быть в attempts").toBeTruthy();
      expect(attempt?.task_created_at).toBe("2026-10-12 13:10:00");
      const active = body.active_now.find((a) => a.task_id === taskId);
      expect(active, "задача с назначенным исполнителем должна быть в active_now").toBeTruthy();
      expect(active?.task_created_at).toBe("2026-10-12 13:10:00");
      const open = body.open_slots.find((s) => s.id === openId);
      expect(open, "слот без исполнителя должен быть в open_slots").toBeTruthy();
      expect(open?.task_created_at).toBe("2026-10-11 09:05:00");
    } finally {
      db.prepare("DELETE FROM attempts WHERE id=?").run(attemptId);
      db.prepare("DELETE FROM tasks WHERE id IN (?,?)").run(taskId, openId);
    }
  });
});
