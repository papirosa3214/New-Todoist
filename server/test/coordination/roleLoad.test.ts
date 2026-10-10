// e2e: GET /api/coordination/role-load — Гант загрузки ролей по факту
// (карточка 1117d06c…). Минимальные данные: одна роль, один закрытый
// заход, одна активная попытка, одна задача без исполнителя. Проверяем:
//
//   1. Без токена — 401.
//   2. Со токеном — 200, ответ содержит ровно те поля, что обещает
//      контракт (roles/attempts/active_now/open_slots + времена окна).
//   3. Активная попытка попадает и в attempts, и в active_now.
//   4. Закрытый заход виден в attempts, в active_now его нет.
//   5. Открытый слот (assignee_id=NULL, status='active') попадает в
//      open_slots.
//   6. Окно по умолчанию — 24h; окно 3d шире и захватывает тот же
//      закрытый заход.
//   7. Задача в архиве не попадает никуда.
//
// Контракт read-only, поэтому других проверок не делаем.

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
             datetime('now', '-2 days'), 'done', NULL)`,
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

  it("закрытый заход виден в attempts, но НЕ в active_now", async () => {
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

  it("задача в архиве не попадает ни в attempts, ни в open_slots, ни в active_now", async () => {
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
    expect(body.attempts.find((a) => a.task_title === "role-load archived")).toBeUndefined();
    expect(body.active_now.find((s) => s.task_title === "role-load archived")).toBeUndefined();
    expect(body.open_slots.find((s) => s.task_title === "role-load archived")).toBeUndefined();
  });
});