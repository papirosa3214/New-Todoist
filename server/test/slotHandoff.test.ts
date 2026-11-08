// Передача работы от слота к слоту (владелец 08.11.2026; спецификация
// docs/2026-11-08-role-slot-chat-branches-spec.md §7): преемник получает итог
// предыдущих слотов и сжатую часть разговора, а не весь сырой лог.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { conversationDigest, handoffRecords, handoffText, insertHandoffCard } from "../src/lib/slotHandoff.js";
import { ensureTaskRoom, topicContext } from "../src/lib/projectTopics.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

const TASK = "handoff-task";
const PLAN = "handoff-plan";
const OWNER = "handoff-owner";

function insert(statement: string, values: unknown[]) {
  db.prepare(statement).run(...(values as never[]));
}

describe("Передача работы слоту идёт итогом, а не сырым логом", () => {
  let roomId = "";
  let builderSlot = "";

  beforeAll(async () => {
    await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    insert(
      "INSERT INTO users (id, name, role, type, email, password_hash) VALUES (?, 'Владелец передачи', 'owner', 'human', 'handoff@test', '!test')",
      [OWNER],
    );
    db.prepare("INSERT OR IGNORE INTO users (id, name, role, type, email, password_hash) VALUES ('taskflow_system', 'TaskFlow', 'service', 'human', 'system@test', '!test')").run();
    insert("INSERT INTO tasks (id, title, creator_id) VALUES (?, 'Передача', ?)", [TASK, OWNER]);
    insert(
      "INSERT INTO task_collaboration_plans (id, task_id, revision, version, status, profile, created_by) VALUES (?, ?, 1, 1, 'approved', 'single_executor', ?)",
      [PLAN, TASK, OWNER],
    );
    insert(
      "INSERT INTO task_collaboration_plan_nodes (plan_id, slot_key, role_key, expected_result) VALUES (?, 'build', 'builder', 'Собранный экран')",
      [PLAN],
    );
    insert(
      "INSERT INTO subtasks (id, task_id, title, done, position, collaboration_plan_id, plan_node_key, result) VALUES (?, ?, 'Сборка', 1, 1, ?, 'build', ?)",
      ["handoff-slot-build", TASK, PLAN, "approved: собрал, проверил"],
    );
    insert(
      `INSERT INTO subtask_artifact_versions (id, subtask_id, version_no, artifact_key, artifact_type, artifact_format, summary, payload_json, evidence_json, status, created_by, created_at)
       VALUES ('handoff-art', 'handoff-slot-build', 1, 'screen', 'code', 'text', 'Экран собран, тесты зелёные', '{}', '[]', 'accepted', 'role_builder', datetime('now'))`,
      [],
    );
    roomId = ensureTaskRoom(TASK) ?? "";
    expect(roomId).not.toBe("");
    // Разговор комнаты: двадцать реплик — прежний сырой хвост.
    for (let index = 0; index < 20; index += 1) {
      insert(
        `INSERT INTO chat_messages (id, chat_id, task_id, from_user_id, text, channel, created_at)
         VALUES (?, ?, ?, ?, ?, 'chat', datetime('now', ?))`,
        [`handoff-msg-${index}`, roomId, TASK, OWNER, `Реплика ${index}`, `-${20 - index} minutes`],
      );
    }
    insert(
      `INSERT INTO chat_messages (id, chat_id, task_id, from_user_id, text, channel, message_type, steps)
       VALUES ('handoff-card-src', ?, ?, 'taskflow_system', 'Оркестратор → Разработчик: вопрос в очереди', 'chat', 'system', ?)`,
      [roomId, TASK, JSON.stringify({ coordination: { question_id: "x" } })],
    );
    builderSlot = "handoff-slot-build";
  });

  afterAll(() => {
    db.prepare("DELETE FROM chat_messages WHERE chat_id = ? OR task_id = ?").run(roomId, TASK);
    db.prepare("DELETE FROM chat_room_topics WHERE room_chat_id = ?").run(roomId);
    db.prepare("DELETE FROM chat_members WHERE chat_id = ?").run(roomId);
    db.prepare("DELETE FROM chats WHERE id = ?").run(roomId);
    db.prepare("DELETE FROM subtask_artifact_versions WHERE subtask_id = ?").run(builderSlot);
    db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(TASK);
    db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id = ?").run(PLAN);
    db.prepare("DELETE FROM task_collaboration_plans WHERE task_id = ?").run(TASK);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(TASK);
  });

  it("передача несёт итог и артефакт закрытого слота", () => {
    const records = handoffRecords(TASK);
    expect(records).toHaveLength(1);
    expect(records[0].slot_key).toBe("build");
    expect(records[0].verdict).toBe("approved");
    expect(records[0].artifact_summary).toBe("Экран собран, тесты зелёные");
    const text = handoffText(TASK);
    expect(text).toContain("approved");
    expect(text).toContain("артефакт screen");
    expect(text).not.toContain("Реплика");
  });

  it("сжатый разговор короче сырого лога и без служебных карточек", () => {
    const digest = conversationDigest(TASK, roomId);
    const lines = digest.split("\n").filter((line) => line.startsWith("- "));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(digest).not.toContain("вопрос в очереди");
    // Сырой вариант в контексте комнаты остаётся по умолчанию.
    const raw = topicContext(TASK);
    expect(raw).toContain("Реплика 19");
  });

  it("постановка этапа берёт сжатый вариант, а не строки лога", () => {
    const digestContext = topicContext(TASK, { conversation: "digest" });
    expect(digestContext).toContain("сжато");
    expect(digestContext).not.toContain("Реплика 19");
  });

  it("карточка передачи пишется в комнату задачи и не дублируется", () => {
    insertHandoffCard(TASK, roomId, builderSlot);
    insertHandoffCard(TASK, roomId, builderSlot);
    const cards = db
      .prepare(
        "SELECT text, json_extract(steps, '$.handoff.artifact_key') AS artifact FROM chat_messages WHERE chat_id = ? AND json_extract(steps, '$.handoff.slot_id') = ?",
      )
      .all(roomId, builderSlot) as Array<{ text: string; artifact: string | null }>;
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toContain("этап закрыт");
    expect(cards[0].artifact).toBe("screen");
  });
});
