// server/test/closedTasksArchive.test.ts
//
// Закрытые задачи живут в архиве (владелец, 01.11.2026): «в архив уходят
// отменённые и выполненные, карточка одинаковая, единственная пометка —
// отменённая либо выполненная. Из всех остальных списков убрать».
//
// Проверяется поведение через API (app.inject), а не прямым SQL:
//   1) выполненная карточка попадает в архивный список;
//   2) её можно вернуть в работу (restore снимает выполнение);
//   3) её можно удалить окончательно (после архивирования — purge).
//
// До правки (31.10.2026) пункты 1–3 падали: архивный список знал только
// про archived_at, restore отвечал «not_archived», purge — тоже.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

type Reg = { id: string; jwt: string };

async function makeUser(app: FastifyInstance, name: string, email: string): Promise<Reg> {
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name, email, password: "password123" },
  });
  expect(reg.statusCode).toBe(200);
  const body = reg.json() as { user: { id: string }; token: string };
  return { id: body.user.id, jwt: body.token };
}

function bearer(jwt: string) {
  return { authorization: `Bearer ${jwt}` };
}

describe("Закрытые задачи в архиве (владелец, 01.11.2026)", () => {
  let app: FastifyInstance;
  let owner: Reg;

  beforeAll(async () => {
    app = await buildApp();
    owner = await makeUser(app, "Владелец закрытых", `closed-${Date.now()}@example.test`);
    db.prepare("UPDATE users SET role = 'owner', type = 'human' WHERE id = ?").run(owner.id);
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeTask(title: string): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: bearer(owner.jwt),
      payload: { title, project_id: null, assignee_id: null },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as { task: { id: string } }).task.id;
  }

  async function complete(taskId: string): Promise<void> {
    const r = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: bearer(owner.jwt),
      payload: { status: "completed" },
    });
    expect(r.statusCode).toBe(200);
  }

  it("выполненная карточка попадает в архивный список", async () => {
    const taskId = await makeTask("Закрытая задача в архиве");
    await complete(taskId);

    const list = await app.inject({
      method: "GET",
      url: "/api/tasks?archived=true",
      headers: bearer(owner.jwt),
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as { id: string }[]).map((t) => t.id);
    expect(ids).toContain(taskId);
  });

  it("выполненная карточка не попадает в обычный список задач", async () => {
    const taskId = await makeTask("Закрытая задача вне архива");
    await complete(taskId);

    const list = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: bearer(owner.jwt),
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as { id: string }[]).map((t) => t.id);
    expect(ids).not.toContain(taskId);
  });

  it("выполненную карточку можно вернуть в работу — выполнение снимается", async () => {
    const taskId = await makeTask("Закрытая, но вернётся в работу");
    await complete(taskId);

    const restore = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/restore`,
      headers: bearer(owner.jwt),
    });
    expect(restore.statusCode).toBe(200);

    const row = db
      .prepare("SELECT status, completed_at FROM tasks WHERE id = ?")
      .get(taskId) as { status: string; completed_at: string | null };
    expect(row.status).toBe("active");
    expect(row.completed_at).toBeNull();
  });

  it("выполненную карточку можно удалить окончательно", async () => {
    const taskId = await makeTask("Закрытая и удаляемая навсегда");
    await complete(taskId);

    // Путь владельца: сначала в архив, затем удаление навсегда.
    const archived = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: bearer(owner.jwt),
    });
    expect(archived.statusCode).toBe(200);

    const purged = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${taskId}`,
      headers: bearer(owner.jwt),
    });
    expect(purged.statusCode).toBe(200);

    const left = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id = ?").get(taskId) as { n: number };
    expect(left.n).toBe(0);
  });
});
