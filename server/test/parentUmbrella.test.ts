// Родитель — зонтик над дочерними задачами (10.09.2026, задача a195895d).
// Своей работы у него нет: он ждёт, пока закроются дети. Закрылась
// последняя — родитель сам уходит на приёмку к владельцу.
//
// Замысел владельца дословно: «как только все дочерние поставили галочки —
// что приходит на родителя? Ревью сразу же. А не какие-то ещё эфемерные
// шаги».
//
// Именно review, а не completed: закрывает задачу только владелец
// (решение 08.09.2026, closeOnlyOwner.test.ts). Автомат доводит работу до
// его стола, но не принимает её за него.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("Родитель-зонтик: последняя дочерняя закрыта — родитель на приёмку", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();

    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OwnerUmbrella",
        email: "owner@umbrella.test",
        password: "password123",
      },
    });
    ownerToken = ownerReg.json().token;
    ownerId = ownerReg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeTask(title: string, parentId?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: parentId ? { title, parent_id: parentId } : { title },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().task.id as string;
    markReadyForPickup(id);
    return id;
  }

  async function close(taskId: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "completed" },
    });
  }

  function stateOf(taskId: string) {
    return db
      .prepare("SELECT status, agent_state FROM tasks WHERE id = ?")
      .get(taskId) as { status: string; agent_state: string | null };
  }

  it("пока закрыт не последний ребёнок — родитель не трогается", async () => {
    const parent = await makeTask("Зонтик: два ребёнка");
    const first = await makeTask("Ребёнок 1", parent);
    await makeTask("Ребёнок 2", parent);

    expect((await close(first)).statusCode).toBe(200);

    const p = stateOf(parent);
    expect(p.status).toBe("active");
    expect(p.agent_state).toBeNull();
  });

  it("закрылась последняя дочерняя — родитель уходит в review, но НЕ закрывается", async () => {
    const parent = await makeTask("Зонтик: все дети закроются");
    const first = await makeTask("Ребёнок A", parent);
    const second = await makeTask("Ребёнок B", parent);

    await close(first);
    await close(second);

    const p = stateOf(parent);
    expect(p.agent_state).toBe("review");
    // Приёмка остаётся за владельцем: сам себя родитель не закрывает.
    expect(p.status).toBe("active");
  });

  it("у родителя свой невыполненный пункт — закрытие дочерних его на приёмку не шлёт", async () => {
    // Владелец 22.09.2026: работа родителя ещё не сделана — на проверку
    // рано. Пункт заводим прямо в базе: через API родителю с детьми шаги
    // не заводятся, а секретарь кладёт их при постановке.
    const parent = await makeTask("Зонтик со своим пунктом");
    const first = await makeTask("Ребёнок C", parent);
    const second = await makeTask("Ребёнок D", parent);
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, 1)",
    ).run(`own-step-${Date.now()}`, parent, "Свой пункт родителя");

    await close(first);
    await close(second);

    const p = stateOf(parent);
    expect(p.status).toBe("active");
    expect(p.agent_state).toBeNull();
  });

  it("в ленте родителя остаётся след — почему он оказался на приёмке", async () => {
    const parent = await makeTask("Зонтик: след в ленте");
    const only = await makeTask("Единственный ребёнок", parent);
    await close(only);

    const comment = db
      .prepare(
        "SELECT text FROM comments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(parent) as { text: string } | undefined;
    expect(comment?.text).toContain("дочерние задачи закрыты");
  });

  it("задача без детей ведёт себя ровно как раньше", async () => {
    const lonely = await makeTask("Одиночка без детей");
    expect((await close(lonely)).statusCode).toBe(200);

    const t = stateOf(lonely);
    expect(t.status).toBe("completed");
    expect(t.agent_state).toBeNull();
  });

  it("повторное закрытие уже закрытого ребёнка не поднимает родителя обратно", async () => {
    const parent = await makeTask("Зонтик: повтор не будит");
    const child = await makeTask("Единственный ребёнок 2", parent);
    await close(child);

    // Сначала владелец одобряет актуальную версию результата родителя.
    const versions = await app.inject({
      method: "GET",
      url: `/api/tasks/${parent}/versions`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const version = versions.json().versions[0];
    const review = await app.inject({
      method: "POST",
      url: "/api/reviews",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        task_id: parent,
        version_id: version.id,
        artifact_hash: version.artifact_hash,
        criteria_version: "taskflow/review-v1",
        task_revision: version.task_revision,
        verdict: "approved",
      },
    });
    expect(review.statusCode).toBe(201);

    // Владелец принял родителя — карточка ушла с доски.
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${parent}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "completed" },
    });
    expect(stateOf(parent).status).toBe("completed");

    // Повторный PATCH по ребёнку с тем же статусом ничего не меняет.
    await close(child);
    expect(stateOf(parent).status).toBe("completed");
  });
});

// Тот же принцип уровнем ниже: закрыт последний ШАГ обычной карточки —
// она сама уходит на приёмку. До 10.09.2026 это было ручным действием
// агента и держалось на его дисциплине.
describe("Плоская карточка: закрыт последний шаг — сама на приёмку", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    app = await buildApp();

    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OwnerFlat",
        email: "owner@flat-review.test",
        password: "password123",
      },
    });
    ownerToken = ownerReg.json().token;
    ownerId = ownerReg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "AgentFlat",
        email: "agent@flat-review.test",
        password: "password123",
      },
    });
    agentToken = agentReg.json().token;
    agentId = agentReg.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Задача с двумя шагами, взятая агентом в работу. */
  async function taskWithSteps(title: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title, assignee_id: agentId },
    });
    const taskId = created.json().task.id as string;
    markReadyForPickup(taskId);
    const stepIds: string[] = [];
    for (const step of ["Шаг один", "Шаг два"]) {
      const s = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/subtasks`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { title: step },
      });
      stepIds.push(s.json().id);
    }
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    return { taskId, stepIds };
  }

  // Шаг закрывается ТОЛЬКО из работы (правило сервера от 10.09.2026), а
  // закрытие предыдущего шага гасит аренду на самой задаче — поэтому перед
  // каждым шагом задача берётся заново. Это ровно тот путь, которым идёт живой
  // агент: claim → отметил шаг → закрыл.
  async function closeStep(taskId: string, id: string) {
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    const work = await app.inject({
      method: "POST",
      url: `/api/subtasks/${id}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "in_progress" },
    });
    expect(work.statusCode).toBe(200);
    return app.inject({
      method: "PATCH",
      url: `/api/subtasks/${id}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { done: true, result: "сделано" },
    });
  }

  it("не последний шаг закрыт — задача остаётся в работе", async () => {
    const { taskId, stepIds } = await taskWithSteps("Плоская: один из двух");
    await closeStep(taskId, stepIds[0]);

    const t = db
      .prepare("SELECT agent_state FROM tasks WHERE id = ?")
      .get(taskId) as { agent_state: string | null };
    expect(t.agent_state).toBe("in_progress");
  });

  it("закрыт последний шаг — задача сама в review", async () => {
    const { taskId, stepIds } = await taskWithSteps("Плоская: оба шага");
    await closeStep(taskId, stepIds[0]);
    await closeStep(taskId, stepIds[1]);

    const t = db
      .prepare("SELECT status, agent_state FROM tasks WHERE id = ?")
      .get(taskId) as { status: string; agent_state: string | null };
    expect(t.agent_state).toBe("review");
    // Закрывает по-прежнему владелец.
    expect(t.status).toBe("active");
  });

  it("задачу человека без агента автопереход не трогает", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Личная задача владельца" },
    });
    const taskId = created.json().task.id as string;
    markReadyForPickup(taskId);
    const s = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Единственный пункт" },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${s.json().id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { done: true },
    });

    const t = db
      .prepare("SELECT agent_state FROM tasks WHERE id = ?")
      .get(taskId) as { agent_state: string | null };
    expect(t.agent_state).toBeNull();
  });
});

// Прогресс родителя в списке считается по детям — а для этого список
// обязан их отдавать. До 10.09.2026 дети в ответе /api/tasks не приходили
// вовсе, хотя на сервере уже вычислялись.
describe("Список задач отдаёт детей — иначе прогресс родителя не посчитать", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OwnerChildren",
        email: "owner@children-list.test",
        password: "password123",
      },
    });
    ownerToken = reg.json().token;
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    await app.close();
  });

  it("родитель приходит со списком детей и их статусами", async () => {
    const parentRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Родитель для списка" },
    });
    const parentId = parentRes.json().task.id as string;
    markReadyForPickup(parentId);

    for (const title of ["Дитя 1", "Дитя 2"]) {
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { title, parent_id: parentId },
      });
    }

    const list = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const parent = list.json().find((t: any) => t.id === parentId) as {
      children_total?: number;
      children_done?: number;
      children?: unknown;
    };

    expect(parent).toBeDefined();
    expect(parent.children_total).toBe(2);
    expect(parent.children_done).toBe(0);
    // Массив детей в СПИСКЕ не отдаём вовсе: обрезанный объект под именем
    // `children` кладёт разбор ответа в нативном клиенте (10.09.2026).
    expect(parent.children).toBeUndefined();
  });
});

// Два списка одного разбиения не держим: у задачи с детьми своих шагов
// быть не должно (10.09.2026, a195895d).
describe("Задаче с детьми шаги не заводятся", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OwnerNoSteps",
        email: "owner@no-steps.test",
        password: "password123",
      },
    });
    ownerToken = reg.json().token;
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeTask(title: string, parentId?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: parentId ? { title, parent_id: parentId } : { title },
    });
    const id = res.json().task.id as string;
    markReadyForPickup(id);
    return id;
  }

  it("есть ребёнок — добавить шаг нельзя, ответ объясняет почему", async () => {
    const parent = await makeTask("Родитель без шагов");
    await makeTask("Его ребёнок", parent);

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${parent}/subtasks`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Лишний шаг" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("дочерние");
  });

  it("детей нет — шаг заводится как раньше", async () => {
    const plain = await makeTask("Обычная задача");
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${plain}/subtasks`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Обычный шаг" },
    });
    expect(res.statusCode).toBe(200);
  });
});
