// Архив комнаты задачи по окончательному закрытию (владелец 08.11.2026;
// спецификация `docs/2026-11-08-role-slot-chat-branches-spec.md` §8): работа
// останавливается, комната уходит в архив один раз, владельцу приходит
// минимальное событие без содержимого переписки, а архивная комната больше не
// принимает ни отправок, ни доставки работы.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { ensureSlotAssignment } from "../src/lib/chatChildren.js";
import { ensureTaskRoom, setTaskRoomClosed } from "../src/lib/projectTopics.js";
import { archiveTaskRoom, refuseArchivedWork, roomArchivedAt } from "../src/lib/taskRoomArchive.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

const TASK = "archive-task";
const PLAN = "archive-plan";
const SLOT = "archive-slot";

describe("Архив комнаты задачи по окончательному закрытию", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let ownerId: string;
  let roomId: string;

  function seedQueue(message: string): void {
    const messageId = `archive-msg-${message}`;
    db.prepare(
      "INSERT INTO chat_messages (id, chat_id, from_user_id, text) VALUES (?, ?, ?, ?)",
    ).run(messageId, roomId, ownerId, message);
    db.prepare(
      `INSERT INTO chat_message_queue
         (id, chat_id, role_id, delivery_id, message_id, payload_json, status)
       VALUES (?, ?, ?, ?, ?, '{}', 'pending')`,
    ).run(`archive-q-${message}`, roomId, ownerId, `archive-d-${message}`, messageId);
    db.prepare(
      "INSERT INTO slot_topic_inbox (message_id, subtask_id, delivered_at) VALUES (?, ?, NULL)",
    ).run(messageId, SLOT);
  }

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "ArchiveOwner", email: `archive-${Date.now()}@test`, password: "password123" },
    });
    const body = res.json();
    ownerId = body.user.id;
    ownerAuth = { authorization: `Bearer ${body.token}` };
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);

    db.prepare("INSERT INTO tasks (id, title, creator_id, status) VALUES (?, 'Задача для архива', ?, 'active')").run(TASK, ownerId);
    db.prepare(
      "INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, created_by) VALUES (?, ?, 1, 'approved', 'manual', ?)",
    ).run(PLAN, TASK, ownerId);
    db.prepare(
      "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, expected_result) VALUES (?, ?, 'impl', 'builder', 'Работающий код')",
    ).run("archive-node", PLAN);
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, done, position, collaboration_plan_id, plan_node_key) VALUES (?, ?, 'Сборка', 0, ?, ?, 'impl')",
    ).run(SLOT, TASK, 0, PLAN);

    roomId = ensureTaskRoom(TASK) as string;
    seedQueue("первое");
  });

  afterAll(async () => {
    db.prepare("DELETE FROM chat_message_queue WHERE chat_id = ?").run(roomId ?? "");
    db.prepare("DELETE FROM slot_topic_inbox WHERE subtask_id = ?").run(SLOT);
    db.prepare("DELETE FROM chat_child_sessions WHERE talk_chat_id = ?").run(roomId ?? "");
    db.prepare("DELETE FROM notifications WHERE task_id = ?").run(TASK);
    db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(roomId ?? "");
    db.prepare("DELETE FROM chat_members WHERE chat_id = ?").run(roomId ?? "");
    db.prepare("DELETE FROM chats WHERE id = ?").run(roomId ?? "");
    db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(TASK);
    db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id = ?").run(PLAN);
    db.prepare("DELETE FROM task_collaboration_plans WHERE task_id = ?").run(TASK);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(TASK);
    // Учётку не удаляем: на ней висят сессии и токены, а тестовая база живёт один прогон.
    if (app) await app.close();
  });

  it("архивирует комнату один раз и снимает фоновую доставку", () => {
    expect(ensureSlotAssignment({ taskId: TASK, slotId: SLOT, role: "builder" })).not.toBeNull();
    const first = archiveTaskRoom(TASK, { reason: "задача выполнена" });
    expect(first.roomId).toBe(roomId);
    expect(first.archived).toBe(true);
    expect(first.queue).toBe(1);
    expect(roomArchivedAt(roomId)).toBeTruthy();
    expect(
      db.prepare("SELECT status FROM chat_message_queue WHERE id = 'archive-q-первое'").get(),
    ).toEqual({ status: "superseded" });
    expect(
      db.prepare("SELECT count(*) AS n FROM slot_topic_inbox WHERE subtask_id = ? AND delivered_at IS NULL").get(SLOT),
    ).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT status FROM chat_child_sessions WHERE talk_chat_id = ?").get(roomId),
    ).toEqual({ status: "archived" });
  });

  it("сообщает владельцу минимальным событием и не повторяет его", () => {
    const notes = db
      .prepare("SELECT text FROM notifications WHERE task_id = ? AND type = 'task_room_archived'")
      .all(TASK) as Array<{ text: string }>;
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].text).toContain("Задача для архива");
    expect(notes[0].text).not.toContain("первое");
    const second = archiveTaskRoom(TASK, { reason: "задача выполнена" });
    expect(second.archived).toBe(false);
    expect(second.notices).toBe(0);
    expect(
      (db.prepare("SELECT count(*) AS n FROM notifications WHERE task_id = ?").get(TASK) as { n: number }).n,
    ).toBeGreaterThan(0);
  });

  it("архивная комната не принимает новых сообщений", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${roomId}/messages`,
      headers: ownerAuth,
      payload: { text: "ещё одну реплику" },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe("chat_archived");
    expect(body.draft_kept).toBe(true);
    expect(
      db.prepare("SELECT count(*) AS n FROM chat_messages WHERE chat_id = ? AND text = ?").get(roomId, "ещё одну реплику"),
    ).toEqual({ n: 0 });
  });

  it("работа слоту в архивную комнату не доставляется, а закрытие задачи архивирует её", () => {
    expect(ensureSlotAssignment({ taskId: TASK, slotId: SLOT, role: "builder" })).toBeNull();

    db.prepare("INSERT INTO tasks (id, title, creator_id, status) VALUES ('archive-task-2', 'Вторая', ?, 'active')").run(ownerId);
    const secondRoom = ensureTaskRoom("archive-task-2") as string;
    db.prepare(
      "INSERT INTO chat_messages (id, chat_id, from_user_id, text) VALUES ('archive-msg-2', ?, ?, 'ещё')",
    ).run(secondRoom, ownerId);
    db.prepare(
      `INSERT INTO chat_message_queue (id, chat_id, role_id, delivery_id, message_id, payload_json, status)
       VALUES ('archive-q-2', ?, ?, 'archive-d-2', 'archive-msg-2', '{}', 'pending')`,
    ).run(secondRoom, ownerId);
    const report = archiveTaskRoom("archive-task-2", { reason: "задача выполнена" });
    expect(report.archived).toBe(true);
    expect(report.queue).toBe(1);
    expect(roomArchivedAt(secondRoom)).toBeTruthy();

    // Возврат в работу архив не поднимает (владелец 08.11.2026): в комнате
    // уже ничего не продолжить, работу заводят новой задачей.
    setTaskRoomClosed("archive-task-2", false);
    expect(roomArchivedAt(secondRoom)).toBeTruthy();

    // А работа по слоту в архивной комнате объясняется словами, не молчанием.
    refuseArchivedWork("archive-task-2");
    const refused = db
      .prepare("SELECT text FROM notifications WHERE task_id = 'archive-task-2' AND text LIKE 'Сессия не создалась%'")
      .all() as Array<{ text: string }>;
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0].text).toContain("Пересоздайте задачу заново");
    db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(secondRoom);
    db.prepare("DELETE FROM chat_members WHERE chat_id = ?").run(secondRoom);
    db.prepare("DELETE FROM chats WHERE id = ?").run(secondRoom);
    db.prepare("DELETE FROM notifications WHERE task_id = 'archive-task-2'").run();
    db.prepare("DELETE FROM tasks WHERE id = 'archive-task-2'").run();
  });
});
