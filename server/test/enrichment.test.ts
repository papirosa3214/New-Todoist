import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

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

  it("policy review допускает после agent_state=review, без ожидания completed", async () => {
    const blockerId = await createTask("предшественник review");
    const taskId = await createTask("policy review");
    const put = await app.inject({
      method: "PUT",
      url: `/api/tasks/${taskId}/dependencies`,
      headers: { authorization: ownerAuth },
      payload: { depends_on_task_ids: [blockerId], policies: { [blockerId]: "review" } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().dependencies[0].policy).toBe("review");
    expect(put.json().unmet_dependency_ids).toContain(blockerId);

    db.prepare("UPDATE tasks SET agent_state = 'review' WHERE id = ?").run(blockerId);
    const after = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/dependencies`,
      headers: { authorization: ownerAuth },
    });
    expect(after.json().unmet_dependency_ids).toHaveLength(0);
  });

  it("policy completed игнорирует review предшественника и ждёт полного принятия", async () => {
    const blockerId = await createTask("предшественник completed");
    const taskId = await createTask("policy completed");
    await app.inject({
      method: "PUT",
      url: `/api/tasks/${taskId}/dependencies`,
      headers: { authorization: ownerAuth },
      payload: { depends_on_task_ids: [blockerId], policies: { [blockerId]: "completed" } },
    });

    db.prepare("UPDATE tasks SET agent_state = 'review' WHERE id = ?").run(blockerId);
    const stillBlocked = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/dependencies`,
      headers: { authorization: ownerAuth },
    });
    expect(stillBlocked.json().unmet_dependency_ids).toContain(blockerId);

    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(blockerId);
    const after = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/dependencies`,
      headers: { authorization: ownerAuth },
    });
    expect(after.json().unmet_dependency_ids).toHaveLength(0);
  });

  it("неизвестная policy отклоняется, блокировка допуска пишет audit-событие", async () => {
    const blockerId = await createTask("блокер для аудита");
    const taskId = await createTask("ждёт с аудитом");
    const badPolicy = await app.inject({
      method: "PUT",
      url: `/api/tasks/${taskId}/dependencies`,
      headers: { authorization: ownerAuth },
      payload: { depends_on_task_ids: [blockerId], policies: { [blockerId]: "нет-такой" } },
    });
    expect(badPolicy.statusCode).toBe(400);

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
    const events = db
      .prepare("SELECT to_value FROM task_events WHERE task_id = ? AND kind = 'dependency_context_blocked'")
      .all(taskId) as Array<{ to_value: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].to_value)).toContain(blockerId);
  });
});
