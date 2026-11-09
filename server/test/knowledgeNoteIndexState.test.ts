// Состояние индексации в списке заметок (09.11.2026). Дневник показывает
// рядом с заметкой, попала ли она в поиск. Отдельная ручка на каждую заметку
// не годится: в папке бывает сотня — состояние приходит одним запросом.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kb-state-"));
process.env.TASKFLOW_KB_SYNC_DIR = STATE_DIR;
process.env.RAGFLOW_TOKEN = "test-token";
process.env.RAGFLOW_TASKFLOW_DATASET = "ds-taskflow";

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { enqueueNoteIndex } from "../src/lib/knowledgeIndexQueue.js";

let app: any;
let token = "";

const NOTE = (id: string) =>
  db
    .prepare(
      `INSERT INTO user_notes (id, title, content, search_text) VALUES (?, ?, ?, ?)`,
    )
    .run(
      id,
      `заметка ${id}`,
      JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "текст" }] }] }),
      "текст",
    );

const list = () =>
  app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  app = await buildApp();
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Владелец состояния", email: "owner@kb-state.test", password: "password123" },
  });
  token = reg.json().token;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
});

beforeEach(() => {
  db.exec("DELETE FROM knowledge_index_jobs");
  db.exec("DELETE FROM user_notes");
});

afterAll(() => {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
});

describe("состояние индексации", () => {
  it("различает ожидание, разбор, ошибку и уже проиндексированное", async () => {
    NOTE("s1");
    NOTE("s2");
    NOTE("s3"); // без задания — проиндексирована суточным прогоном
    NOTE("s4");

    enqueueNoteIndex("s1");
    db.prepare(
      `INSERT INTO knowledge_index_jobs (note_id, queued_at, attempts, status)
       VALUES ('s2', datetime('now'), 1, 'running')`,
    ).run();
    db.prepare(
      `INSERT INTO knowledge_index_jobs (note_id, queued_at, attempts, status, error)
       VALUES ('s4', datetime('now'), 3, 'error', 'RAGFlow ответил 502')`,
    ).run();

    const res = await list();
    expect(res.statusCode).toBe(200);
    const byId = new Map(res.json().notes.map((n: any) => [n.id, n]));
    expect((byId.get("s1") as any).index_state).toBe("queued");
    expect((byId.get("s2") as any).index_state).toBe("indexing");
    expect((byId.get("s3") as any).index_state).toBe("indexed");
    expect((byId.get("s4") as any).index_state).toBe("error");
    expect((byId.get("s4") as any).index_error).toContain("502");
  });

  it("заметка целиком тоже говорит своё состояние", async () => {
    NOTE("s5");
    enqueueNoteIndex("s5");
    const res = await app.inject({
      method: "GET",
      url: "/api/notes/s5",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().index_state).toBe("queued");
  });
});
