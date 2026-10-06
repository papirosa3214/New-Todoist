// Приватные проекты (задача 9d583c58…).
//
// Правило владельца: у проекта есть признак «приватный». Приватный проект и
// его задачи не отдаются через API никому, кроме владельца: ни агентам, ни
// оркестратору, ни поиску, ленте, чатам, уведомлениям и планам ролей. Новая
// задача, попавшая в приватный проект, автоматически назначается на
// владельца (u1) и не запускает агентов/планов.
//
// Здесь проверяется наблюдаемое поведение через HTTP (app.inject, одноразовая
// база — test/setup.ts), а не внутренности access.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Приватные проекты: скрытие от API, задачи на владельце", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentToken: string;
  let agentId: string;
  let orchToken: string;

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

  async function apiToken(jwt: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${jwt}` },
    });
    return res.json().api_token as string;
  }

  /** Создать проект от имени владельца, при желании — приватный. */
  async function createProject(
    token: string,
    name: string,
    isPrivate = false,
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
      payload: { name, is_private: isPrivate },
    });
    expect(res.statusCode).toBe(200);
    return res.json().id as string;
  }

  beforeAll(async () => {
    app = await buildApp();

    const owner = await makeUser("Владелец приватных", "owner@private.test", {
      role: "owner",
    });
    ownerId = owner.id;
    ownerToken = owner.jwt;

    const agent = await makeUser("Агент приватных", "agent@private.test", {
      type: "ai",
    });
    agentId = agent.id;
    agentToken = await apiToken(agent.jwt);

    const orch = await makeUser("Орк приватных", "orch@private.test", {
      role: "orchestrator",
    });
    orchToken = orch.jwt;
  });

  afterAll(async () => {
    await app.close();
  });

  it("приватный проект не виден агенту и оркестратору, владелец его видит", async () => {
    const priv = await createProject(ownerToken, "Секретный приватный", true);
    const open = await createProject(ownerToken, "Обычный открытый", false);

    const ownerList = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const ownerIds = ownerList.json().map((p: any) => p.id);
    expect(ownerIds).toContain(priv);
    expect(ownerIds).toContain(open);

    for (const token of [agentToken, orchToken]) {
      const list = await app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { authorization: `Bearer ${token}` },
      });
      const ids = list.json().map((p: any) => p.id);
      expect(ids).not.toContain(priv);
      expect(ids).toContain(open);
    }
  });

  it("приватный проект не отдаётся прямым запросом по id ни агенту, ни оркестратору", async () => {
    const priv = await createProject(ownerToken, "Секретный по id", true);

    // PATCH — единственная прямая дверь к проекту по id (GET одного проекта
    // в API нет). Для не-владельца она обязана отвечать 404, как на
    // несуществующий объект, — не подтверждая факт существования.
    for (const token of [agentToken, orchToken]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${priv}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "взлом" },
      });
      expect(res.statusCode).toBe(404);
    }

    const ownerPatch = await app.inject({
      method: "PATCH",
      url: `/api/projects/${priv}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "Переименовал владелец" },
    });
    expect(ownerPatch.statusCode).toBe(200);
  });

  it("задача в приватном проекте не видна агенту: ни списком, ни поиском, ни по id", async () => {
    const priv = await createProject(ownerToken, "Секретный с задачей", true);
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Секретноедельце", project_id: priv },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id;

    // Список задач у агента не содержит приватную.
    const list = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(list.json().map((t: any) => t.id)).not.toContain(taskId);

    // Карточка по id — 404.
    const card = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(card.statusCode).toBe(404);

    // Поиск по названию — пусто.
    const search = await app.inject({
      method: "GET",
      url: "/api/search?q=Секретноедельце",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(search.json().tasks.length).toBe(0);

    // Владелец видит и задачу, и проект.
    const ownerCard = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerCard.statusCode).toBe(200);

    const ownerSearch = await app.inject({
      method: "GET",
      url: "/api/search?q=Секретноедельце",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerSearch.json().tasks.length).toBeGreaterThan(0);
  });

  it("создание задачи в приватном проекте даёт assignee_id = владелец без запуска", async () => {
    const priv = await createProject(ownerToken, "Приватный для назначения", true);

    // Без исполнителя — владелец проставляется автоматически.
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Автоназначение", project_id: priv },
    });
    expect(created.statusCode).toBe(200);
    const task = created.json().task;
    expect(task.assignee_id).toBe(ownerId);
    expect(task.project_id).toBe(priv);
    // Запуска нет: задача не поднята для подхвата и не отдана агенту.
    expect(task.ready_for_pickup).not.toBe(1);
    expect(task.agent_state ?? null).toBeNull();

    // В inbox агентов поручения по этой задаче нет.
    const inbox = db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_inbox WHERE task_id = ? AND event_type = 'assignment'",
      )
      .get(task.id) as { n: number };
    expect(inbox.n).toBe(0);
  });

  it("агент не может создать задачу в приватном проекте и включить приватность", async () => {
    const priv = await createProject(ownerToken, "Приватный для агента", true);

    const asAgent = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { title: "Агент лезет в приватный", project_id: priv },
    });
    expect(asAgent.statusCode).toBe(400);

    // Сделать приватным существующий проект агент не вправе.
    const open = await createProject(ownerToken, "Открытый для агента", false);
    const patchPrivate = await app.inject({
      method: "PATCH",
      url: `/api/projects/${open}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { is_private: true },
    });
    expect(patchPrivate.statusCode).toBe(404);

    // И сразу приватный проект на создании агент тоже не заведёт.
    const createPriv = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { name: "Агентский приватный", is_private: true },
    });
    expect(createPriv.statusCode).toBe(403);
  });

  it("включение приватности переназначает задачи проекта на владельца", async () => {
    const proj = await createProject(ownerToken, "Станет приватным", false);

    // Задача, назначенная агенту, до включения приватности.
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "На агенте", project_id: proj, assignee_id: agentId },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id;
    expect(created.json().task.assignee_id).toBe(agentId);

    // Владелец включает приватность.
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/projects/${proj}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { is_private: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().is_private).toBe(1);

    // Задача переназначена на владельца.
    const row = db
      .prepare("SELECT assignee_id, project_id FROM tasks WHERE id = ?")
      .get(taskId) as { assignee_id: string; project_id: string };
    expect(row.assignee_id).toBe(ownerId);

    // И агент её больше не видит.
    const card = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(card.statusCode).toBe(404);
  });

  it("чат приватного проекта не виден агенту, даже если он в участниках", async () => {
    const priv = await createProject(ownerToken, "Приватный с чатом", true);
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Тема чата", project_id: priv },
    });
    const taskId = created.json().task.id;

    // Владелец заводит групповой чат проекта и тему задачи.
    const group = await app.inject({
      method: "POST",
      url: `/api/projects/${priv}/chat`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(group.statusCode).toBe(200);
    const groupChatId = group.json().chat.id;

    const topic = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/topic`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(topic.statusCode).toBe(200);
    const topicChatId = topic.json().chat.id;

    // Агента принудительно добавляем в оба чата — так проверяем именно
    // скрытие по приватности, а не отсутствие членства.
    db.prepare(
      "INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?,?)",
    ).run(groupChatId, agentId);
    db.prepare(
      "INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?,?)",
    ).run(topicChatId, agentId);

    const list = await app.inject({
      method: "GET",
      url: "/api/chats",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    const ids = list.json().chats.map((c: any) => c.id);
    expect(ids).not.toContain(groupChatId);
    expect(ids).not.toContain(topicChatId);

    // Прямое открытие — 404.
    const direct = await app.inject({
      method: "GET",
      url: `/api/chats/${topicChatId}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(direct.statusCode).toBe(404);

    // Владелец видит оба чата.
    const ownerList = await app.inject({
      method: "GET",
      url: "/api/chats",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const ownerIds = ownerList.json().chats.map((c: any) => c.id);
    expect(ownerIds).toContain(groupChatId);
    expect(ownerIds).toContain(topicChatId);
  });

  it("уведомление со ссылкой на задачу приватного проекта не отдаётся агенту", async () => {
    const priv = await createProject(ownerToken, "Приватный с уведомлением", true);
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Секретное уведомление", project_id: priv },
    });
    const taskId = created.json().task.id;

    // Напрямую кладём агенту уведомление о приватной задаче — так проверяем
    // именно фильтр отдачи, а не отсутствие генерации.
    db.prepare(
      "INSERT INTO notifications (id, user_id, type, task_id, text) VALUES (?,?,?,?,?)",
    ).run("nt-priv-" + taskId, agentId, "assigned", taskId, "test");

    const list = await app.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(list.json().map((n: any) => n.id)).not.toContain("nt-priv-" + taskId);
  });
});
