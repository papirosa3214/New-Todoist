import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db, { hashApiToken } from "../src/db.js";

// MAK-99: токен молчания на живом пути отправки роли в тему задачи.
// «Принял» не попадает в ленту темы, вопрос/результат — попадает.
describe("MAK-99: токен молчания в ленте темы", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerToken: string;
  let agentId: string;
  let agentToken: string;
  let taskId: string;
  let topicId: string;
  let projectId: string;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "OwnerSilentChat", email: "owner-silent-chat@test", password: "password123" },
    });
    ownerId = owner.json().user.id;
    ownerToken = owner.json().token;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    // Каноническая AI-учётка роли: id обязан быть role_<key> (страж 058).
    agentId = "role_builder";
    agentToken = "silence-builder-key";
    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, role_key, type, is_system_bot, api_token)
       VALUES (?, ?, ?, '!test', 'agent', 'builder', 'ai', 1, ?)`,
    ).run(agentId, "BuilderSilentChat", "builder-silent-chat@test", hashApiToken(agentToken));

    projectId = "project-silence-test";
    db.prepare("INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)").run(projectId, "Проект токена молчания", ownerId);
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Тема для токена молчания", project_id: projectId },
    });
    taskId = created.json().task.id;
    db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(projectId, taskId);
    // Тема задачи могла быть заведена автоматически при создании — берём её,
    // иначе создаём поверх группы проекта.
    const existingTopic = db
      .prepare("SELECT id FROM chats WHERE task_id = ? AND parent_chat_id IS NOT NULL")
      .get(taskId) as { id: string } | undefined;
    if (existingTopic) {
      topicId = existingTopic.id;
    } else {
      let groupId = (
        db.prepare("SELECT id FROM chats WHERE project_id = ? AND parent_chat_id IS NULL").get(projectId) as
          | { id: string }
          | undefined
      )?.id;
      if (!groupId) {
        groupId = "group-silence-test";
        db.prepare(
          "INSERT INTO chats (id, title, kind, created_by, project_id) VALUES (?, 'Группа проекта', 'group', ?, ?)",
        ).run(groupId, ownerId, projectId);
      }
      topicId = "topic-silence-test";
      db.prepare(
        "INSERT INTO chats (id, title, kind, created_by, project_id, task_id, parent_chat_id) VALUES (?, 'Тема задачи', 'group', ?, ?, ?, ?)",
      ).run(topicId, ownerId, projectId, taskId, groupId);
    }
    const member = db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)");
    member.run(topicId, ownerId);
    member.run(topicId, agentId);
  });

  afterAll(async () => {
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM chat_messages WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM chats WHERE id = ?").run(topicId);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    db.prepare("DELETE FROM chats WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM users WHERE id = ?").run(ownerId);
    db.prepare("DELETE FROM users WHERE id = ?").run(agentId);
    db.pragma("foreign_keys = ON");
    await app.close();
  });

  async function sendAsRole(text: string) {
    return app.inject({
      method: "POST",
      url: `/api/chats/${topicId}/messages`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { text, work_mode: "work" },
    });
  }

  it("«принял» не попадает в ленту темы, вопрос и результат попадают", async () => {
    const ack = await sendAsRole("принял");
    expect(ack.statusCode).toBe(200);
    expect(ack.json().suppressed).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(topicId)).toEqual({ n: 0 });

    const question = await sendAsRole("какой формат результата ждёшь?");
    expect(question.statusCode).toBe(200);
    expect(question.json().suppressed).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(topicId)).toEqual({ n: 1 });

    const silence = await sendAsRole("[SILENT]");
    expect(silence.json().suppressed).toBe(true);
    const result = await sendAsRole("готово, коммит abc123");
    expect(result.json().suppressed).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(topicId)).toEqual({ n: 2 });
  });
});
