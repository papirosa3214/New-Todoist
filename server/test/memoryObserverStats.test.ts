// Журнал исходов наблюдателя + настройки эмбеддингов (владелец 03.11.2026).
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
    getEmbeddings: vi.fn(async (input: string) => ({ embeddings: bagOfWords(String(input)), dim: 64, durationMs: 1 })),
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
const { memoryObserverStats, recordMemoryObserverEvent } = await import("../src/lib/memoryObserverLog.js");
const { saveSlotSnapshot } = await import("../src/runtime/slotWorkSnapshot.js");

describe("статистика наблюдателя памяти", () => {
  let app: FastifyInstance;
  let owner: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "MemObsOwner", email: `memobs-${Date.now()}@test`, password: "password123" },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    owner = { authorization: `Bearer ${reg.json().token}` };
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    db.prepare("DELETE FROM memory_observer_events").run();
    db.prepare("DELETE FROM memories").run();
    aiReply.mockReset();
    aiReply.mockResolvedValue(JSON.stringify({ action: "skip" }));
    setSetting("memory_observer_enabled", true, "test");
    setSetting("memory_observer_min_confidence", 60, "test");
  });

  it("миграция подняла журнал memory_observer_events", () => {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_observer_events'")
      .get();
    expect(table).toBeTruthy();
  });

  it("record + memoryObserverStats считают исходы и отдают embedding", async () => {
    recordMemoryObserverEvent({ outcome: "skip", role_key: "builder", detail: "noise" });
    recordMemoryObserverEvent({
      outcome: "wrote",
      role_key: "builder",
      title: "Урок",
      detail: "текст",
      confidence: 0.9,
    });
    setSetting("embedding_model", "bge-m3-embed:latest", "test");
    setSetting("memory_duplicate_similarity", 93, "test");
    const stats = await memoryObserverStats(7);
    expect(stats.counts.skip).toBe(1);
    expect(stats.counts.wrote).toBe(1);
    expect(stats.counts.total).toBe(2);
    expect(stats.recent).toHaveLength(2);
    expect(stats.embedding.model).toBe("bge-m3-embed:latest");
    expect(stats.embedding.ok).toBe(true);
    expect(stats.embedding.dim).toBe(64);
    expect(stats.duplicate_similarity).toBe(93);
  });

  it("GET /api/admin/memory-observer/stats только владельцу", async () => {
    recordMemoryObserverEvent({ outcome: "wrote", role_key: "builder", title: "x" });
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/memory-observer/stats",
      headers: { authorization: `Bearer ${app.jwt.sign({ id: "role_builder" })}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/memory-observer/stats?days=7",
      headers: owner,
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.counts.wrote).toBe(1);
    expect(body.embedding.model).toBeTruthy();
    expect(body.recent[0].outcome).toBe("wrote");
  });

  it("observeSlotMemory пишет low_confidence в журнал без записи в memories", async () => {
    setSetting("memory_observer_min_confidence", 80, "test");
    const taskId = crypto.randomUUID();
    const subtaskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run(taskId, "Низкая уверенность");
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
      done: "что-то сделано",
      complete: true,
    });
    aiReply.mockResolvedValueOnce(
      JSON.stringify({
        action: "remember",
        title: "Слабый урок",
        text: "неуверенный текст",
        kind: "lesson",
        confidence: 0.5,
      }),
    );
    const result = await observeSlotMemory(done.snapshot);
    expect(result).toEqual({ wrote: false, reason: "low_confidence" });
    const mem = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source_ref LIKE ?").get(`obs:${subtaskId}:%`) as {
      n: number;
    };
    expect(mem.n).toBe(0);
    const row = db
      .prepare("SELECT outcome, confidence FROM memory_observer_events ORDER BY rowid DESC LIMIT 1")
      .get() as { outcome: string; confidence: number };
    expect(row.outcome).toBe("low_confidence");
    expect(row.confidence).toBeCloseTo(0.5);
  });
});
