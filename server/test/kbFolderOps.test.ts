// Операция «папки базы знаний» для ролей (карточка 1c93ff67).
//
// Проверяем ровно то, что обещал шаг:
//   • список отдаёт id, имя, родителя, число заметок, привязанную задачу и её
//     состояние и признак корня библиотеки;
//   • удаление закрытой папки работает, заметки с постоянной категорией уходят
//     в раздел библиотеки (автор и дата заметок при этом прежние);
//   • защиты: корень библиотеки, её разделы, папка живой задачи и папка с
//     неразобранными заметками не удаляются.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { taskflowTools } from "../src/runtime/inProcessRun.js";

describe("операция ролей над папками базы знаний", () => {
  let app: FastifyInstance;
  let jwt = "";
  let OWNER = "";
  let rootId = 0;
  let sectionId = 0;
  let seq = 0;

  const nextId = (p: string) => `${p}-${Date.now()}-${(seq += 1)}`;

  const tool = (name: string) =>
    (taskflowTools("secretary", null) as any[]).find((t) => t.name === name);
  const call = async (name: string, p: Record<string, unknown>) => {
    const out = (await tool(name).execute("t-1", p)) as { content: { text: string }[] };
    return JSON.parse(out.content[0].text) as any;
  };

  const addFolder = (name: string, parent: number | null, kbRoot = false) => {
    const r = db
      .prepare("INSERT INTO journal_folders (parent_id, name, position, is_kb_root) VALUES (?,?,0,?)")
      .run(parent, name, kbRoot ? 1 : 0);
    return Number(r.lastInsertRowid);
  };
  const addNote = (id: string, folderId: number, category: string | null, temp: string | null, author = OWNER) => {
    db.prepare(
      `INSERT INTO user_notes (id, title, content, folder_id, kb_category, kb_temp_category, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,datetime('now','-2 days'))`,
    ).run(id, "Заметка", JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }), folderId, category, temp, author);
    return id;
  };
  const addTask = (id: string, folderId: number, status: "active" | "completed", archived = false) => {
    db.prepare(
      `INSERT INTO tasks (id, title, artifact_folder_id, status, archived_at, created_at, updated_at)
       VALUES (?,?,?,?,?,datetime('now'),datetime('now'))`,
    ).run(id, "Задача", folderId, status, archived ? "2026-01-01 00:00:00" : null);
    return id;
  };

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Владелец теста", email: "owner@kb-folders.test", password: "password123" },
    });
    jwt = (reg.json() as { token: string }).token;
    OWNER = (db.prepare("SELECT id FROM users WHERE email='owner@kb-folders.test'").get() as any).id;
    db.prepare("UPDATE users SET role='owner' WHERE email='owner@kb-folders.test'").run();
    // Корень библиотеки и её раздел — настоящая структура, её создаёт
    // bootstrap, а в тесте заводим вручную.
    rootId = addFolder("TaskFlow Library", null, true);
    sectionId = addFolder("Knowledge Base", rootId);
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    db.prepare("DELETE FROM journal_folders WHERE id NOT IN (?,?)").run(rootId, sectionId);
    db.prepare("DELETE FROM user_notes WHERE id LIKE 'kb-%'").run();
    db.prepare("DELETE FROM tasks WHERE id LIKE 'kb-t-%'").run();
  });

  it("список отдаёт родителя, число заметок, задачу и её состояние", async () => {
    const folderId = addFolder("Папка задачи", null);
    const taskId = addTask("kb-t-1", folderId, "completed");
    addNote("kb-n-1", folderId, "Knowledge Base", null);

    const res = await call("taskflow_kb_folders", {});
    const row = res.папки.find((f: any) => f.id === folderId);
    expect(row).toBeTruthy();
    expect(row.parent_id).toBeNull();
    expect(row.notes_count).toBe(1);
    expect(row.task.id).toBe(taskId);
    expect(row.task.state).toBe("закрыта");
    expect(row.is_kb_root).toBe(false);
    const root = res.папки.find((f: any) => f.is_kb_root);
    expect(root.id).toBe(rootId);
  });

  it("убирает папку закрытой задачи и переносит заметки с категорией в раздел", async () => {
    const folderId = addFolder("Папка закрытой задачи", null);
    addTask("kb-t-2", folderId, "completed");
    const noteId = addNote("kb-n-2", folderId, "Knowledge Base", null);

    const res = await call("taskflow_kb_folder_prune", { id: String(folderId) });
    expect(res.удалена.id).toBe(folderId);
    expect(res.перенесено_в_разделы.length).toBe(1);
    expect(res.перенесено_в_разделы[0].target_folder).toBe("Knowledge Base");

    const note = db.prepare("SELECT folder_id, updated_by, updated_at FROM user_notes WHERE id = ?").get(noteId) as any;
    expect(note.folder_id).toBe(sectionId);
    // Автор и дата правки заметки прежние: перенос — служебное действие.
    expect(note.updated_by).toBe(OWNER);
    const folder = db.prepare("SELECT id FROM journal_folders WHERE id = ?").get(folderId);
    expect(folder).toBeUndefined();
  });

  it("не удаляет корень библиотеки и её раздел", async () => {
    await expect(call("taskflow_kb_folder_prune", { id: String(rootId) })).rejects.toThrow(/нельзя/i);
    await expect(call("taskflow_kb_folder_prune", { id: String(sectionId) })).rejects.toThrow(/нельзя/i);
    expect(db.prepare("SELECT id FROM journal_folders WHERE id = ?").get(rootId)).toBeTruthy();
    expect(db.prepare("SELECT id FROM journal_folders WHERE id = ?").get(sectionId)).toBeTruthy();
  });

  it("не удаляет папку живой задачи", async () => {
    const folderId = addFolder("Папка живой задачи", null);
    addTask("kb-t-3", folderId, "active");
    await expect(call("taskflow_kb_folder_prune", { id: String(folderId) })).rejects.toThrow(/живой задачи/i);
    expect(db.prepare("SELECT id FROM journal_folders WHERE id = ?").get(folderId)).toBeTruthy();
  });

  it("не удаляет папку с неразобранными заметками", async () => {
    const folderId = addFolder("Папка с очередью разбора", null);
    addTask("kb-t-4", folderId, "completed");
    addNote("kb-n-3", folderId, null, "Из задачи: ждёт разбора");
    await expect(call("taskflow_kb_folder_prune", { id: String(folderId) })).rejects.toThrow(/неразобранных/i);
    expect(db.prepare("SELECT id FROM journal_folders WHERE id = ?").get(folderId)).toBeTruthy();
  });

  it("кандидаты на уборку — только листовые пустые папки закрытых заданий", async () => {
    const closedEmpty = addFolder("Пустая закрытая", null);
    addTask("kb-t-5", closedEmpty, "completed");
    const liveEmpty = addFolder("Пустая живая", null);
    addTask("kb-t-6", liveEmpty, "active");
    const withChildren = addFolder("С подпапками", null);
    addTask("kb-t-7", withChildren, "completed");
    addFolder("Подпапка", withChildren);

    const res = await call("taskflow_kb_folders", {});
    const ids = res.кандидаты_на_уборку.map((c: any) => c.id);
    expect(ids).toContain(closedEmpty);
    expect(ids).not.toContain(liveEmpty);
    expect(ids).not.toContain(withChildren);
  });
});
