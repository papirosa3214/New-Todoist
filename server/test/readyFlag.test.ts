// Тест флага готовности к самозахвату (миграция 026, карточка d598de9f).
// Три инварианта:
//   1) чужой (не владелец) PATCH /tasks/:id с ready_for_pickup=true → 403
//   2) claim задачи без флага → 400 с сообщением про готовность
//   3) PATCH от владельца работает, и после него claim тем же агентом проходит
//
// Кнопки в вебе и на iOS не покрываем — это отдельные карточки.
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Флаг готовности к самозахвату (карточка d598de9f)", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerAuth: string;
  let agentAuth: string;
  let agentId: string;

  async function makeUser(
    name: string,
    email: string,
    patch?: { role?: string; type?: string },
  ) {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email, password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    const body = reg.json();
    if (patch?.role)
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(
        patch.role,
        body.user.id,
      );
    if (patch?.type)
      db.prepare("UPDATE users SET type = ? WHERE id = ?").run(
        patch.type,
        body.user.id,
      );
    return { id: body.user.id as string, jwt: body.token as string };
  }

  async function bearer(jwt: string) {
    return { authorization: `Bearer ${jwt}` };
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await makeUser("Владелец", "owner@ready.test", {
      role: "owner",
    });
    ownerId = owner.id;
    ownerAuth = (await bearer(owner.jwt)).authorization;

    const agent = await makeUser("Агент", "agent@ready.test", {
      type: "ai",
    });
    agentId = agent.id;
    agentAuth = (await bearer(agent.jwt)).authorization;
  });

  /** Создать задачу, назначенную на агента; возвращает её id. */
  async function createTaskForAgent(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: ownerAuth },
      payload: {
        title: "тест: задача для проверки флага готовности",
        assignee_id: agentId,
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json().task.id as string;
  }

  it("агент не может поднять чужой флаг готовности → 403", async () => {
    const taskId = await createTaskForAgent();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: agentAuth },
      payload: { ready_for_pickup: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/владелец/);

    // БД не тронута
    const row = db
      .prepare("SELECT ready_for_pickup FROM tasks WHERE id = ?")
      .get(taskId) as { ready_for_pickup: number };
    expect(row.ready_for_pickup).toBe(0);
  });

  it("claim без флага → 400 с понятной причиной", async () => {
    const taskId = await createTaskForAgent();

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: agentAuth },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/готова к самозахвату/);

    // Аренда не выдана, agent_state пустой
    const row = db
      .prepare(
        "SELECT agent_state, assignee_id FROM tasks WHERE id = ?",
      )
      .get(taskId) as { agent_state: string | null; assignee_id: string };
    expect(row.agent_state).toBeNull();
    // assignee_id мог остаться за тем, кого задали изначально
    // (owner сделал assignee_id=agent), — это не значит «агент её взял».
  });

  it("PATCH от владельца → flag=1; затем claim тем же агентом → 200", async () => {
    const taskId = await createTaskForAgent();

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: ownerAuth },
      payload: { ready_for_pickup: true },
    });
    expect(patch.statusCode).toBe(200);
    const updated = patch.json().task;
    expect(updated.ready_for_pickup).toBe(1);
    expect(updated.ready_set_by).toBe(ownerId);
    expect(updated.ready_set_at).toBeTruthy();

    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: agentAuth },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().task.agent_state).toBe("in_progress");

    // Повторная установка флага тем же значением не пишет лишнего события
    const eventsBefore = (db
      .prepare(
        "SELECT COUNT(*) as n FROM task_events WHERE task_id = ? AND kind = ?",
      )
      .get(taskId, "ready_flag_changed") as { n: number }).n;
    const idempotent = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: ownerAuth },
      payload: { ready_for_pickup: true },
    });
    expect(idempotent.statusCode).toBe(200);
    const eventsAfter = (db
      .prepare(
        "SELECT COUNT(*) as n FROM task_events WHERE task_id = ? AND kind = ?",
      )
      .get(taskId, "ready_flag_changed") as { n: number }).n;
    expect(eventsAfter).toBe(eventsBefore);

    // Снятие флага владельцем (false) — отдельное событие
    const unset = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: ownerAuth },
      payload: { ready_for_pickup: false },
    });
    expect(unset.statusCode).toBe(200);
    const afterUnset = db
      .prepare(
        "SELECT ready_for_pickup, ready_set_at, ready_set_by FROM tasks WHERE id = ?",
      )
      .get(taskId) as {
      ready_for_pickup: number;
      ready_set_at: string | null;
      ready_set_by: string | null;
    };
    expect(afterUnset.ready_for_pickup).toBe(0);
    expect(afterUnset.ready_set_at).toBeNull();
    expect(afterUnset.ready_set_by).toBeNull();
  });
});
