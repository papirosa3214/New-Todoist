// Выжимка передачи работы (спецификация 08.11.2026, §7, критерии 8–10):
// предел считается от окна модели, граница фиксируется, повтор идемпотентен,
// сбой сжатия не трогает историю комнаты.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  handoffBudget,
  handoffDigest,
  HANDOFF_CHARS_MAX,
  HANDOFF_CHARS_MIN,
} from "../src/lib/slotHandoffDigest.js";
import { ensureTaskRoom } from "../src/lib/projectTopics.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

const TASK = "digest-task";
const PLAN = "digest-plan";
const SLOTS = ["digest-slot-1", "digest-slot-2", "digest-slot-3"];

describe("Выжимка передачи работы", () => {
  let app: FastifyInstance;
  let ownerId = "";
  let room = "";

  const insert = (sql: string, params: unknown[]) => db.prepare(sql).run(...(params as never[]));

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "DigestOwner", email: `digest-${Date.now()}@test`, password: "password123" },
    });
    ownerId = res.json().user.id;
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run("owner", ownerId);

    insert("INSERT INTO tasks (id, title, creator_id) VALUES (?, ?, ?)", [TASK, "Выжимка", ownerId]);
    insert(
      "INSERT INTO task_collaboration_plans (id, task_id, revision, version, status, profile, created_by) VALUES (?, ?, 1, 1, ?, ?, ?)",
      [PLAN, TASK, "approved", "single_executor", ownerId],
    );
    const node = db.prepare(
      "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, expected_result) VALUES (?, ?, ?, ?, ?)",
    );
    const long = "Сделал разметку экрана, проверил состояния и прогнал сборку. ".repeat(40);
    for (const [index, slotId] of SLOTS.entries()) {
      node.run(`${slotId}-node`, PLAN, `step-${index + 1}`, "builder", "Результат");
      insert(
        "INSERT INTO subtasks (id, task_id, title, done, position, collaboration_plan_id, plan_node_key, result) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
        [slotId, TASK, `Этап ${index + 1}`, index + 1, PLAN, `step-${index + 1}`, `approved: ${long}`],
      );
      insert(
        `INSERT INTO subtask_artifact_versions (id, subtask_id, artifact_key, summary, version_no, artifact_type, artifact_format, payload_json, created_by, status)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [`${slotId}-art`, slotId, `screen-${index + 1}`, long, "document", "markdown", "{}", ownerId, "accepted"],
      );
    }
    room = ensureTaskRoom(TASK) as string;
    insert("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, ?, ?)", [
      "digest-msg-1",
      ownerId,
      "Начинаем",
      "chat",
      room,
    ]);
  });

  afterAll(async () => {
    db.prepare("DELETE FROM slot_handoffs WHERE task_id = ?").run(TASK);
    db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(room);
    db.prepare("DELETE FROM chat_room_topics WHERE room_chat_id = ?").run(room);
    db.prepare("DELETE FROM chat_members WHERE chat_id = ?").run(room);
    db.prepare("DELETE FROM chats WHERE task_id = ?").run(TASK);
    db.prepare("DELETE FROM subtask_artifact_versions WHERE subtask_id IN (?, ?, ?)").run(...SLOTS);
    db.prepare("DELETE FROM subtasks WHERE id IN (?, ?, ?)").run(...SLOTS);
    db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id = ?").run(PLAN);
    db.prepare("DELETE FROM task_collaboration_plans WHERE id = ?").run(PLAN);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(TASK);
    await app.close();
  });

  it("предел считается от окна модели, а не от числа сообщений", () => {
    expect(handoffBudget(8_000)).toBe(1_600);
    expect(handoffBudget(200_000)).toBe(HANDOFF_CHARS_MAX);
    expect(handoffBudget(1_000)).toBe(HANDOFF_CHARS_MIN);
    expect(handoffBudget(null)).toBe(6_400);
  });

  it("выжимка влезает в предел окна и несёт доказательства", () => {
    const digest = handoffDigest(TASK, { roomId: room, windowTokens: 8_000 });
    expect(digest.state).toBe("ready");
    expect(digest.text.length).toBeLessThanOrEqual(digest.budget + 80);
    expect(digest.text).toContain("артефакт screen-1");
    expect(digest.evidence.join(" ")).toContain("слот step-1");
    expect(digest.boundary).toBeTruthy();
    const stored = db
      .prepare("SELECT state, window_tokens, budget_chars, digest FROM slot_handoffs WHERE task_id = ?")
      .all(TASK) as Array<{ state: string; window_tokens: number; budget_chars: number; digest: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ state: "ready", window_tokens: 8_000, budget_chars: 1_600 });
    expect(stored[0].digest).toBe(digest.text);
  });

  it("меньшее окно даёт более короткую выжимку", () => {
    db.prepare("DELETE FROM slot_handoffs WHERE task_id = ?").run(TASK);
    const tight = handoffDigest(TASK, { roomId: room, windowTokens: 8_000 });
    db.prepare("DELETE FROM slot_handoffs WHERE task_id = ?").run(TASK);
    const wide = handoffDigest(TASK, { roomId: room, windowTokens: 400_000 });
    expect(wide.budget).toBeGreaterThan(tight.budget);
    expect(wide.text.length).toBeGreaterThan(tight.text.length);
  });

  it("повтор с той же границей берёт записанную выжимку и не плодит строки", () => {
    db.prepare("DELETE FROM slot_handoffs WHERE task_id = ?").run(TASK);
    const first = handoffDigest(TASK, { roomId: room, windowTokens: 8_000 });
    expect(first.text).not.toBe("ЗАКЭШИРОВАНО");
    // Подменяем запись: если повтор считает заново, подмену он не увидит.
    db.prepare("UPDATE slot_handoffs SET digest = ? WHERE task_id = ?").run("ЗАКЭШИРОВАНО", TASK);
    const second = handoffDigest(TASK, { roomId: room, windowTokens: 8_000 });
    expect(second.text).toBe("ЗАКЭШИРОВАНО");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM slot_handoffs WHERE task_id = ?").get(TASK) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("новое событие в комнате сдвигает границу и даёт новую выжимку", () => {
    const before = handoffDigest(TASK, { roomId: room, windowTokens: 8_000 });
    insert("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, ?, ?)", [
      "digest-msg-2",
      ownerId,
      "Ещё одно событие",
      "chat",
      room,
    ]);
    const after = handoffDigest(TASK, { roomId: room, windowTokens: 8_000 });
    expect(after.boundary).not.toBe(before.boundary);
    expect(after.evidence).not.toEqual(before.evidence);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM slot_handoffs WHERE task_id = ?").get(TASK) as { n: number };
    expect(rows.n).toBe(2);
  });

  it("без данных о модели пишет причину и не меняет историю комнаты", () => {
    insert("INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, ?, ?)", [
      "digest-msg-3",
      ownerId,
      "Событие перед сбоем",
      "chat",
      room,
    ]);
    const countBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(room) as { n: number }
    ).n;
    const digest = handoffDigest(TASK, { roomId: room, windowTokens: Number.NaN, roleKey: null });
    expect(digest.state).toBe("failed");
    expect(digest.reason).toContain("окно модели неизвестно");
    expect(digest.text).toBe("");
    const countAfter = (
      db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(room) as { n: number }
    ).n;
    expect(countAfter).toBe(countBefore);
    const failed = db
      .prepare("SELECT state, reason FROM slot_handoffs WHERE task_id = ? AND state = ?")
      .all(TASK, "failed") as Array<{ state: string; reason: string }>;
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toContain("окно модели неизвестно");
  });
});
