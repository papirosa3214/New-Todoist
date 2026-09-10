// Права доступа по роли — задача babbfc82, формулировка владельца:
// «человек-владелец видит всё и вся и может залезать куда угодно; агенты
// тоже видят всё, но не лезут в задачи, которые им не назначили».
//
// Правило живёт в src/access.ts; здесь проверяется его наблюдаемое
// поведение через HTTP (app.inject, одноразовая база — test/setup.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("Доступ по роли: владелец, агенты, посторонний", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentAToken: string;
  let agentAId: string;
  let agentBToken: string;
  let strangerToken: string;

  /** Учётка через регистрацию + при необходимости роль/тип прямым UPDATE. */
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
    // Регистрация намеренно не умеет выдавать role='owner'/type='ai'
    // (auth.ts) — как и у системных ботов, это ставится только в базе.
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

  beforeAll(async () => {
    app = await buildApp();

    const owner = await makeUser("Владелец", "owner@access.test", {
      role: "owner",
    });
    ownerId = owner.id;
    ownerToken = owner.jwt;

    const agentA = await makeUser("Агент А", "agent-a@access.test", {
      type: "ai",
    });
    agentAId = agentA.id;
    agentAToken = await apiToken(agentA.jwt);

    const agentB = await makeUser("Агент Б", "agent-b@access.test", {
      type: "ai",
    });
    agentBToken = await apiToken(agentB.jwt);

    const stranger = await makeUser("Посторонний", "stranger@access.test");
    strangerToken = stranger.jwt;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Ровно тот случай, который сломался живьём: у задачи нет ни проекта,
   * ни исполнителя — только создатель-агент. */
  async function agentCreatesLooseTask(title: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${agentAToken}` },
      payload: { title },
    });
    expect(res.statusCode).toBe(200);
    const task = res.json().task;
    expect(task.project_id).toBeFalsy();
    expect(task.assignee_id).toBeFalsy();
    return task.id as string;
  }

  it("владелец видит задачу агента без проекта и без исполнителя", async () => {
    const id = await agentCreatesLooseTask("Задача агента без проекта");

    const list = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((t: any) => t.id)).toContain(id);

    const card = await app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(card.statusCode).toBe(200);
  });

  it("владелец правит и удаляет чужую задачу", async () => {
    const id = await agentCreatesLooseTask("Задача агента на правку");

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Переименовал владелец" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().task.title).toBe("Переименовал владелец");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(del.statusCode).toBe(200);
  });

  it("владелец находит задачу агента поиском", async () => {
    await agentCreatesLooseTask("Ключевоеслово агента");
    const res = await app.inject({
      method: "GET",
      url: "/api/search?q=Ключевоеслово",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tasks.length).toBeGreaterThan(0);
  });

  it("агент видит чужую задачу, но править её не может", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Задача для агента А", assignee_id: agentAId },
    });
    const id = created.json().task.id;

    const seen = await app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${agentBToken}` },
    });
    expect(seen.statusCode).toBe(200);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${agentBToken}` },
      payload: { title: "Влез в чужую" },
    });
    expect(patch.statusCode).toBe(404);

    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/claim`,
      headers: { authorization: `Bearer ${agentBToken}` },
    });
    expect(claim.statusCode).toBe(403);
  });

  it("агент работает со своей задачей как раньше", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Своя задача агента А", assignee_id: agentAId },
    });
    const id = created.json().task.id;
    // Задача здесь создаётся напрямую, минуя фабрику ownerTaskForAgent, —
    // флаг готовности приходится поднимать отдельно.
    markReadyForPickup(id);

    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/claim`,
      headers: { authorization: `Bearer ${agentAToken}` },
    });
    expect(claim.statusCode).toBe(200);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${agentAToken}` },
      payload: { description: "ход работы" },
    });
    expect(patch.statusCode).toBe(200);
  });

  // 08.09.2026 (задача b6b57092) закрыть/вернуть задачу может только роль
  // owner — ни исполнитель, ни оркестратор. Агент сдаёт через review.
  // Исполнитель, закрывший сам, убрал бы с доски работу, которую владелец
  // не видел, — сервер это режет. Подробный набор — closeOnlyOwner.test.ts.
  it("агент не может закрыть назначенную ему задачу сам", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Закрытие агентом", assignee_id: agentAId },
    });
    const id = created.json().task.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${agentAToken}` },
      payload: { status: "completed" },
    });
    expect(res.statusCode).toBe(403);
  });

  /** Регистрация на :5180 открыта, поэтому «видно всё» не должно
   * распространяться на человека, который завёл себе учётку сам. */
  it("посторонний человек чужих задач не видит", async () => {
    const id = await agentCreatesLooseTask("Не для постороннего");

    const list = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(list.json().map((t: any) => t.id)).not.toContain(id);

    const card = await app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(card.statusCode).toBe(404);

    const search = await app.inject({
      method: "GET",
      url: "/api/search?q=Не для постороннего",
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(search.json().tasks.length).toBe(0);
  });

  it("агенту не видны справочники постороннего человека", async () => {
    const label = await app.inject({
      method: "POST",
      url: "/api/labels",
      headers: { authorization: `Bearer ${strangerToken}` },
      payload: { name: "Метка постороннего" },
    });
    const strangerLabelId = label.json().id;

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${strangerToken}` },
      payload: { name: "Проект постороннего для агента" },
    });
    const strangerProjectId = project.json().id;

    const labels = await app.inject({
      method: "GET",
      url: "/api/labels",
      headers: { authorization: `Bearer ${agentAToken}` },
    });
    expect(labels.json().map((l: any) => l.id)).not.toContain(strangerLabelId);

    const projects = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${agentAToken}` },
    });
    expect(projects.json().map((p: any) => p.id)).not.toContain(
      strangerProjectId,
    );

    // И пометить свою задачу чужой меткой агент тоже не может.
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${agentAToken}` },
      payload: { title: "С чужой меткой", label_ids: [strangerLabelId] },
    });
    expect(task.statusCode).toBe(400);
  });

  // 20.08.2026: до этого агент мог подшить задачу только в проект того, кому
  // она адресована, — а свои задачи он назначает на себя. Работало это лишь
  // потому, что агент ходил в трекер учёткой владельца через вход без пароля;
  // дверь закрыли — и «задача агента обязана лежать в проекте» стало
  // невыполнимо. Проект чужого человека при этом по-прежнему недоступен.
  it("агент кладёт свою задачу в проект владельца, но не в проект постороннего", async () => {
    const ownerProject = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "Домашний сервер" },
    });
    const strangerProject = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${strangerToken}` },
      payload: { name: "Проект постороннего для подшивки" },
    });

    const mine = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${agentAToken}` },
      payload: {
        title: "Задача агента в проекте владельца",
        project_id: ownerProject.json().id,
        assignee_id: agentAId,
      },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().task.project_id).toBe(ownerProject.json().id);

    const alien = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${agentAToken}` },
      payload: {
        title: "Задача агента в чужом проекте",
        project_id: strangerProject.json().id,
        assignee_id: agentAId,
      },
    });
    expect(alien.statusCode).toBe(400);
  });

  it("владельцу видны проекты и метки, посторонний своих не теряет", async () => {
    const ownerProject = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "Проект владельца" },
    });
    expect(ownerProject.statusCode).toBe(200);

    const strangerProject = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${strangerToken}` },
      payload: { name: "Проект постороннего" },
    });
    const strangerProjectId = strangerProject.json().id;

    const ownerList = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerList.json().map((p: any) => p.id)).toContain(strangerProjectId);

    const strangerList = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    const strangerIds = strangerList.json().map((p: any) => p.id);
    expect(strangerIds).toContain(strangerProjectId);
    expect(strangerIds).not.toContain(ownerProject.json().id);
    expect(ownerId).toBeTruthy();
  });
});

// Роль оркестратора — задача af2107b2, формулировка владельца: «полные
// права на управление проектами и задачами ботов… право на удаление
// объектов должно быть запрещено».
describe("Оркестратор: правит всё, не удаляет ничего", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let orchToken: string;
  let agentToken: string;
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

  async function apiToken(jwt: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: { authorization: `Bearer ${jwt}` },
    });
    return res.json().api_token as string;
  }

  /** Задача владельца, назначенная рядовому боту, — типичный предмет работы. */
  async function ownerTaskForAgent(title: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title, assignee_id: agentId },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().task.id as string;
    markReadyForPickup(id);
    return id;
  }

  beforeAll(async () => {
    app = await buildApp();

    const owner = await makeUser("Владелец", "owner@orch.test", {
      role: "owner",
    });
    ownerId = owner.id;
    ownerToken = owner.jwt;

    // Оркестратор — учётка ИИ с собственной ролью, ходит api-токеном.
    const orch = await makeUser("Оркестратор", "orch@orch.test", {
      role: "orchestrator",
      type: "ai",
    });
    orchToken = await apiToken(orch.jwt);

    const agent = await makeUser("Рядовой бот", "worker@orch.test", {
      type: "ai",
    });
    agentId = agent.id;
    agentToken = await apiToken(agent.jwt);
  });

  afterAll(async () => {
    await app.close();
  });

  it("роль orchestrator принимается схемой", () => {
    const row = db
      .prepare("SELECT role FROM users WHERE email = ?")
      .get("orch@orch.test") as { role?: string };
    expect(row?.role).toBe("orchestrator");
  });

  it("правит чужую задачу и переназначает исполнителя", async () => {
    const id = await ownerTaskForAgent("Задача бота");

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${orchToken}` },
      payload: { title: "Переставил оркестратор", assignee_id: ownerId },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().task.title).toBe("Переставил оркестратор");
    expect(patch.json().task.assignee_id).toBe(ownerId);
  });

  it("заводит шаг в чужой задаче", async () => {
    const id = await ownerTaskForAgent("Задача под разбор на шаги");

    const sub = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/subtasks`,
      headers: { authorization: `Bearer ${orchToken}` },
      payload: { title: "Шаг от оркестратора" },
    });
    expect(sub.statusCode).toBe(200);
    expect(sub.json().title).toBe("Шаг от оркестратора");
  });

  it("создаёт проект и задачу, кладёт задачу в чужой проект", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "Проект владельца под оркестровку" },
    });
    const projectId = project.json().id;

    const own = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${orchToken}` },
      payload: { name: "Проект от оркестратора" },
    });
    expect(own.statusCode).toBe(200);

    const filed = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${orchToken}` },
      payload: {
        title: "Задача боту в проект владельца",
        project_id: projectId,
        assignee_id: agentId,
      },
    });
    expect(filed.statusCode).toBe(200);
    expect(filed.json().task.project_id).toBe(projectId);
  });

  it("правит чужой проект", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "Проект на переименование" },
    });

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.json().id}`,
      headers: { authorization: `Bearer ${orchToken}` },
      payload: { name: "Переименовал оркестратор" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().name).toBe("Переименовал оркестратор");
  });

  it("не удаляет ничего: ни задачу, ни свой проект, ни шаг, ни метку", async () => {
    const taskId = await ownerTaskForAgent("Задача, которую не удалить");

    const step = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${orchToken}` },
      payload: { title: "Шаг, который не удалить" },
    });
    const stepId = step.json().id;

    // Проект и метка заведены САМИМ оркестратором — то есть отказ не про
    // «чужое», а именно про действие: своё он тоже не удаляет.
    const ownProject = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${orchToken}` },
      payload: { name: "Свой проект оркестратора" },
    });
    const ownLabel = await app.inject({
      method: "POST",
      url: "/api/labels",
      headers: { authorization: `Bearer ${orchToken}` },
      payload: { name: "Своя метка оркестратора" },
    });

    for (const url of [
      `/api/tasks/${taskId}`,
      `/api/subtasks/${stepId}`,
      `/api/projects/${ownProject.json().id}`,
      `/api/labels/${ownLabel.json().id}`,
    ]) {
      const del = await app.inject({
        method: "DELETE",
        url,
        headers: { authorization: `Bearer ${orchToken}` },
      });
      expect(del.statusCode, `DELETE ${url}`).toBe(403);
      expect(del.json().error).toMatch(/не удаляет/);
    }

    // Объекты на месте: отказ отказом, а данные целы.
    const stillThere = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(stillThere.statusCode).toBe(200);
  });

  it("прежние права не изменились: рядовой бот в чужое не лезет и удаляет своё", async () => {
    const alien = await ownerTaskForAgent("Задача другому исполнителю");
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${alien}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { assignee_id: ownerId },
    });

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${alien}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { title: "Влез в чужую" },
    });
    expect(patch.statusCode).toBe(404);

    const own = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { title: "Своя задача бота" },
    });
    const del = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${own.json().task.id}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(del.statusCode).toBe(200);
  });
});
