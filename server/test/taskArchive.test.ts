// server/test/taskArchive.test.ts
//
// Архив задач вместо удаления (карточка 57c69735…). Содержательные сценарии:
// права на archive/restore/purge, атомарность дерева, чистка активной
// работы и исключение из очередей, фильтрация в обычных списках, события
// и формат ответа. Поведенческий контракт — единый для сервера, веба и
// iOS; проверки идут через API (app.inject), а не прямой SQL, чтобы одно
// и то же регрессировало вместе.
//
// Прогон живого серверного маршрута изнутри Vitest через buildApp() +
// одноразовую in-memory БД (test/setup.ts). HTTP-200 и сборка отдельно
// не доказывают поведение — здесь проверяются пути, защита по правам
// и сайд-эффекты.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

type Reg = { id: string; jwt: string };

async function makeUser(
  app: FastifyInstance,
  name: string,
  email: string,
  patch?: { role?: string; type?: string },
): Promise<Reg> {
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name, email, password: "password123" },
  });
  expect(reg.statusCode).toBe(200);
  const body = reg.json() as { user: { id: string }; token: string };
  if (patch?.role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(patch.role, body.user.id);
  if (patch?.type) db.prepare("UPDATE users SET type = ? WHERE id = ?").run(patch.type, body.user.id);
  return { id: body.user.id, jwt: body.token };
}

function bearer(jwt: string) {
  return { authorization: `Bearer ${jwt}` };
}

describe("Архив задач вместо удаления (карточка 57c69735…)", () => {
  let app: FastifyInstance;
  let owner: Reg;
  let stranger: Reg;
  let agentA: Reg;
  let agentB: Reg;

  beforeAll(async () => {
    app = await buildApp();
    owner = await makeUser(app, "Владелец", "owner@archive.test", { role: "owner" });
    stranger = await makeUser(app, "Чужой", "stranger@archive.test");
    agentA = await makeUser(app, "Агент А", "agent-a@archive.test", { type: "ai" });
    agentB = await makeUser(app, "Агент Б", "agent-b@archive.test", { type: "ai" });
  });

  afterAll(async () => {
    await app.close();
  });

  /** Создать простой проект под владельцем. */
  async function makeProject(title: string) {
    const r = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: bearer(owner.jwt),
      payload: { name: title, color: "#FF7A8A" },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as { id: string }).id;
  }

  /** Создать задачу от лица владельца (имитирует пользовательское API). */
  async function makeTask(projectId: string | null, title: string, opts: { assigneeId?: string | null } = {}) {
    const r = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: bearer(owner.jwt),
      payload: {
        title,
        project_id: projectId,
        assignee_id: opts.assigneeId ?? null,
      },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as { task: { id: string } }).task.id;
  }

  it("DELETE на живой карточке архивирует, а не удаляет — данные остаются", async () => {
    const projectId = await makeProject("P-1");
    const taskId = await makeTask(projectId, "Исходная задача");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${taskId}`,
      headers: bearer(owner.jwt),
    });
    expect(del.statusCode).toBe(200);
    const body = del.json() as { task: { id: string; archived_at: string | null } };
    expect(body.task.id).toBe(taskId);
    expect(body.task.archived_at).toBeTruthy();

    // Карточка в БД осталась, archived_at стоит.
    const row = db.prepare("SELECT archived_at FROM tasks WHERE id = ?").get(taskId) as
      | { archived_at: string | null } | undefined;
    expect(row).toBeTruthy();
    expect(row?.archived_at).toBeTruthy();
  });

  it("POST /archive идемпотентен — повторный вызов возвращает ту же карточку", async () => {
    const taskId = await makeTask(null, "Для идемпотентности");
    const first = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: bearer(owner.jwt),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { task: { id: string; archived_at: string } };
    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: bearer(owner.jwt),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { task: { id: string; archived_at: string } };
    expect(secondBody.task.archived_at).toBe(firstBody.task.archived_at);
  });

  it("архивную чужую карточку посторонний и агент не читают (404)", async () => {
    const projectId = await makeProject("P-чужая");
    const taskId = await makeTask(projectId, "Только для владельца");
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: bearer(owner.jwt),
    });

    const fromStranger = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: bearer(stranger.jwt),
    });
    expect(fromStranger.statusCode).toBe(404);

    const fromAgent = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: bearer(agentA.jwt),
    });
    expect(fromAgent.statusCode).toBe(404);

    const fromOwner = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: bearer(owner.jwt),
    });
    expect(fromOwner.statusCode).toBe(200);
  });

  it("архивные не попадают в обычный GET /api/tasks", async () => {
    const aliveId = await makeTask(null, "Живая");
    const archivedId = await makeTask(null, "Архивная");
    await app.inject({
      method: "POST",
      url: `/api/tasks/${archivedId}/archive`,
      headers: bearer(owner.jwt),
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: bearer(owner.jwt),
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain(aliveId);
    expect(ids).not.toContain(archivedId);
  });

  it("GET /api/tasks?archived=true отдаёт только архивные и только владельцу", async () => {
    const a = await makeTask(null, "В архив A");
    const b = await makeTask(null, "В архив B");
    await app.inject({ method: "POST", url: `/api/tasks/${a}/archive`, headers: bearer(owner.jwt) });
    await app.inject({ method: "POST", url: `/api/tasks/${b}/archive`, headers: bearer(owner.jwt) });

    const listOwner = await app.inject({
      method: "GET",
      url: "/api/tasks?archived=true",
      headers: bearer(owner.jwt),
    });
    expect(listOwner.statusCode).toBe(200);
    const items = listOwner.json() as Array<{ id: string; archived_at: string }>;
    const ids = items.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([a, b]));
    for (const it of items) expect(it.archived_at).toBeTruthy();

    const listStranger = await app.inject({
      method: "GET",
      url: "/api/tasks?archived=true",
      headers: bearer(stranger.jwt),
    });
    expect(listStranger.statusCode).toBe(403);

    const listAgent = await app.inject({
      method: "GET",
      url: "/api/tasks?archived=true",
      headers: bearer(agentA.jwt),
    });
    expect(listAgent.statusCode).toBe(403);
  });

  it("POST /restore возвращает живой статус и пишет событие в task_events", async () => {
    const taskId = await makeTask(null, "Под восстановление");
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/archive`, headers: bearer(owner.jwt) });
    const restore = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/restore`,
      headers: bearer(owner.jwt),
    });
    expect(restore.statusCode).toBe(200);
    const body = restore.json() as { task: { id: string; archived_at: string | null } };
    expect(body.task.archived_at).toBeNull();

    const ev = db
      .prepare(
        "SELECT kind FROM task_events WHERE task_id = ? AND kind = 'task:restored'",
      )
      .get(taskId) as { kind: string } | undefined;
    expect(ev?.kind).toBe("task:restored");
  });

  it("restore на живой карточке → 409 not_archived", async () => {
    const taskId = await makeTask(null, "Нечего восстанавливать");
    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/restore`,
      headers: bearer(owner.jwt),
    });
    expect(r.statusCode).toBe(409);
  });

  it("restore карточки архивного проекта → 409 project_archived", async () => {
    const projectId = await makeProject("P-в-архиве");
    const taskId = await makeTask(projectId, "Из архивного проекта");
    // Сначала архивируем проект.
    const archProj = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      headers: bearer(owner.jwt),
    });
    expect(archProj.statusCode).toBe(200);
    // Затем карточку.
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: bearer(owner.jwt),
    });
    // restore должен отказать: пока проект архивный, восстанавливать задачу нельзя.
    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/restore`,
      headers: bearer(owner.jwt),
    });
    expect(r.statusCode).toBe(409);
    expect(JSON.stringify(r.json())).toContain("project_archived");
  });

  it("DELETE живую карточку — только создатель или владелец; чужой → 404", async () => {
    const projectId = await makeProject("P-доступ");
    const taskId = await makeTask(projectId, "Чужая карточка", { assigneeId: stranger.id });

    const fromCreator = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${taskId}`,
      headers: bearer(owner.jwt),
    });
    expect(fromCreator.statusCode).toBe(200);

    // Stranger не создатель — попытка архивировать чужую возвращает 404.
    const otherTask = await makeTask(null, "Чужая задача");
    const fromStranger = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${otherTask}`,
      headers: bearer(stranger.jwt),
    });
    expect(fromStranger.statusCode).toBe(404);
  });

  it("DELETE архивной карточки — только владелец; посторонний → 403", async () => {
    const taskId = await makeTask(null, "К удалению");
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: bearer(owner.jwt),
    });

    const fromOwner = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${taskId}`,
      headers: bearer(owner.jwt),
    });
    expect(fromOwner.statusCode).toBe(200);

    // Удаление уже вычищено — вторая попытка не должна вернуть 200.
    const second = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${taskId}`,
      headers: bearer(owner.jwt),
    });
    expect(second.statusCode).toBe(404);

    // Новая архивная карточка: попытка purge'а от постороннего → 403.
    const task2 = await makeTask(null, "Архивная #2");
    await app.inject({
      method: "POST",
      url: `/api/tasks/${task2}/archive`,
      headers: bearer(owner.jwt),
    });
    const fromStranger = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${task2}`,
      headers: bearer(stranger.jwt),
    });
    expect(fromStranger.statusCode).toBe(403);

    const fromAgent = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${task2}`,
      headers: bearer(agentA.jwt),
    });
    expect(fromAgent.statusCode).toBe(403);
  });

  it("DELETE архивной карточки с дочерними → 409 has_children (политика B: дети ушли в архив вместе с родителем)", async () => {
    const parentId = await makeTask(null, "Родитель");
    // Создаём дочернюю через прямой INSERT (API создания дочерних в текущей
    // реализации устроено через parent_id уже существующих; здесь используем
    // прямой путь — на контракт это не влияет).
    db.prepare("INSERT INTO tasks(id, title, parent_id) VALUES (?, ?, ?)").run("kid-1", "Ребёнок", parentId);

    await app.inject({
      method: "POST",
      url: `/api/tasks/${parentId}/archive`,
      headers: bearer(owner.jwt),
    });

    // Политика B: дочерняя тоже ушла в архив вместе с родителем. Purge
    // корня невозможен, пока существуют дочерние записи (даже архивные) —
    // сначала нужно явно разобраться с ними. Это явное требование §3.2
    // контракта: «сначала разберитесь с ними».
    const fail = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${parentId}`,
      headers: bearer(owner.jwt),
    });
    expect(fail.statusCode).toBe(409);
    const failBody = fail.json() as { error?: string; child_count?: number };
    expect(failBody.error).toContain("дочерние");
    expect(failBody.child_count).toBe(1);

    // Чтобы пройти purge: сначала restore (дети тоже живыми), затем
    // архивируем и purge'им ребёнка отдельно (он без своих детей → 200),
    // затем архивируем корень и purge'им его. Это полный happy path в
    // новой реальности.
    await app.inject({
      method: "POST",
      url: `/api/tasks/${parentId}/restore`,
      headers: bearer(owner.jwt),
    });
    await app.inject({
      method: "POST",
      url: `/api/tasks/kid-1/archive`,
      headers: bearer(owner.jwt),
    });
    const purgeKid = await app.inject({
      method: "DELETE",
      url: `/api/tasks/kid-1`,
      headers: bearer(owner.jwt),
    });
    expect(purgeKid.statusCode).toBe(200);

    // Корень сейчас живой (восстановлен ранее) — архивируем его, чтобы
    // DELETE на корне сработал как purge, а не как повторный archive.
    await app.inject({
      method: "POST",
      url: `/api/tasks/${parentId}/archive`,
      headers: bearer(owner.jwt),
    });
    const ok = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${parentId}`,
      headers: bearer(owner.jwt),
    });
    expect(ok.statusCode).toBe(200);
    const okBody = ok.json() as { deleted?: boolean; counts?: { subtasks: number; comments: number; attachments: number; events: number } };
    expect(okBody.deleted === true || okBody.counts !== undefined).toBe(true);
    expect(okBody.counts?.events ?? 0).toBeGreaterThan(0);
  });

  it("архивирование снимает agent_state на задаче и активную аренду подзадач", async () => {
    const taskId = await makeTask(null, "Активная");
    // Имитируем активную работу: ставим на задачу и подзадачу.
    db.prepare("UPDATE tasks SET agent_state = 'in_progress', agent_heartbeat_at = datetime('now') WHERE id = ?").run(taskId);
    db.prepare(
      "INSERT INTO subtasks(id, task_id, title, agent_state, agent_id, agent_heartbeat_at) VALUES (?, ?, ?, 'in_progress', ?, datetime('now'))",
    ).run("s-active", taskId, "Шаг", agentA.id);

    const arch = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: bearer(owner.jwt),
    });
    expect(arch.statusCode).toBe(200);

    const taskRow = db.prepare("SELECT agent_state FROM tasks WHERE id = ?").get(taskId) as
      | { agent_state: string | null } | undefined;
    expect(taskRow?.agent_state).toBeNull();

    const subRow = db.prepare("SELECT agent_state FROM subtasks WHERE id = ?").get("s-active") as
      | { agent_state: string | null } | undefined;
    expect(subRow?.agent_state).toBeNull();
  });

  it("архивирование отменяет queued job'ы в role_run_jobs", async () => {
    const taskId = await makeTask(null, "С pending job");
    db.prepare(
      "INSERT INTO role_run_jobs(id, task_id, reason, dedupe_key, status, attempts, max_attempts, chain_depth, manual_start, available_at) VALUES (?, ?, 'commented', ?, 'queued', 0, 3, 0, 0, datetime('now'))",
    ).run("rrj-test", taskId, "k1");

    const arch = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: bearer(owner.jwt),
    });
    expect(arch.statusCode).toBe(200);

    const jobRow = db.prepare("SELECT status FROM role_run_jobs WHERE id = ?").get("rrj-test") as
      | { status: string } | undefined;
    expect(jobRow?.status).toBe("cancelled");
  });

  it("поиск и счётчики проекта не учитывают архивные задачи", async () => {
    const projectId = await makeProject("P-фильтры");
    const aliveId = await makeTask(projectId, "Живая");
    const archivedId = await makeTask(projectId, "Архивная");
    await app.inject({
      method: "POST",
      url: `/api/tasks/${archivedId}/archive`,
      headers: bearer(owner.jwt),
    });

    // Поиск: живая находится, архивная — нет.
    const search = await app.inject({
      method: "GET",
      url: "/api/search?q=" + encodeURIComponent("Жив"),
      headers: bearer(owner.jwt),
    });
    expect(search.statusCode).toBe(200);
    const searchIds = ((search.json() as { tasks?: Array<{ id: string }> }).tasks ?? []).map((t) => t.id);
    expect(searchIds).toContain(aliveId);
    expect(searchIds).not.toContain(archivedId);

    // В архивном списке проекта архивная видна.
    const archList = await app.inject({
      method: "GET",
      url: "/api/tasks?archived=true&project_id=" + encodeURIComponent(projectId),
      headers: bearer(owner.jwt),
    });
    expect(archList.statusCode).toBe(200);
    const ids = (archList.json() as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain(archivedId);
  });

  it("task_purge_log пишет числа subtasks/comments/attachments/events", async () => {
    const taskId = await makeTask(null, "С содержимым");
    db.prepare("INSERT INTO comments(id, task_id, user_id, text) VALUES (?, ?, ?, ?)").run(
      "c-1", taskId, owner.id, "Комментарий",
    );
    db.prepare(
      "INSERT INTO attachments(id, task_id, user_id, file_name, mime, size, stored_name) VALUES (?, ?, ?, 'a.png', 'image/png', 100, 'a.png')",
    ).run("a-1", taskId, owner.id);
    db.prepare("INSERT INTO subtasks(id, task_id, title) VALUES (?, ?, ?)").run("s-1", taskId, "шаг");

    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: bearer(owner.jwt),
    });
    const purge = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${taskId}`,
      headers: bearer(owner.jwt),
    });
    expect(purge.statusCode).toBe(200);

    const log = db
      .prepare("SELECT * FROM task_purge_log WHERE task_id = ?")
      .get(taskId) as
      | {
          task_id: string;
          actor_id: string;
          subtasks: number;
          comments: number;
          attachments: number;
          events: number;
        }
      | undefined;
    expect(log?.task_id).toBe(taskId);
    expect(log?.actor_id).toBe(owner.id);
    expect(log?.subtasks).toBe(1);
    expect(log?.comments).toBe(1);
    expect(log?.attachments).toBe(1);
    expect(log?.events).toBeGreaterThan(0);
  });

  it("агент-создатель чужой живой задачи не может её удалить — 404", async () => {
    // Создаём от агента А задачу; агент Б пытается её удалить — не должен пройти.
    const create = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: bearer(agentA.jwt),
      payload: { title: "Задача агента А" },
    });
    expect(create.statusCode).toBe(200);
    const taskId = (create.json() as { task: { id: string } }).task.id;

    const byB = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${taskId}`,
      headers: bearer(agentB.jwt),
    });
    expect(byB.statusCode).toBe(404);
  });

  it("архивирование родителя атомарно уводит всё поддерево (parent→child→grandchild) и снимает работу/очереди", async () => {
    // Дерево: g-parent -> parent -> child (три уровня), чтобы покрыть
    // рекурсивный обход глубже двух уровней.
    const grandParentId = await makeTask(null, "Прадед");
    const stamp = Date.now();
    const parentId = `tree-parent-${stamp}`;
    const childId = `tree-child-${stamp}`;
    const subId = `s-grandchild-${stamp}`;
    const jobId = `rrj-parent-${stamp}`;
    db.prepare(
      "INSERT INTO tasks(id, title, parent_id) VALUES (?, ?, ?)",
    ).run(parentId, "Ребёнок прадеда", grandParentId);
    db.prepare(
      "INSERT INTO tasks(id, title, parent_id) VALUES (?, ?, ?)",
    ).run(childId, "Внук прадеда", parentId);

    // Имитируем активную работу: agent_state на каждом узле + аренда
    // подзадачи на внуке + queued job на родителе.
    db.prepare(
      "UPDATE tasks SET agent_state = 'in_progress', agent_heartbeat_at = datetime('now') WHERE id = ?",
    ).run(grandParentId);
    db.prepare(
      "UPDATE tasks SET agent_state = 'in_progress', agent_heartbeat_at = datetime('now') WHERE id = ?",
    ).run(parentId);
    db.prepare(
      "UPDATE tasks SET agent_state = 'in_progress', agent_heartbeat_at = datetime('now') WHERE id = ?",
    ).run(childId);
    db.prepare(
      "INSERT INTO subtasks(id, task_id, title, agent_state, agent_id, agent_heartbeat_at) VALUES (?, ?, ?, 'in_progress', ?, datetime('now'))",
    ).run(subId, childId, "Шаг внука", agentA.id);
    db.prepare(
      "INSERT INTO role_run_jobs(id, task_id, reason, dedupe_key, status, attempts, max_attempts, chain_depth, manual_start, available_at) VALUES (?, ?, 'commented', ?, 'queued', 0, 3, 0, 0, datetime('now'))",
    ).run(jobId, parentId, "k-parent");

    const arch = await app.inject({
      method: "POST",
      url: `/api/tasks/${grandParentId}/archive`,
      headers: bearer(owner.jwt),
    });
    expect(arch.statusCode).toBe(200);

    // Все три узла поддерева — archived_at != NULL, archived_by = owner.
    for (const id of [grandParentId, parentId, childId]) {
      const row = db
        .prepare("SELECT archived_at, archived_by, agent_state FROM tasks WHERE id = ?")
        .get(id) as
        | { archived_at: string | null; archived_by: string | null; agent_state: string | null }
        | undefined;
      expect(row?.archived_at, `archived_at on ${id}`).toBeTruthy();
      expect(row?.archived_by, `archived_by on ${id}`).toBe(owner.id);
      expect(row?.agent_state, `agent_state NULL on ${id}`).toBeNull();
    }

    // Аренда подзадачи внука снята.
    const subRow = db
      .prepare("SELECT agent_state FROM subtasks WHERE id = ?")
      .get(subId) as
      | { agent_state: string | null } | undefined;
    expect(subRow?.agent_state).toBeNull();

    // Pending job на родителе — cancelled.
    const jobRow = db
      .prepare("SELECT status FROM role_run_jobs WHERE id = ?")
      .get(jobId) as
      | { status: string } | undefined;
    expect(jobRow?.status).toBe("cancelled");

    // На каждый узел поддерева — событие task:archived.
    const events = db
      .prepare(
        "SELECT task_id FROM task_events WHERE kind = 'task:archived' AND task_id IN (?, ?, ?)",
      )
      .all(grandParentId, parentId, childId) as Array<{ task_id: string }>;
    const seen = new Set(events.map((e) => e.task_id));
    expect(seen.has(grandParentId)).toBe(true);
    expect(seen.has(parentId)).toBe(true);
    expect(seen.has(childId)).toBe(true);

    // parent_id у потомков сохранился (для симметричного restore).
    const childRow = db
      .prepare("SELECT parent_id FROM tasks WHERE id = ?")
      .get(childId) as { parent_id: string | null };
    expect(childRow.parent_id).toBe(parentId);
    const parentRow = db
      .prepare("SELECT parent_id FROM tasks WHERE id = ?")
      .get(parentId) as { parent_id: string | null };
    expect(parentRow.parent_id).toBe(grandParentId);
  });

  it("restore корня атомарно возвращает всё поддерево", async () => {
    const grandParentId = await makeTask(null, "Восстановить");
    const parentId = `restore-parent-${Date.now()}`;
    const childId = `restore-child-${Date.now()}`;
    db.prepare("INSERT INTO tasks(id, title, parent_id) VALUES (?, ?, ?)").run(
      parentId, "Ребёнок", grandParentId,
    );
    db.prepare("INSERT INTO tasks(id, title, parent_id) VALUES (?, ?, ?)").run(
      childId, "Внук", parentId,
    );

    // Сначала архивируем всё поддерево.
    await app.inject({
      method: "POST",
      url: `/api/tasks/${grandParentId}/archive`,
      headers: bearer(owner.jwt),
    });
    for (const id of [grandParentId, parentId, childId]) {
      const row = db
        .prepare("SELECT archived_at FROM tasks WHERE id = ?")
        .get(id) as { archived_at: string | null };
      expect(row.archived_at).toBeTruthy();
    }

    // Теперь восстанавливаем корень.
    const restore = await app.inject({
      method: "POST",
      url: `/api/tasks/${grandParentId}/restore`,
      headers: bearer(owner.jwt),
    });
    expect(restore.statusCode).toBe(200);

    // Все три узла — обратно живы.
    for (const id of [grandParentId, parentId, childId]) {
      const row = db
        .prepare("SELECT archived_at, archived_by FROM tasks WHERE id = ?")
        .get(id) as { archived_at: string | null; archived_by: string | null };
      expect(row.archived_at, `archived_at NULL on ${id}`).toBeNull();
      expect(row.archived_by, `archived_by NULL on ${id}`).toBeNull();
    }

    // На каждый узел — событие task:restored.
    const events = db
      .prepare(
        "SELECT task_id FROM task_events WHERE kind = 'task:restored' AND task_id IN (?, ?, ?)",
      )
      .all(grandParentId, parentId, childId) as Array<{ task_id: string }>;
    const seen = new Set(events.map((e) => e.task_id));
    expect(seen.has(grandParentId)).toBe(true);
    expect(seen.has(parentId)).toBe(true);
    expect(seen.has(childId)).toBe(true);
  });

  it("архивный список показывает только корни архивных поддеревьев", async () => {
    const grandParentId = await makeTask(null, "Корень архивного списка");
    const parentId = `list-parent-${Date.now()}`;
    const childId = `list-child-${Date.now()}`;
    db.prepare("INSERT INTO tasks(id, title, parent_id) VALUES (?, ?, ?)").run(
      parentId, "Промежуточный", grandParentId,
    );
    db.prepare("INSERT INTO tasks(id, title, parent_id) VALUES (?, ?, ?)").run(
      childId, "Лист", parentId,
    );

    await app.inject({
      method: "POST",
      url: `/api/tasks/${grandParentId}/archive`,
      headers: bearer(owner.jwt),
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/tasks?archived=true&include_children=true",
      headers: bearer(owner.jwt),
    });
    expect(list.statusCode).toBe(200);
    const items = list.json() as Array<{ id: string; archived_subtree_count?: number }>;
    const ids = items.map((t) => t.id);
    expect(ids).toContain(grandParentId);
    expect(ids).not.toContain(parentId);
    expect(ids).not.toContain(childId);
    const root = items.find((t) => t.id === grandParentId);
    expect(root?.archived_subtree_count).toBe(3); // корень + потомок + внук
  });

  it("повторный archive корня идемпотентен и не плодит дублей в архивном списке", async () => {
    const grandParentId = await makeTask(null, "Идемпотентный корень");
    const childId = `idem-child-${Date.now()}`;
    db.prepare("INSERT INTO tasks(id, title, parent_id) VALUES (?, ?, ?)").run(
      childId, "Ребёнок", grandParentId,
    );

    const first = await app.inject({
      method: "POST",
      url: `/api/tasks/${grandParentId}/archive`,
      headers: bearer(owner.jwt),
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${grandParentId}/archive`,
      headers: bearer(owner.jwt),
    });
    expect(second.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/api/tasks?archived=true&include_children=true",
      headers: bearer(owner.jwt),
    });
    const items = list.json() as Array<{ id: string }>;
    const occurrences = items.filter((t) => t.id === grandParentId).length;
    expect(occurrences).toBe(1);
  });
});
