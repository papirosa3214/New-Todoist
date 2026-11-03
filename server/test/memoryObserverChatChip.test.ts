// Чип «Память обновлена» в ленте при wrote (владелец 03.11.2026).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

function bagOfWords(text: string): number[] {
  const vec = new Array(64).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2)) {
    let h = 0;
    for (const ch of word.slice(0, 5)) h = (h * 31 + ch.charCodeAt(0)) % 64;
    vec[h] += 1;
  }
  return vec;
}

vi.mock("../src/lib/embeddingClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/embeddingClient.js")>();
  return {
    ...actual,
    getEmbeddings: vi.fn(async (input: string) => ({
      embeddings: bagOfWords(String(input)),
      dim: 64,
      durationMs: 1,
    })),
  };
});

const aiReply = vi.fn(async () => JSON.stringify({ action: "skip" }));
vi.mock("../src/lib/runtimeAi.js", () => ({
  callRuntimeModel: (...args: unknown[]) => aiReply(...args),
}));

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");
const { setSetting } = await import("../src/lib/serverSettings.js");
const { observeSlotMemory } = await import("../src/runtime/slotMemoryObserver.js");
const { saveSlotSnapshot } = await import("../src/runtime/slotWorkSnapshot.js");
const { ensurePersonalRoom } = await import("../src/lib/chatRooms.js");
const { isQuietSystemMessage, visibleChatSql } = await import("../src/lib/serviceNoise.js");
const { loadChatMessage } = await import("../src/lib/chatMessages.js");
const { collectChatHistory } = await import("../src/runtime/chatCheckpoint.js");

describe("чип памяти в чате после observeSlotMemory", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "MemChipOwner",
        email: `memchip-${Date.now()}@test`,
        password: "password123",
      },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    db.prepare("DELETE FROM memory_observer_events").run();
    db.prepare("DELETE FROM memories").run();
    aiReply.mockReset();
    setSetting("memory_observer_enabled", true, "test");
    setSetting("memory_observer_min_confidence", 60, "test");
  });

  function seedDoneSlot(title: string) {
    const taskId = crypto.randomUUID();
    const subtaskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run(taskId, title);
    db.prepare(
      "INSERT INTO attempts (id, task_id, executor_id, started_at) VALUES (?, ?, 'role_builder', datetime('now'))",
    ).run(attemptId, taskId);
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, done, position, agent_id, agent_state, current_attempt_id) VALUES (?, ?, 'шаг', 0, 0, 'role_builder', 'in_progress', ?)",
    ).run(subtaskId, taskId, attemptId);
    db.prepare("UPDATE attempts SET subtask_id = ? WHERE id = ?").run(subtaskId, attemptId);
    const done = saveSlotSnapshot({
      subtaskId,
      attemptId,
      reason: "done",
      done: "готово",
      complete: true,
    });
    return { taskId, subtaskId, snapshot: done.snapshot };
  }

  it("при wrote кладёт видимый system-чип memory_update в личную комнату роли", async () => {
    const personal = ensurePersonalRoom("role_builder");
    expect(personal).toBeTruthy();
    const { snapshot } = seedDoneSlot("Чип памяти");
    aiReply.mockResolvedValueOnce(
      JSON.stringify({
        action: "remember",
        title: "Не дублируй FTS",
        text: "Сначала проверь FTS, потом эмбеддинги.",
        kind: "lesson",
        confidence: 0.9,
      }),
    );

    const result = await observeSlotMemory(snapshot);
    expect(result.wrote).toBe(true);

    const sql =
      "SELECT id, text, message_type, steps FROM chat_messages " +
      "WHERE chat_id = ? AND message_type = 'system' " +
      "AND json_valid(steps) AND json_type(steps, '$.memory_update') = 'object' " +
      "ORDER BY rowid DESC LIMIT 1";
    const row = db.prepare(sql).get(personal) as
      | { id: string; text: string; message_type: string; steps: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.text).toContain("Память обновлена");
    const steps = JSON.parse(row!.steps);
    expect(steps.memory_update.title).toBe("Не дублируй FTS");
    expect(steps.memory_update.kind).toBe("lesson");

    const formatted = loadChatMessage(row!.id);
    expect(formatted?.memory_update?.title).toBe("Не дублируй FTS");
    expect(isQuietSystemMessage(formatted)).toBe(false);
    const visibleSql = `SELECT id FROM chat_messages m WHERE m.id = ? AND ${visibleChatSql("m")}`;
    expect(db.prepare(visibleSql).get(row!.id)).toEqual({ id: row!.id });
  });

  it("на skip чип в чат не кладёт", async () => {
    const personal = ensurePersonalRoom("role_builder");
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(personal) as {
        n: number;
      }
    ).n;
    const { snapshot } = seedDoneSlot("Без чипа");
    aiReply.mockResolvedValueOnce(JSON.stringify({ action: "skip" }));
    const result = await observeSlotMemory(snapshot);
    expect(result.wrote).toBe(false);
    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(personal) as {
        n: number;
      }
    ).n;
    expect(after).toBe(before);
  });

  it("не пишет чип в тему задачи и не в dm ролей между собой", async () => {
    const personal = ensurePersonalRoom("role_builder");
    expect(personal).toBeTruthy();
    const { taskId, snapshot } = seedDoneSlot("Только личка");
    const owner = (
      db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get() as {
        id: string;
      }
    ).id;
    const projectId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    const topicId = crypto.randomUUID();
    db.prepare("INSERT INTO projects(id, name, owner_id) VALUES (?, ?, ?)").run(
      projectId,
      "Чип только личка",
      owner,
    );
    db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(projectId, taskId);
    db.prepare(
      "INSERT INTO chats(id, kind, created_by, project_id) VALUES (?, 'group', ?, ?)",
    ).run(groupId, owner, projectId);
    db.prepare(
      "INSERT INTO chats(id, kind, created_by, task_id, parent_chat_id, project_id) VALUES (?, 'group', ?, ?, ?, ?)",
    ).run(topicId, owner, taskId, groupId, projectId);
    db.prepare("INSERT OR IGNORE INTO chat_members(chat_id, member_id) VALUES (?, ?)").run(
      topicId,
      "role_builder",
    );
    const dmId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO chats(id, kind, created_by, room_kind) VALUES (?, 'direct', ?, 'dm')",
    ).run(dmId, "role_builder");
    db.prepare("INSERT INTO chat_members(chat_id, member_id) VALUES (?, ?)").run(dmId, "role_builder");
    db.prepare("INSERT INTO chat_members(chat_id, member_id) VALUES (?, ?)").run(
      dmId,
      "role_architect",
    );

    const topicBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(topicId) as {
        n: number;
      }
    ).n;
    const dmBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(dmId) as {
        n: number;
      }
    ).n;

    aiReply.mockResolvedValueOnce(
      JSON.stringify({
        action: "remember",
        title: "Только владельцу",
        text: "Урок не для переписки ролей.",
        kind: "lesson",
        confidence: 0.95,
      }),
    );
    expect((await observeSlotMemory(snapshot)).wrote).toBe(true);

    const chipSql =
      "SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ? AND message_type = 'system' " +
      "AND json_valid(steps) AND json_type(steps, '$.memory_update') = 'object'";
    expect((db.prepare(chipSql).get(personal) as { n: number }).n).toBeGreaterThan(0);
    expect((db.prepare(chipSql).get(topicId) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(topicId) as { n: number }).n).toBe(
      topicBefore,
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?").get(dmId) as { n: number }).n).toBe(
      dmBefore,
    );
  });

  it("чип не попадает в collectChatHistory роли и не ставится в очередь", async () => {
    const personal = ensurePersonalRoom("role_builder");
    expect(personal).toBeTruthy();
    const { snapshot } = seedDoneSlot("Невидимость чипа");
    aiReply.mockResolvedValueOnce(
      JSON.stringify({
        action: "remember",
        title: "Скрытый урок",
        text: "Роль не должна видеть чип в истории.",
        kind: "lesson",
        confidence: 0.92,
      }),
    );
    expect((await observeSlotMemory(snapshot)).wrote).toBe(true);

    const history = collectChatHistory({ chatId: personal!, roleId: "role_builder" });
    expect(history.ownerMessages.some((m) => m.text.includes("Память обновлена"))).toBe(false);
    expect(history.roleMessages.some((m) => m.text.includes("Память обновлена"))).toBe(false);

    const queued = db
      .prepare(
        "SELECT COUNT(*) AS n FROM chat_message_queue WHERE chat_id = ? AND message_id IN (SELECT id FROM chat_messages WHERE chat_id = ? AND message_type = 'system')",
      )
      .get(personal, personal) as { n: number };
    expect(queued.n).toBe(0);
  });
});
