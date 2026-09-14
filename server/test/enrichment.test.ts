import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "/home/maksim/Проекты/New-Todoist/server/src/index.js";
import db from "/home/maksim/Проекты/New-Todoist/server/src/db.js";

// Порядок работ: задача ждёт завершения тех, от которых зависит.
//
// Отсюда 14.09.2026 убраны проверки старой доски объявлений — свободная
// задача с ярлыком профиля, которую агент забирал сам, и вопрос владельцу,
// когда словарный подбор не справился. Исполнитель теперь подбирается по
// смыслу и назначается сразу при создании, поэтому ни доски, ни вопроса
// больше нет. Зависимости к той схеме отношения не имели и остались.
describe("зависимости задач: порядок работ", () => {
  let app: FastifyInstance;
  let ownerAuth = "";
  let agentAuth = "";
  let agentId = "";

  async function register(name: string, email: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email, password: "password123" },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function createTask(title: string): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: ownerAuth },
      payload: { title },
    });
    expect(created.statusCode).toBe(200);
    return created.json().task.id as string;
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await register("Deps owner", "deps-owner@test");
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.user.id);
    ownerAuth = `Bearer ${owner.token}`;
    const agent = await register("Deps agent", "deps-agent@test");
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agent.user.id);
    agentId = agent.user.id;
    agentAuth = `Bearer ${agent.token}`;
  });

  it("зависимость видна в карточке и считается незакрытой, пока блокер активен", async () => {
    const blockerId = await createTask("сначала это");
    const taskId = await createTask("потом это");
    const put = await app.inject({
      method: "PUT",
      url: `/api/tasks/${taskId}/dependencies`,
      headers: { authorization: ownerAuth },
      payload: { depends_on_task_ids: [blockerId] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().unmet_dependency_ids).toContain(blockerId);

    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(blockerId);
    const after = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/dependencies`,
      headers: { authorization: ownerAuth },
    });
    expect(after.json().unmet_dependency_ids).toHaveLength(0);
  });

  it("задачу с незакрытой зависимостью исполнитель взять не может", async () => {
    const blockerId = await createTask("блокер для захвата");
    const taskId = await createTask("ждёт блокера");
    await app.inject({
      method: "PUT",
      url: `/api/tasks/${taskId}/dependencies`,
      headers: { authorization: ownerAuth },
      payload: { depends_on_task_ids: [blockerId] },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: ownerAuth },
      payload: { assignee_id: agentId, ready_for_pickup: true },
    });

    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: agentAuth },
      payload: {},
    });
    expect(claim.statusCode).toBe(403);
    expect(claim.json().error).toContain("зависимост");
  });

  it("циклическая зависимость отклоняется", async () => {
    const a = await createTask("A");
    const b = await createTask("B");
    await app.inject({
      method: "PUT",
      url: `/api/tasks/${b}/dependencies`,
      headers: { authorization: ownerAuth },
      payload: { depends_on_task_ids: [a] },
    });
    const cycle = await app.inject({
      method: "PUT",
      url: `/api/tasks/${a}/dependencies`,
      headers: { authorization: ownerAuth },
      payload: { depends_on_task_ids: [b] },
    });
    expect(cycle.statusCode).toBe(400);
  });
});
