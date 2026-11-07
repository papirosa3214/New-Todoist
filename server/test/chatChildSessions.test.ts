// Дочерние сессии личной комнаты (владелец 08.11.2026): назначение слота —
// отдельная запись со своим ID, а разговор идёт в общей комнате задачи.
// Карточка назначения не является сообщением: во вход модели она не попадает
// вовсе (docs/2026-11-08-role-slot-chat-branches-spec.md §4–6).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  assignmentsOf,
  childSessionOfSlot,
  ensureSlotAssignment,
  markAssignmentAnswered,
} from "../src/lib/chatChildren.js";
import { ensurePersonalRoom } from "../src/lib/chatRooms.js";
import { ensureTaskRoom } from "../src/lib/projectTopics.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

const TASK = "child-task";
const PLAN = "child-plan";
const SLOT = "child-slot";
const SLOT_TWO = "child-slot-2";

describe("Назначение слота как дочерняя сессия личной комнаты", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "ChildOwner", email: `child-${Date.now()}@test`, password: "password123" },
    });
    const body = res.json();
    ownerId = body.user.id;
    ownerAuth = { authorization: `Bearer ${body.token}` };
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);

    db.prepare("INSERT INTO tasks (id, title, creator_id, status) VALUES (?, 'Задача с двумя слотами', ?, 'active')").run(TASK, ownerId);
    db.prepare(
      "INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, created_by) VALUES (?, ?, 1, 'approved', 'manual', ?)",
    ).run(PLAN, TASK, ownerId);
    const node = db.prepare(
      "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, expected_result) VALUES (?, ?, ?, ?, ?)",
    );
    node.run("child-node-1", PLAN, "impl", "builder", "Работающий код");
    node.run("child-node-2", PLAN, "qa", "builder", "Проверка");
    const sub = db.prepare(
      "INSERT INTO subtasks (id, task_id, title, done, position, collaboration_plan_id, plan_node_key) VALUES (?, ?, ?, 0, ?, ?, ?)",
    );
    sub.run(SLOT, TASK, "Сборка", 0, PLAN, "impl");
    sub.run(SLOT_TWO, TASK, "Проверка", 1, PLAN, "qa");
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("задание создаёт одну карточку, разговор идёт в комнате задачи", () => {
    const first = ensureSlotAssignment({ taskId: TASK, slotId: SLOT, role: "builder", attemptNo: 1 });
    expect(first).toBeTruthy();
    const card = childSessionOfSlot(SLOT)!;
    expect(card.kind).toBe("assignment");
    expect(card.status).toBe("delivered");
    expect(card.role_key).toBe("builder");
    expect(card.task_id).toBe(TASK);
    // Родитель — личная комната роли, разговор — общая комната задачи.
    expect(card.parent_chat_id).toBe(ensurePersonalRoom("role_builder"));
    expect(card.talk_chat_id).toBe(ensureTaskRoom(TASK));
    expect(card.parent_chat_id).not.toBe(card.talk_chat_id);
  });

  it("повтор назначения продолжает связь: второй карточки нет, попытка растёт", () => {
    const before = ensureSlotAssignment({ taskId: TASK, slotId: SLOT, role: "builder", attemptNo: 1 })!;
    const again = ensureSlotAssignment({ taskId: TASK, slotId: SLOT, role: "builder", attemptNo: 3 })!;
    expect(again.id).toBe(before.id);
    expect(again.created).toBe(false);
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM chat_child_sessions WHERE kind='assignment' AND slot_id=?")
      .get(SLOT) as { n: number };
    expect(rows.n).toBe(1);
    const card = childSessionOfSlot(SLOT)!;
    expect(card.attempt_no).toBe(3);
    expect(card.context_generation).toBeGreaterThan(1);
  });

  it("у роли с двумя слотами две карточки, у чужой комнаты — ни одной", () => {
    ensureSlotAssignment({ taskId: TASK, slotId: SLOT_TWO, role: "builder", attemptNo: 1 });
    const personal = ensurePersonalRoom("role_builder")!;
    const mine = assignmentsOf(personal);
    expect(mine.map((card) => card.slot_id).sort()).toEqual([SLOT, SLOT_TWO].sort());
    // Каждая карточка ведёт в ту же комнату задачи, а не в личную комнату.
    expect(new Set(mine.map((card) => card.talk_chat_id))).toEqual(new Set([ensureTaskRoom(TASK)]));
    const stranger = ensurePersonalRoom("role_critic_verifier");
    if (stranger) expect(assignmentsOf(stranger)).toHaveLength(0);
  });

  it("карточка не появляется в переписке личной комнаты", async () => {
    const personal = ensurePersonalRoom("role_builder")!;
    const messagesBefore = (db
      .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id=?")
      .get(personal) as { n: number }).n;
    ensureSlotAssignment({ taskId: TASK, slotId: SLOT, role: "builder", attemptNo: 4 });
    const messagesAfter = (db
      .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id=?")
      .get(personal) as { n: number }).n;
    expect(messagesAfter).toBe(messagesBefore);
    const feed = await app.inject({ method: "GET", url: `/api/chats/${personal}/messages`, headers: ownerAuth });
    expect(feed.statusCode).toBe(200);
    expect(feed.json().messages ?? []).toHaveLength(0);
  });

  it("отдаёт карточки по адресу комнаты и закрывает их после сдачи слота", async () => {
    const personal = ensurePersonalRoom("role_builder")!;
    const res = await app.inject({ method: "GET", url: `/api/chats/${personal}/children`, headers: ownerAuth });
    expect(res.statusCode).toBe(200);
    const children = res.json().children as Array<{ slot_id: string; status: string }>;
    expect(children).toHaveLength(2);
    expect(markAssignmentAnswered(SLOT)).toBe(1);
    expect(childSessionOfSlot(SLOT)!.status).toBe("answered");
    // Повтор подтверждения ничего не меняет.
    expect(markAssignmentAnswered(SLOT)).toBe(0);
  });
});
