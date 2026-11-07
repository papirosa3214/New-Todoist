// Адресация шага из окна координации: сообщение владельца исполнителю должно
// доходить до роли, а не оставаться текстом в ленте.
//
// Механика на сервере: `POST /api/chats/:id/messages` с `recipient_subtask_id`
// и режимом «по карточке» → `dispatchRoleReplies` поднимает роль по
// упоминанию, `resolveTopicSlot` находит нужный слот по адресату, и роль
// получает сообщение (в очередь либо подмешиванием в текущий ход).
// Клиент отправляет именно так — см. `ExecutorWindowModel.send`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";
import type { FastifyInstance } from "fastify";

const uid = (): string => crypto.randomUUID();

/** Учётка роли: сервер видит роль по учётке (type=ai, role=agent, role_key),
 *  а слоты плана ищет по `role_<ключ>` — поэтому id именно такой. */
function ensureRoleAccount(roleKey: string, title: string): string {
  const id = `role_${roleKey}`;
  const existing = db
    .prepare("SELECT id FROM users WHERE id = ? AND type = 'ai' AND role = 'agent' AND role_key = ?")
    .get(id, roleKey) as { id: string } | undefined;
  if (existing) return id;
  db.prepare(
    `INSERT OR IGNORE INTO users
       (id, name, email, password_hash, role, role_key, type, is_system_bot, profile, initials, avatar_color, status)
     VALUES (?, ?, ?, '!no-login', 'agent', ?, 'ai', 1, ?, '?', '#8E8E93', 'offline')`,
  ).run(id, title, `${roleKey}@taskflow.local`, roleKey);
  return id;
}

let app: FastifyInstance;
let token: string;
let userId: string;
let taskId: string;
let projectId: string;
let topicChatId: string;
let qaSlot: string;
let qaAccountId: string;
let builderAccountId: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `slot-owner-${Date.now()}@test.local`,
      password: "test-password-strong-1",
      name: "Slot Owner",
    },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const body = reg.json() as { user: { id: string }; token: string };
  userId = body.user.id;
  token = body.token;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(userId);

  // Учётки ролей: роль становится участником чата только если её учётка
  // есть и она помечена как агент (так её и находит сервер).
  qaAccountId = ensureRoleAccount("qa", "Лайф-тестировщик");
  builderAccountId = ensureRoleAccount("builder", "Разработчик");

  projectId = `proj_${uid()}`;
  db.prepare("INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)").run(projectId, "Слоты", userId);

  taskId = `task_${uid()}`;
  db.prepare(
    `INSERT INTO tasks (id, title, status, creator_id, assignee_id, agent_state, position, archived_at, project_id)
     VALUES (?, 'slot-addressing', 'active', ?, ?, NULL, 0, NULL, ?)`,
  ).run(taskId, userId, userId, projectId);

  // План утверждён: без него сервер не считает слот рабочим этапом роли
  // (`topicSlots` — слот + узел плана + утверждённый план).
  const planId = `plan_${uid()}`;
  db.prepare(
    `INSERT INTO task_collaboration_plans (id, task_id, status, revision, profile, rationale, created_by)
     VALUES (?, ?, 'approved', 1, 'manual', 'slot-addressing', ?)`,
  ).run(planId, taskId, userId);
  db.prepare(
    `INSERT INTO task_collaboration_plan_nodes
       (id, plan_id, slot_key, role_key, expected_result, output_artifact_json, instructions, iteration, skipped_at, rework_of_key)
     VALUES (?, ?, 'work_1', 'qa', 'Проверить починку', NULL, NULL, 0, NULL, NULL)`,
  ).run(`node_${uid()}`, planId);

  qaSlot = `sub_${uid()}`;
  db.prepare(
    `INSERT INTO subtasks (id, task_id, title, position, done, agent_id, collaboration_plan_id, plan_node_key)
     VALUES (?, ?, 'Проверить починку', 0, 0, ?, ?, 'work_1')`,
  ).run(qaSlot, taskId, qaAccountId, planId);

  // Тема задачи: группа проекта → тема с parent_chat_id, как её заводит сервер.
  const groupId = `chat_${uid()}`;
  db.prepare(
    `INSERT INTO chats (id, title, kind, created_by, project_id) VALUES (?, 'Проект', 'group', ?, ?)`,
  ).run(groupId, userId, projectId);

  topicChatId = `chat_${uid()}`;
  db.prepare(
    `INSERT INTO chats (id, title, kind, created_by, task_id, project_id, parent_chat_id)
     VALUES (?, 'Тема задачи', 'group', ?, ?, ?, ?)`,
  ).run(topicChatId, userId, taskId, projectId, groupId);

  db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(topicChatId, userId);
  db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(topicChatId, qaAccountId);
});

afterAll(async () => {
  await app.close();
});

describe("координация: сообщение исполнителю по слоту", () => {
  it("сообщение с адресатом-слотом сохраняется с адресатом и поднимает роль", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${topicChatId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: "@qa проверь, почему прокси не поднялся",
        recipient_subtask_id: qaSlot,
        execution_mode: "card",
        work_mode: "work",
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const message = (res.json() as { message: { id: string } }).message;
    expect(message.id).toBeTruthy();

    // Адресат сохранён — по нему сводка исполнителей собирает переписку.
    const stored = db
      .prepare("SELECT recipient_subtask_id, text, task_id FROM chat_messages WHERE id = ?")
      .get(message.id) as { recipient_subtask_id: string | null; text: string; task_id: string | null };
    expect(stored.recipient_subtask_id).toBe(qaSlot);
    expect(stored.task_id).toBe(taskId);
    expect(stored.text).toContain("@qa");

    // Роль поднята: у неё есть строка доставки на это сообщение.
    const queued = db
      .prepare("SELECT role_id, status FROM chat_message_queue WHERE message_id = ?")
      .all(message.id) as Array<{ role_id: string; status: string }>;
    expect(queued.map((row) => row.role_id)).toContain(qaAccountId);
  });

  it("адресат-слот поднимает роль и без упоминания в тексте", async () => {
    // Так пишет клиент из окна координации: текст владельца без «@Роль»,
    // адресат — сам слот (владелец 02.11.2026).
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${topicChatId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: "проверь, почему прокси не поднялся",
        recipient_subtask_id: qaSlot,
        execution_mode: "card",
        work_mode: "work",
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const message = (res.json() as { message: { id: string } }).message;
    const stored = db
      .prepare("SELECT recipient_subtask_id, text FROM chat_messages WHERE id = ?")
      .get(message.id) as { recipient_subtask_id: string | null; text: string };
    expect(stored.recipient_subtask_id).toBe(qaSlot);
    // Текст остаётся владельческим — без подстановки «@Роль».
    expect(stored.text).toBe("проверь, почему прокси не поднялся");
    const queued = db
      .prepare("SELECT role_id FROM chat_message_queue WHERE message_id = ?")
      .all(message.id) as Array<{ role_id: string }>;
    expect(queued.map((row) => row.role_id)).toContain(qaAccountId);
  });

  it("шаг чужой роли адресатом не считается — роль не поднимается", async () => {    const foreignSlot = `sub_${uid()}`;
    db.prepare(
      `INSERT INTO subtasks (id, task_id, title, position, done, agent_id)
       VALUES (?, ?, 'Чужой шаг', 1, 0, ?)`,
    ).run(foreignSlot, taskId, builderAccountId);
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${topicChatId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: "@builder посмотри",
        recipient_subtask_id: foreignSlot,
        execution_mode: "card",
        work_mode: "work",
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const message = (res.json() as { message: { id: string } }).message;
    const stored = db
      .prepare("SELECT recipient_subtask_id FROM chat_messages WHERE id = ?")
      .get(message.id) as { recipient_subtask_id: string | null };
    expect(stored.recipient_subtask_id).toBe(foreignSlot);
    // Роль «Разработчик» в теме не состоит — её ход не поднимается.
    const queued = db
      .prepare("SELECT role_id FROM chat_message_queue WHERE message_id = ?")
      .all(message.id) as Array<{ role_id: string }>;
    expect(queued.map((row) => row.role_id)).not.toContain(builderAccountId);
  });
});
