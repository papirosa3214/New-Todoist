// FTS + компактный блок памяти + наблюдатель слота (владелец 03.11.2026).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async (input: string) => ({ embeddings: bagOfWords(input), dim: 64, durationMs: 1 })),
}));

const aiReply = vi.fn(async () => JSON.stringify({ action: "skip" }));
vi.mock("../src/lib/runtimeAi.js", () => ({
  callRuntimeModel: (...args: unknown[]) => aiReply(...args),
}));

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");
const { memoryBlock, recall, remember } = await import("../src/lib/memory.js");
const { saveSlotSnapshot } = await import("../src/runtime/slotWorkSnapshot.js");
const { observeSlotMemory } = await import("../src/runtime/slotMemoryObserver.js");

function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

describe("поиск и наблюдатель памяти", () => {
  let app: FastifyInstance;
  const as = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ id })}` });

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    db.prepare("DELETE FROM memories").run();
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it("миграция подняла FTS5 по memories", () => {
    const enabled = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS v").get() as { v: number };
    expect(enabled.v).toBe(1);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
    expect(table).toBeTruthy();
  });

  it("точный идентификатор находится через FTS, даже если вектор смотрит в другую сторону", async () => {
    const { memory } = await remember(
      {
        scope: "team",
        kind: "fact",
        title: "role_tool_audit",
        text: "Таблица учёта вызовов инструментов ролей: role_tool_audit. Порт 5180 к ней не относится.",
      },
      { id: "role_builder", kind: "role" },
    );
    db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(
      toBlob(bagOfWords("кошки спят на подоконнике и едят рыбу")),
      memory.id,
    );
    await remember(
      { scope: "team", kind: "lesson", text: "Серверные тесты гоняем через npx vitest run в папке server" },
      { id: "role_builder", kind: "role" },
    );

    const byToken = await recall({ roleKey: "builder", query: "role_tool_audit" });
    expect(byToken.some((i) => i.id === memory.id)).toBe(true);

    const bySense = await recall({ roleKey: "builder", query: "как запускать тесты сервера vitest" });
    expect(bySense.some((i) => i.text.includes("vitest"))).toBe(true);
  });

  it("index не отдаёт тела, detail отдаёт тела по id, memoryBlock не тащит простыню", async () => {
    const { memory } = await remember(
      {
        scope: "role",
        role_key: "builder",
        kind: "lesson",
        title: "bge-m3-embed",
        text: "Локальная модель эмбеддингов bge-m3-embed крутится на .110. " + "подробности ".repeat(40),
      },
      { id: "role_builder", kind: "role" },
    );
    const index = await recall({ roleKey: "builder", query: "bge-m3-embed", mode: "index" });
    const hit = index.find((i) => i.id === memory.id);
    expect(hit).toBeTruthy();
    expect(hit!.text).toBe("");
    expect(hit!.title).toBe("bge-m3-embed");

    const detail = await recall({ roleKey: "builder", query: "", mode: "detail", ids: [memory.id] });
    expect(detail).toHaveLength(1);
    expect(detail[0].text).toContain("bge-m3-embed");

    const before = (db.prepare("SELECT use_count FROM memories WHERE id = ?").get(memory.id) as { use_count: number }).use_count;
    const block = await memoryBlock({ roleKey: "builder", query: "bge-m3-embed" });
    expect(block).toContain("bge-m3-embed");
    expect(block).toContain(memory.id);
    expect(block).not.toContain("подробности подробности подробности");
    const after = (db.prepare("SELECT use_count FROM memories WHERE id = ?").get(memory.id) as { use_count: number }).use_count;
    expect(after).toBe(before);
  });

  it("наблюдатель пишет урок с полного done, молчит на skip и не плодит дубль слота", async () => {
    const taskId = crypto.randomUUID();
    const subtaskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run(taskId, "Починка FTS");
    db.prepare("INSERT INTO attempts (id, task_id, executor_id, started_at) VALUES (?, ?, 'role_builder', datetime('now'))").run(
      attemptId,
      taskId,
    );
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, done, position, agent_id, agent_state, current_attempt_id) VALUES (?, ?, 'шаг', 0, 0, 'role_builder', 'in_progress', ?)",
    ).run(subtaskId, taskId, attemptId);
    db.prepare("UPDATE attempts SET subtask_id = ? WHERE id = ?").run(subtaskId, attemptId);

    const progress = saveSlotSnapshot({
      subtaskId,
      attemptId,
      reason: "progress",
      done: "настраиваю индекс",
      complete: true,
    });
    const before = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source_ref LIKE ?").get(`obs:${subtaskId}:%`) as { n: number };
    await observeSlotMemory(progress.snapshot);
    const afterProgress = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source_ref LIKE ?").get(`obs:${subtaskId}:%`) as { n: number };
    expect(afterProgress.n).toBe(before.n);

    const done = saveSlotSnapshot({
      subtaskId,
      attemptId,
      reason: "done",
      done: "FTS5 по memories.title и text, триггеры на запись",
      complete: true,
    });
    aiReply.mockResolvedValueOnce(JSON.stringify({ action: "skip" }));
    const skipRes = await observeSlotMemory(done.snapshot);
    expect(skipRes).toMatchObject({ wrote: false });

    aiReply.mockResolvedValueOnce(
      JSON.stringify({
        action: "remember",
        title: "FTS5 для memories",
        text: "Индекс FTS5 строится по title и text записи memories, виртуальная таблица обновляется триггерами.",
        kind: "lesson",
        scope: "team",
        confidence: 0.9,
      }),
    );
    const wrote = await observeSlotMemory(done.snapshot);
    expect(wrote.wrote).toBe(true);
    const row = db.prepare("SELECT * FROM memories WHERE source_ref = ?").get(`obs:${subtaskId}:${attemptId}`) as {
      scope: string;
      kind: string;
      source_kind: string;
    };
    expect(row.scope).toBe("role");
    expect(row.kind).toBe("lesson");
    expect(row.source_kind).toBe("role");

    const again = await observeSlotMemory(done.snapshot);
    expect(again.wrote).toBe(false);
    const count = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source_ref = ?").get(`obs:${subtaskId}:${attemptId}`) as { n: number };
    expect(count.n).toBe(1);
  });

  it("похожий урок наблюдатель не перетирает", async () => {
    const { memory } = await remember(
      {
        scope: "role",
        role_key: "builder",
        kind: "lesson",
        title: "Индекс памяти",
        text: "Индекс FTS5 строится по title и text записи memories, виртуальная таблица обновляется триггерами.",
      },
      { id: "role_builder", kind: "role" },
    );
    const taskId = crypto.randomUUID();
    const subtaskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run(taskId, "Повтор урока");
    db.prepare("INSERT INTO attempts (id, task_id, executor_id, started_at) VALUES (?, ?, 'role_builder', datetime('now'))").run(
      attemptId,
      taskId,
    );
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, done, position, agent_id, current_attempt_id) VALUES (?, ?, 'шаг', 0, 0, 'role_builder', ?)",
    ).run(subtaskId, taskId, attemptId);
    db.prepare("UPDATE attempts SET subtask_id = ? WHERE id = ?").run(subtaskId, attemptId);
    const done = saveSlotSnapshot({
      subtaskId,
      attemptId,
      reason: "done",
      done: "ещё раз про FTS",
      complete: true,
    });
    aiReply.mockResolvedValueOnce(
      JSON.stringify({
        action: "remember",
        title: "Индекс памяти",
        text: "Индекс FTS5 строится по title и text записи memories, виртуальная таблица обновляется триггерами.",
        kind: "lesson",
        scope: "role",
        confidence: 0.95,
      }),
    );
    const res = await observeSlotMemory(done.snapshot);
    expect(res.wrote).toBe(false);
    const kept = db.prepare("SELECT text, source_ref FROM memories WHERE id = ?").get(memory.id) as {
      text: string;
      source_ref: string | null;
    };
    expect(kept.source_ref).not.toBe(`obs:${subtaskId}:${attemptId}`);
    expect(kept.text).toContain("FTS5");
  });

  it("у наблюдателя нет маршрута в карточки: только memories", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/runtime/slotMemoryObserver.ts", import.meta.url), "utf8"),
    );
    expect(src).not.toMatch(/taskflow_task|\/api\/tasks|\/api\/subtasks|chat_messages/);
    expect(src).toContain("remember(");
    expect(src).toContain("getSetting");
    expect(src).toContain("callRuntimeModel");
  });
});
