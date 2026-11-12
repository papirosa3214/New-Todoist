// Сторож очереди индексации (09.11.2026): тихий отказ был бы «заметки
// сохраняются, а в поиске их нет». Владелец уведомление видит в «Состоянии
// системы» — не чаще раза в сутки, как у сторожа поиска.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  KB_INDEX_WATCH_TYPE,
  checkKbSearch,
  probeIndexQueue,
} from "../src/lib/kbSearchWatcher.js";

const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;

let ownerId = "";

beforeAll(async () => {
  process.env.RAGFLOW_TOKEN = "test-token";
  process.env.RAGFLOW_TASKFLOW_DATASET = "ds-taskflow";
  process.env.KB_SEARCH_PROBE_DOC = "919c1483-adb9-43c7-a077-931a9bebbd50";
  const app = await buildApp();
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Владелец", email: "owner@kb-index-watch.test", password: "password123" },
  });
  ownerId = reg.json().user.id;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
});

beforeEach(() => {
  db.exec("DELETE FROM knowledge_index_jobs");
  db.exec(`DELETE FROM notifications WHERE type IN ('${KB_INDEX_WATCH_TYPE}', 'kb_search_watch')`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const job = (noteId: string, status: string, queuedAt: number, finishedAt?: number) =>
  db
    .prepare(
      `INSERT INTO knowledge_index_jobs (note_id, status, attempts, queued_at, finished_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(noteId, status, 1, iso(queuedAt), finishedAt ? iso(finishedAt) : null);

describe("сторож очереди индексации", () => {
  it("свежая очередь — не тревога", () => {
    job("n1", "queued", Date.now() - MINUTE);
    expect(probeIndexQueue().ok).toBe(true);
  });

  it("задание висит больше десяти минут — тревога", () => {
    job("n1", "queued", Date.now() - 11 * MINUTE);
    const r = probeIndexQueue();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("застряла");
  });

  it("зависшее «в работе» тоже считается застрявшим", () => {
    job("n1", "running", Date.now() - 30 * MINUTE);
    expect(probeIndexQueue().ok).toBe(false);
  });

  it("сорванная индексация за сутки — тревога, вчерашняя — нет", () => {
    job("n1", "error", Date.now() - 2 * MINUTE, Date.now() - MINUTE);
    expect(probeIndexQueue().ok).toBe(false);
    db.exec("DELETE FROM knowledge_index_jobs");
    job("n2", "error", Date.now() - 48 * 60 * MINUTE, Date.now() - 47 * 60 * MINUTE);
    expect(probeIndexQueue().ok).toBe(true);
  });

  it("поломка очереди доходит до владельца уведомлением", async () => {
    // Поиск при этом жив — тревога должна быть именно про очередь.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: { chunks: [{ document_keyword: process.env.KB_SEARCH_PROBE_DOC || "919c1483-adb9-43c7-a077-931a9bebbd50" }] },
          }),
          { status: 200 },
        ),
      ),
    );
    job("n1", "queued", Date.now() - 20 * MINUTE);
    const r = await checkKbSearch(fetch as any);
    expect(r.ok).toBe(true);
    const notes = db
      .prepare("SELECT type, text FROM notifications WHERE user_id = ?")
      .all(ownerId) as Array<{ type: string; text: string }>;
    expect(notes.map((n) => n.type)).toContain(KB_INDEX_WATCH_TYPE);
    expect(notes.find((n) => n.type === KB_INDEX_WATCH_TYPE)?.text).toContain("застряла");
  });

  it("повторная тревога в те же сутки не дублируется", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: { chunks: [{ document_keyword: process.env.KB_SEARCH_PROBE_DOC || "919c1483-adb9-43c7-a077-931a9bebbd50" }] },
          }),
          { status: 200 },
        ),
      ),
    );
    job("n1", "queued", Date.now() - 20 * MINUTE);
    await checkKbSearch(fetch as any);
    await checkKbSearch(fetch as any);
    // Считаем только своему владельцу: в общей тестовой базе владельцев
    // бывает несколько, и чужие уведомления к этому тесту не относятся.
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = ? AND user_id = ?")
      .get(KB_INDEX_WATCH_TYPE, ownerId) as { n: number };
    expect(n.n).toBe(1);
  });
});
