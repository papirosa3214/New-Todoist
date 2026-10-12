// Архив проектов (карточка a1be7d63…).
//
// Удаление проекта больше не уничтожает данные: DELETE /api/projects/:id
// архивирует проект вместе со всем содержимым (задачи, документы, чаты,
// память). Архивное не фигурирует в обычных местах ни у кого, включая
// владельца; владелец читает его через /api/projects/archive и
// /api/projects/:id/archive-tasks. Из архива проект можно вернуть
// (restore) или удалить навсегда (purge).
//
// Проверяем наблюдаемое поведение через HTTP (app.inject, одноразовая база —
// test/setup.ts), а также содержимое базы для «данные сохранились/удалены».
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Архив проектов: архивация, скрытие, restore и purge", () => {
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

  /** Проект с папкой документов, задача, заметка, память и групповой чат. */
  async function makeFilledProject(name: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name, with_docs: true },
    });
    expect(created.statusCode).toBe(200);
    const project = created.json();
    const projectId = project.id as string;

    const taskRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Задача архива " + name, project_id: projectId },
    });
    expect(taskRes.statusCode).toBe(200);
    const taskId = taskRes.json().task.id as string;

    const noteId = "note-" + projectId;
    if (project.notes_folder_id) {
      db.prepare(
        "INSERT INTO user_notes (id, title, content, folder_id) VALUES (?,?,?,?)",
      ).run(noteId, "Документ " + name, "текст", project.notes_folder_id);
    }
    const memoryId = "mem-" + projectId;
    db.prepare(
      `INSERT INTO memories (id, scope, project_id, kind, text, source_kind)
       VALUES (?, 'project', ?, 'fact', 'память проекта', 'owner')`,
    ).run(memoryId, projectId);

    const chatRes = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(chatRes.statusCode).toBe(200);
    const chatId = chatRes.json().chat.id as string;

    return { projectId, taskId, noteId, memoryId, chatId, notesFolderId: project.notes_folder_id as number | null };
  }

  async function archive(token: string, projectId: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    app = await buildApp();

    const owner = await makeUser("Владелец архива", "owner@archive.test", {
      role: "owner",
    });
    ownerId = owner.id;
    ownerToken = owner.jwt;

    const agent = await makeUser("Агент архива", "agent@archive.test", {
      type: "ai",
    });
    agentId = agent.id;
    agentToken = await apiToken(agent.jwt);

    const orch = await makeUser("Орк архива", "orch@archive.test", {
      role: "orchestrator",
    });
    orchToken = orch.jwt;
  });

  afterAll(async () => {
    await app.close();
  });

  it("архивация сохраняет задачи, документы, память и закрывает чаты", async () => {
    const { projectId, taskId, noteId, memoryId, chatId } =
      await makeFilledProject("Сохранить всё");

    const res = await archive(ownerToken, projectId);
    expect(res.statusCode).toBe(200);
    expect(res.json().archived).toBe(true);

    const project = db
      .prepare("SELECT archived_at, archived_by FROM projects WHERE id = ?")
      .get(projectId) as { archived_at: string | null; archived_by: string | null };
    expect(project.archived_at).toBeTruthy();
    expect(project.archived_by).toBe(ownerId);

    // Данные остались на месте.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id = ?").get(taskId) as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM user_notes WHERE id = ?").get(noteId) as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id = ?").get(memoryId) as { n: number }).n,
    ).toBe(1);
    // Чат закрыт.
    const chat = db
      .prepare("SELECT closed_at FROM chats WHERE id = ?")
      .get(chatId) as { closed_at: string | null };
    expect(chat.closed_at).toBeTruthy();

    // Повторная архивация — конфликт, а не тихая перезапись.
    const again = await archive(ownerToken, projectId);
    expect(again.statusCode).toBe(409);
  });

  it("архивное не видно никому в списках, поиске и по id, но владелец читает через ручки архива", async () => {
    const { projectId, taskId } = await makeFilledProject("Спрятать");
    await archive(ownerToken, projectId);

    // Списки проектов у всех троих архив не содержат.
    for (const token of [ownerToken, agentToken, orchToken]) {
      const list = await app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.json().map((p: any) => p.id)).not.toContain(projectId);
    }

    // Списки задач у всех троих архивную задачу не содержат.
    for (const token of [ownerToken, agentToken, orchToken]) {
      const list = await app.inject({
        method: "GET",
        url: "/api/tasks",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.json().map((t: any) => t.id)).not.toContain(taskId);
    }

    // Поиск — пусто у владельца и у агента.
    for (const token of [ownerToken, agentToken]) {
      const search = await app.inject({
        method: "GET",
        url: "/api/search?q=Спрятать",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(search.json().tasks.length).toBe(0);
    }

    // Прямой запрос по id: не-владельцу 404, владельцу 200.
    for (const token of [agentToken, orchToken]) {
      const card = await app.inject({
        method: "GET",
        url: `/api/tasks/${taskId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(card.statusCode).toBe(404);
    }
    const ownerCard = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerCard.statusCode).toBe(200);

    // Ручки архива — только владельцу.
    const ownerArchive = await app.inject({
      method: "GET",
      url: "/api/projects/archive",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerArchive.statusCode).toBe(200);
    const row = ownerArchive
      .json()
      .find((p: any) => p.id === projectId);
    expect(row).toBeTruthy();
    expect(row.task_count).toBe(1);
    expect(row.docs_count).toBe(1);
    expect(row.chat_count).toBeGreaterThanOrEqual(1);

    for (const token of [agentToken, orchToken]) {
      const forbidden = await app.inject({
        method: "GET",
        url: "/api/projects/archive",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(forbidden.statusCode).toBe(403);
    }

    const ownerTasks = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/archive-tasks`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerTasks.statusCode).toBe(200);
    expect(ownerTasks.json().tasks.map((t: any) => t.id)).toContain(taskId);

    const agentTasks = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/archive-tasks`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(agentTasks.statusCode).toBe(403);
  });

  it("restore возвращает проект, но не открывает чаты сам", async () => {
    const { projectId, chatId } = await makeFilledProject("Вернуть");
    await archive(ownerToken, projectId);

    // Не владелец восстановить не может.
    const agentRestore = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/restore`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(agentRestore.statusCode).toBe(403);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/restore`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.archived_at).toBeNull();
    expect(res.json().chats_reopened).toBe(false);

    // Проект снова в обычном списке.
    const list = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(list.json().map((p: any) => p.id)).toContain(projectId);

    // Чат остался закрытым — автоматически не открываем.
    const chat = db
      .prepare("SELECT closed_at FROM chats WHERE id = ?")
      .get(chatId) as { closed_at: string | null };
    expect(chat.closed_at).toBeTruthy();
  });

  it("purge — только для архивного, только владельцу, с журналом и без удаления документов по умолчанию", async () => {
    const { projectId, taskId, noteId, memoryId, chatId, notesFolderId } =
      await makeFilledProject("Удалить навсегда");

    // Живой проект удалить навсегда нельзя.
    const live = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/purge`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(live.statusCode).toBe(409);

    await archive(ownerToken, projectId);

    // Агент не вправе.
    const asAgent = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/purge`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(asAgent.statusCode).toBe(403);

    const purge = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/purge`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(purge.statusCode).toBe(200);
    const body = purge.json();
    expect(body.counts.tasks).toBe(1);
    expect(body.counts.documents).toBe(1);
    expect(body.counts.chats).toBeGreaterThanOrEqual(1);
    expect(body.counts.memories).toBe(1);

    // Проект, задача, память и чат уничтожены.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(projectId) as { n: number }).n,
    ).toBe(0);
    const preserved=db.prepare("SELECT archived_at,project_id,project_name_snapshot FROM tasks WHERE id=?").get(taskId) as any;
    expect(preserved.archived_at).toBeTruthy();
    expect(preserved.project_id).toBeNull();
    expect(preserved.project_name_snapshot).toBeTruthy();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id = ?").get(memoryId) as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = ?").get(chatId) as { n: number }).n,
    ).toBe(0);
    // Документ остался — без with_docs заметки не удаляем.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM user_notes WHERE id = ?").get(noteId) as { n: number }).n,
    ).toBe(1);
    if (notesFolderId) {
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM journal_folders WHERE id = ?").get(notesFolderId) as { n: number }).n,
      ).toBe(1);
    }

    // Журнал purge записан с числами.
    const log = db
      .prepare("SELECT * FROM project_purge_log WHERE project_id = ?")
      .get(projectId) as any;
    expect(log).toBeTruthy();
    expect(log.tasks).toBe(1);
    expect(log.documents).toBe(1);
    expect(log.with_docs).toBe(0);

    // А теперь с with_docs=true документы тоже уходят.
    const second = await makeFilledProject("Удалить с документами");
    await archive(ownerToken, second.projectId);
    const purgeDocs = await app.inject({
      method: "DELETE",
      url: `/api/projects/${second.projectId}/purge?with_docs=true`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(purgeDocs.statusCode).toBe(200);
    expect(purgeDocs.json().with_docs).toBe(true);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM user_notes WHERE id = ?").get(second.noteId) as { n: number }).n,
    ).toBe(0);
    if (second.notesFolderId) {
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM journal_folders WHERE id = ?").get(second.notesFolderId) as { n: number }).n,
      ).toBe(0);
    }
  });
});
