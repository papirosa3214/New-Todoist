// Групповая комната задачи (владелец 08.11.2026): одна на задачу, независимо от
// проекта, и видна топиком в личной комнате каждой роли-участника. Проектных
// чатов больше не существует (docs/2026-11-08-role-slot-chat-branches-spec.md §1–3).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { ensurePersonalRoom } from "../src/lib/chatRooms.js";
import {
  ensureTaskRoom,
  isTaskRoom,
  roomsOfPersonalChat,
  taskRoomOf,
} from "../src/lib/projectTopics.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

const TASK_NO_PROJECT = "tr-no-project";
const TASK_WITH_PROJECT = "tr-with-project";
const PROJECT = "tr-project";

function owner(): string {
  const row = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (row) return row.id;
  db.prepare("INSERT INTO users (id, name, role, type) VALUES ('tr-owner','Тест-владелец','owner','human')").run();
  return "tr-owner";
}

function purge(): void {
  for (const table of ["chat_room_topics", "chat_members", "chat_messages", "chats"]) {
    if (table === "chats") {
      db.prepare("DELETE FROM chats WHERE task_id IN (?,?)").run(TASK_NO_PROJECT, TASK_WITH_PROJECT);
      continue;
    }
    db.prepare(
      `DELETE FROM ${table} WHERE ${table === "chat_room_topics" ? "room_chat_id" : "chat_id"} IN
         (SELECT id FROM chats WHERE task_id IN (?,?))`,
    ).run(TASK_NO_PROJECT, TASK_WITH_PROJECT);
  }
  db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id='tr-plan'").run();
  db.prepare("DELETE FROM task_collaboration_plans WHERE id='tr-plan'").run();
  db.prepare("DELETE FROM tasks WHERE id IN (?,?)").run(TASK_NO_PROJECT, TASK_WITH_PROJECT);
  db.prepare("DELETE FROM projects WHERE id=?").run(PROJECT);
}

function seed(): void {
  const ownerId = owner();
  db.prepare("INSERT OR IGNORE INTO roles (key, title, summary, enabled, position) VALUES ('builder','Разработчик','пишет код',1,10)").run();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, role, role_key, type, email, password_hash, is_system_bot)
     VALUES ('role_builder','Разработчик','agent','builder','ai','builder@task-rooms','!test',1)`,
  ).run();
  db.prepare("INSERT INTO projects (id, name, owner_id) VALUES (?, 'Проект комнаты', ?)").run(PROJECT, ownerId);
  db.prepare("INSERT INTO tasks (id, title, creator_id, status, project_id) VALUES (?, 'Без проекта', ?, 'active', NULL)").run(
    TASK_NO_PROJECT,
    ownerId,
  );
  db.prepare("INSERT INTO tasks (id, title, creator_id, status, project_id) VALUES (?, 'С проектом', ?, 'active', ?)").run(
    TASK_WITH_PROJECT,
    ownerId,
    PROJECT,
  );
  db.prepare("INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, created_by) VALUES ('tr-plan', ?, 1, 'approved', 'manual', ?)").run(
    TASK_NO_PROJECT,
    ownerId,
  );
  db.prepare(
    "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, expected_result) VALUES ('tr-node','tr-plan','impl','builder','Работающий код')",
  ).run();
}

describe("групповая комната задачи", () => {
  let app: FastifyInstance;
  let ownerAuth: Record<string, string>;

  beforeAll(async () => {
    app = await buildApp();
    purge();
    seed();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "TaskRoomsOwner", email: `task-rooms-${Date.now()}@test`, password: "password123" },
    });
    const body = res.json();
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(body.user.id);
    ownerAuth = { authorization: `Bearer ${body.token}` };
  });

  afterAll(async () => {
    purge();
    if (app) await app.close();
  });

  it("заводит комнату задачи у карточки без проекта", () => {
    const room = ensureTaskRoom(TASK_NO_PROJECT);
    expect(room).toBeTruthy();
    const row = db.prepare("SELECT task_id, room_kind, project_id, parent_chat_id, title FROM chats WHERE id=?").get(room) as {
      task_id: string;
      room_kind: string;
      project_id: string | null;
      parent_chat_id: string | null;
      title: string;
    };
    expect(row.room_kind).toBe("task");
    expect(row.task_id).toBe(TASK_NO_PROJECT);
    // Ни проектной группы, ни родителя: комната задачи от проекта свободна.
    expect(row.project_id).toBeNull();
    expect(row.parent_chat_id).toBeNull();
    expect(row.title).toBe("Без проекта");
  });

  it("повторный вызов не плодит ни комнат, ни участников", () => {
    const first = ensureTaskRoom(TASK_NO_PROJECT);
    const second = ensureTaskRoom(TASK_NO_PROJECT);
    expect(second).toBe(first);
    const rooms = db.prepare("SELECT COUNT(*) AS n FROM chats WHERE task_id=? AND room_kind='task'").get(TASK_NO_PROJECT) as { n: number };
    expect(rooms.n).toBe(1);
    const members = db.prepare("SELECT COUNT(*) AS n FROM chat_members WHERE chat_id=?").get(first) as { n: number };
    const after = ensureTaskRoom(TASK_NO_PROJECT);
    const membersAgain = db.prepare("SELECT COUNT(*) AS n FROM chat_members WHERE chat_id=?").get(after) as { n: number };
    expect(membersAgain.n).toBe(members.n);
  });

  it("проект не превращается в чат: у комнаты задачи нет project_id", () => {
    const room = ensureTaskRoom(TASK_WITH_PROJECT);
    const row = db.prepare("SELECT project_id, room_kind FROM chats WHERE id=?").get(room) as { project_id: string | null; room_kind: string };
    expect(row.room_kind).toBe("task");
    expect(row.project_id).toBeNull();
    const projectChats = db.prepare("SELECT COUNT(*) AS n FROM chats WHERE project_id IS NOT NULL").get() as { n: number };
    expect(projectChats.n).toBe(0);
  });

  it("роль-участница видит ту же комнату топиком в своей личной комнате", () => {
    const room = ensureTaskRoom(TASK_NO_PROJECT);
    const personal = ensurePersonalRoom("role_builder");
    expect(personal).toBeTruthy();
    const topics = roomsOfPersonalChat(personal!);
    expect(topics.map((topic) => topic.id)).toContain(room);
    // Один и тот же чат, а не копия: у топика тот же ID задачи.
    expect(topics.find((topic) => topic.id === room)?.task_id).toBe(TASK_NO_PROJECT);
    expect(taskRoomOf(TASK_NO_PROJECT)).toBe(room);
  });

  it("комната задачи отличается от заминок и личной комнаты", () => {
    const room = ensureTaskRoom(TASK_NO_PROJECT);
    expect(isTaskRoom(db.prepare("SELECT task_id, room_kind FROM chats WHERE id=?").get(room) as any)).toBe(true);
    expect(isTaskRoom({ task_id: room, room_kind: "wake" })).toBe(false);
    expect(isTaskRoom({ task_id: null, room_kind: "task" })).toBe(false);
  });

  it("POST /api/tasks/:id/topic работает для задачи без проекта", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${TASK_NO_PROJECT}/topic`,
      headers: ownerAuth,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const chat = res.json().chat;
    expect(chat.room_kind).toBe("task");
    expect(chat.project_id ?? null).toBeNull();
  });

  it("проектного чата больше не заводится", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT}/chat`,
      headers: ownerAuth,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    const projectChats = db.prepare("SELECT COUNT(*) AS n FROM chats WHERE project_id IS NOT NULL").get() as { n: number };
    expect(projectChats.n).toBe(0);
  });
  it("создание задачи комнату не заводит — она появляется, когда задача в работе", async () => {
    // Владелец 11.11.2026: «комната не должна создаваться, пока задачка ещё
    // не в работе». Пустая комната без сообщений только засоряла список чатов.
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "Комната не при создании", project_id: PROJECT, skip_auto_plan: true },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().task.id as string;
    const rooms = db
      .prepare("SELECT COUNT(*) AS n FROM chats WHERE task_id = ? AND room_kind = 'task'")
      .get(id) as { n: number };
    expect(rooms.n, "задача не в работе — комнаты нет").toBe(0);
    db.prepare("DELETE FROM task_preparation_jobs WHERE task_id = ?").run(id);
    // Уборка тестовой карточки: детей (события, уведомления, inbox) уносим
    // вместе с ней, чтобы не ловить FOREIGN KEY на временной базе.
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    db.pragma("foreign_keys = ON");
  });
});
