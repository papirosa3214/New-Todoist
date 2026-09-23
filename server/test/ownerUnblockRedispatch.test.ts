// Ответ владельца на блокировку ролевой карточки будит роль снова.
//
// Живая проба C3 23.09.2026 (карточка bad6799f): Разработчик
// заблокировался с вопросом, владелец ответил и снял блокировку —
// state=null обнулил assignee_id, флаг готовности остался поднятым,
// а раздачу никто не позвал. Роль не проснулась, задача осталась ничьей.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

const ownerId = `unblock-owner-${crypto.randomUUID()}`;
const created: string[] = [];

function blockedRoleTask(ready: 0 | 1): string {
  const id = `unblock-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO tasks (id, title, creator_id, status, assignee_id, agent_state,
                        ready_for_pickup, owner_selected_role, dispatched_role)
     VALUES (?, ?, ?, 'active', 'role_builder', 'blocked', ?, 'builder', 'builder')`,
  ).run(id, "Проба ответа на блокировку", ownerId, ready);
  created.push(id);
  return id;
}

function jobsOf(taskId: string) {
  return db
    .prepare("SELECT reason, status FROM role_run_jobs WHERE task_id = ?")
    .all(taskId) as { reason: string; status: string }[];
}

describe("ответ владельца на блокировку раздаёт роль заново", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let builderAuth: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    seedRoleAccounts(db);
    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, type)
       VALUES (?, 'Unblock Owner', ?, '!', 'owner', 'human')`,
    ).run(ownerId, `${ownerId}@test`);
    ownerAuth = { authorization: `Bearer ${app.jwt.sign({ id: ownerId })}` };
    builderAuth = { authorization: `Bearer ${app.jwt.sign({ id: "role_builder" })}` };
  });

  afterAll(async () => {
    for (const id of created) {
      for (const t of ["role_run_jobs", "task_events", "comments", "notifications", "agent_inbox", "attempts"]) {
        db.prepare(`DELETE FROM ${t} WHERE task_id = ?`).run(id);
      }
      db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    }
    db.prepare("DELETE FROM users WHERE id = ?").run(ownerId);
    await app.close();
  });

  it("флаг поднят — роль назначена снова и запуск стоит в очереди", async () => {
    const id = blockedRoleTask(1);
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/state`,
      headers: ownerAuth,
      payload: { state: null, comment: "Синий" },
    });
    expect(res.statusCode).toBe(200);
    const row = db
      .prepare("SELECT assignee_id, agent_state FROM tasks WHERE id = ?")
      .get(id) as { assignee_id: string | null; agent_state: string | null };
    expect(row.assignee_id).toBe("role_builder");
    expect(row.agent_state).toBeNull();
    expect(jobsOf(id)).toEqual([{ reason: "assigned", status: "queued" }]);
  });

  it("флаг не поднят — никто не назначается и запуска нет", async () => {
    const id = blockedRoleTask(0);
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/state`,
      headers: ownerAuth,
      payload: { state: null },
    });
    expect(res.statusCode).toBe(200);
    const row = db.prepare("SELECT assignee_id FROM tasks WHERE id = ?").get(id) as {
      assignee_id: string | null;
    };
    expect(row.assignee_id).toBeNull();
    expect(jobsOf(id)).toEqual([]);
  });

  it("роли снять свою блокировку нельзя — и раздачи нет", async () => {
    const id = blockedRoleTask(1);
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/state`,
      headers: builderAuth,
      payload: { state: null },
    });
    expect(res.statusCode).toBe(400);
    expect(jobsOf(id)).toEqual([]);
  });
});
