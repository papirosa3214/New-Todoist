// Сторож топологии чатов (спецификация 08.11.2026, §10): потеря связи ребёнка с
// комнатой задачи, неверный адресат, зависшая передача, доставка в архив.
// Проверка — пробным ходом: сторож обязан видеть нарочно сломанную связь и
// обязан молчать, когда всё на месте.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { checkChatTopology, probeChatTopology } from "../src/lib/chatTopologyWatcher.js";
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

const TASK = "topology-task";
const OTHER_TASK = "topology-task-other";
const PLAN = "topology-plan";
const SLOT = "topology-slot";
const OTHER_SLOT = "topology-slot-other";
const ROLE = "role_builder";

describe("Сторож топологии чатов", () => {
  let app: FastifyInstance;
  let ownerId = "";
  let personal = "";
  let room = "";
  let baseline: ReturnType<typeof checkChatTopology>;

  const insert = (sql: string, params: unknown[]) => db.prepare(sql).run(...(params as never[]));

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "TopologyOwner", email: `topology-${Date.now()}@test`, password: "password123" },
    });
    ownerId = res.json().user.id;
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run("owner", ownerId);

    for (const id of [TASK, OTHER_TASK]) {
      insert("INSERT INTO tasks (id, title, creator_id) VALUES (?, ?, ?)", [id, "Топология", ownerId]);
    }
    insert(
      "INSERT INTO task_collaboration_plans (id, task_id, revision, version, status, profile, created_by) VALUES (?, ?, 1, 1, ?, ?, ?)",
      [PLAN, TASK, "approved", "single_executor", ownerId],
    );
    insert(
      "INSERT INTO subtasks (id, task_id, title, done, position, collaboration_plan_id, plan_node_key) VALUES (?, ?, ?, 0, 1, ?, ?)",
      [SLOT, TASK, "Сборка", PLAN, "build"],
    );
    insert("INSERT INTO subtasks (id, task_id, title, done, position) VALUES (?, ?, ?, 0, 1)", [
      OTHER_SLOT,
      OTHER_TASK,
      "Чужой слот",
    ]);

    personal = ensurePersonalRoom(ROLE) as string;
    room = ensureTaskRoom(TASK) as string;
  });

  afterAll(async () => {
    db.prepare("DELETE FROM chat_child_sessions WHERE task_id IN (?, ?)").run(TASK, OTHER_TASK);
    db.prepare("DELETE FROM chat_message_queue WHERE chat_id = ?").run(room);
    db.prepare("DELETE FROM chat_messages WHERE chat_id IN (?, ?)").run(room, personal);
    db.prepare("DELETE FROM chat_room_topics WHERE room_chat_id = ?").run(room);
    db.prepare("DELETE FROM chat_members WHERE chat_id IN (?, ?)").run(room, personal);
    db.prepare("DELETE FROM chats WHERE task_id = ?").run(TASK);
    db.prepare("DELETE FROM subtasks WHERE id IN (?, ?)").run(SLOT, OTHER_SLOT);
    db.prepare("DELETE FROM task_collaboration_plans WHERE id = ?").run(PLAN);
    db.prepare("DELETE FROM tasks WHERE id IN (?, ?)").run(TASK, OTHER_TASK);
    await app.close();
  });

  it("видит нарочно сломанную связь пробным ходом", () => {
    expect(probeChatTopology()).toEqual({ ok: true });
  });

  it("молчит, когда всё на месте", () => {
    insert(
      `INSERT INTO chat_child_sessions (id, kind, parent_chat_id, talk_chat_id, role_id, task_id, slot_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["topology-child", "assignment", personal, room, ROLE, TASK, SLOT, "assigned"],
    );
    baseline = checkChatTopology();
    expect(baseline.findings).toEqual({ children: 0, addressee: 0, handoff: 0, archived: 0 });
    expect(baseline.ok).toBe(true);
  });

  it("ловит потерю связи ребёнка с комнатой задачи", () => {
    db.prepare("UPDATE chat_child_sessions SET talk_chat_id = ? WHERE id = ?").run(personal, "topology-child");
    const report = checkChatTopology();
    expect(report.findings.children).toBe(baseline.findings.children + 1);
    expect(report.ok).toBe(false);
    db.prepare("UPDATE chat_child_sessions SET talk_chat_id = ? WHERE id = ?").run(room, "topology-child");
  });

  it("ловит ребёнка, привязанного к комнате другой задачи", () => {
    db.prepare("UPDATE chat_child_sessions SET task_id = ? WHERE id = ?").run(OTHER_TASK, "topology-child");
    expect(checkChatTopology().findings.children).toBe(baseline.findings.children + 1);
    db.prepare("UPDATE chat_child_sessions SET task_id = ? WHERE id = ?").run(TASK, "topology-child");
  });

  it("ловит адресата из чужой задачи", () => {
    insert(
      `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, recipient_subtask_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["topology-msg", ownerId, "Смотри", "chat", room, OTHER_SLOT],
    );
    const report = checkChatTopology();
    expect(report.findings.addressee).toBe(baseline.findings.addressee + 1);
    db.prepare("DELETE FROM chat_messages WHERE id = ?").run("topology-msg");
  });

  it("ловит зависшую передачу", () => {
    db.prepare(
      "UPDATE chat_child_sessions SET status = ?, updated_at = datetime('now', '-2 days') WHERE id = ?",
    ).run("delivered", "topology-child");
    const report = checkChatTopology();
    expect(report.findings.handoff).toBe(baseline.findings.handoff + 1);
    db.prepare("UPDATE chat_child_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
      "assigned",
      "topology-child",
    );
  });

  it("ловит доставку в архивную комнату", () => {
    db.prepare("UPDATE chats SET archived_at = datetime('now') WHERE id = ?").run(room);
    insert(
      "INSERT INTO chat_message_queue (id, chat_id, role_id, delivery_id, payload_json) VALUES (?, ?, ?, ?, ?)",
      ["topology-queue", room, ROLE, "topology-delivery", "{}"],
    );
    const report = checkChatTopology();
    expect(report.findings.archived).toBe(baseline.findings.archived + 1);
    db.prepare("DELETE FROM chat_message_queue WHERE id = ?").run("topology-queue");
    db.prepare("UPDATE chats SET archived_at = NULL WHERE id = ?").run(room);
    expect(checkChatTopology().ok).toBe(true);
  });
});
