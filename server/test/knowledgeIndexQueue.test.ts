// Очередь индексации заметок (09.11.2026): сохранённая заметка попадает в базу
// знаний через несколько секунд, а не ждёт суточного прогона. Проверяются
// очередь и сам перезалив — RAGFlow подменён заглушкой на fetch, сети нет.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kb-queue-"));
process.env.TASKFLOW_KB_SYNC_DIR = STATE_DIR;
process.env.TASKFLOW_KB_SYNC_LEGACY_STATE = path.join(STATE_DIR, "legacy.json");
process.env.RAGFLOW_TOKEN = "test-token";
process.env.RAGFLOW_API = "http://ragflow.invalid";
process.env.RAGFLOW_TASKFLOW_DATASET = "ds-taskflow";

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  DEBOUNCE_MS,
  RETRY_MS,
  enqueueNoteIndex,
  indexState,
  runDueJobs,
} from "../src/lib/knowledgeIndexQueue.js";

let app: any;
let projectFolder = 0;
let plainFolder = 0;

/** Заглушка RAGFlow: документы датасетов живут в памяти. */
type Doc = { id: string; name: string };
const remote: Record<string, Doc[]> = {};
let uploads = 0;
let failUpload = false;
let fetchCalls: string[] = [];

const json = (body: any) => new Response(JSON.stringify(body), { status: 200 });

function stubFetch() {
  fetchCalls = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const u = String(url);
    fetchCalls.push(`${init.method ?? "GET"} ${u}`);
    const ds = /\/api\/v1\/datasets\/([^/?]+)/.exec(u)?.[1] ?? "";
    const docs = (remote[ds] ??= []);
    if (init.method === "DELETE") {
      const ids: string[] = JSON.parse(String(init.body)).ids;
      remote[ds] = docs.filter((d) => !ids.includes(d.id));
      return json({ data: true });
    }
    if (init.method === "POST" && u.includes("/documents")) {
      if (failUpload) return new Response("boom", { status: 500 });
      const form = init.body as FormData;
      const name = String((form.get("file") as File).name);
      const doc = { id: `doc-${++uploads}`, name };
      docs.push(doc);
      return json({ data: [doc] });
    }
    if (init.method === "POST" && u.includes("/chunks")) return json({ data: true });
    const wanted = decodeURIComponent(/[?&]name=([^&]+)/.exec(u)?.[1] ?? "");
    return json({ data: { docs: wanted ? docs.filter((d) => d.name === wanted) : docs, total: docs.length } });
  });
}

const NOTE = (id: string, title: string, body: string, folder: number) =>
  db
    .prepare(
      `INSERT INTO user_notes (id, title, content, folder_id, search_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(
      id,
      title,
      body
        ? JSON.stringify({
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
          })
        : "",
      folder,
      body,
    );

beforeAll(async () => {
  app = await buildApp();
  projectFolder = Number(
    db.prepare("INSERT INTO journal_folders (name) VALUES ('Документация проекта')").run()
      .lastInsertRowid,
  );
  plainFolder = Number(
    db.prepare("INSERT INTO journal_folders (name) VALUES ('Без проекта')").run().lastInsertRowid,
  );
  db.prepare(
    `INSERT OR REPLACE INTO projects (id, name, notes_folder_id, knowledge_dataset_id, created_at)
     VALUES ('p-kb', 'Проект KB', ?, 'ds-project', datetime('now'))`,
  ).run(projectFolder);
});

beforeEach(() => {
  stubFetch();
  failUpload = false;
  for (const key of Object.keys(remote)) delete remote[key];
  db.exec("DELETE FROM knowledge_index_jobs");
  db.exec("DELETE FROM user_notes");
  fs.rmSync(path.join(STATE_DIR, "state.json"), { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("очередь", () => {
  it("не заливает заметку сразу — ждёт дебаунс", async () => {
    NOTE("n1", "Первая", "текст заметки", projectFolder);
    enqueueNoteIndex("n1");
    expect(indexState("n1")?.status).toBe("queued");

    const now = Date.now();
    expect(await runDueJobs(now)).toBe(0);
    expect(fetchCalls).toHaveLength(0);

    expect(await runDueJobs(now + DEBOUNCE_MS + 1)).toBe(1);
    expect(indexState("n1")?.status).toBe("done");
    expect(fetchCalls.some((c) => c.startsWith("POST") && c.includes("/documents"))).toBe(true);
    expect(remote["ds-project"].map((d) => d.name)).toEqual(["taskflow-n1.md"]);
  });

  it("повторяет сбой и сдаётся после третьей попытки", async () => {
    NOTE("n2", "Вторая", "текст", projectFolder);
    enqueueNoteIndex("n2");
    failUpload = true;

    let now = Date.now() + DEBOUNCE_MS + 1;
    await runDueJobs(now);
    expect(indexState("n2")?.status).toBe("queued");
    expect(indexState("n2")?.attempts).toBe(1);

    // Повтор — не сразу: упавший RAGFlow не должен молотить вхолостую.
    expect(await runDueJobs(now + 1000)).toBe(0);

    now += RETRY_MS + DEBOUNCE_MS + 1;
    await runDueJobs(now);
    expect(indexState("n2")?.attempts).toBe(2);

    now += RETRY_MS + DEBOUNCE_MS + 1;
    await runDueJobs(now);
    expect(indexState("n2")?.status).toBe("error");
    expect(indexState("n2")?.error).toContain("500");
  });

  it("пустая заметка не считается сбоем", async () => {
    NOTE("n3", "Пустая", "", projectFolder);
    enqueueNoteIndex("n3");
    await runDueJobs(Date.now() + DEBOUNCE_MS + 1);
    expect(indexState("n3")?.status).toBe("done");
  });
});

describe("перезалив заметки", () => {
  it("убирает копию в прежнем датасете, когда заметка переехала в другой", async () => {
    db.prepare(
      "INSERT OR REPLACE INTO journal_folders (id, name) VALUES (?, ?)",
    ).run(plainFolder, "Без проекта");
    remote["ds-taskflow"] = [{ id: "old-1", name: "taskflow-n4.md" }];
    NOTE("n4", "Переезжает", "текст", projectFolder);
    enqueueNoteIndex("n4");
    await runDueJobs(Date.now() + DEBOUNCE_MS + 1);
    expect(remote["ds-project"].map((d) => d.name)).toEqual(["taskflow-n4.md"]);

    // Перенесли в папку без проекта — значит, датасет по умолчанию.
    db.prepare("UPDATE user_notes SET folder_id = ? WHERE id = 'n4'").run(plainFolder);
    enqueueNoteIndex("n4");
    await runDueJobs(Date.now() + DEBOUNCE_MS + 2);
    expect(remote["ds-project"].filter((d) => d.name === "taskflow-n4.md")).toHaveLength(0);
    expect(remote["ds-taskflow"].filter((d) => d.name === "taskflow-n4.md")).toHaveLength(1);
  });
});

describe("сохранение заметки через API", () => {
  it("PATCH заметки ставит её в очередь", async () => {
    NOTE("n5", "Правлю", "текст", projectFolder);
    const token = (
      await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { name: "Владелец очереди", email: "owner@kb-queue.test", password: "password123" },
      })
    ).json();
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(token.user.id);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/notes/n5",
      headers: { authorization: `Bearer ${token.token}` },
      payload: { title: "Правлю дважды" },
    });
    expect(res.statusCode).toBe(200);
    expect(indexState("n5")?.status).toBe("queued");
  });
});
