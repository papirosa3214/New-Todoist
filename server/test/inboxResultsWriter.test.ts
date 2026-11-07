import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db from "../src/db.js";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "diag-writer-"));
const previous = process.env.TASKFLOW_NOTIF_ROOT;
let startWriter: typeof import("../src/lib/inboxResultsWriter.js").startInboxResultsWriter;
beforeAll(async () => {
  process.env.TASKFLOW_NOTIF_ROOT = root;
  fs.mkdirSync(path.join(root, "inbox", "_diagnostic"), {recursive:true});
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, priority INTEGER, creator_id TEXT, status TEXT, agent_state TEXT, parent_id TEXT, project_id TEXT, service_hidden INTEGER, incident_key TEXT, archived_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE comments (task_id TEXT, user_id TEXT, text TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE task_events (id TEXT, task_id TEXT, actor_id TEXT, kind TEXT, field TEXT, from_value TEXT, to_value TEXT, created_at TEXT DEFAULT (datetime('now')));`);
  startWriter = (await import("../src/lib/inboxResultsWriter.js")).startInboxResultsWriter;
});
afterAll(() => {
  if (previous === undefined) delete process.env.TASKFLOW_NOTIF_ROOT;
  else process.env.TASKFLOW_NOTIF_ROOT = previous;
  fs.rmSync(root, {recursive:true, force:true});
});
describe("diagnostic results remain in one card", () => {
  for (const comment of ["Начинаю проверку", "Подтверждено: сервис не отвечает"]) {
    it(`does not spawn a fix child for: ${comment}`, async () => {
      db.exec("DELETE FROM tasks; DELETE FROM comments; DELETE FROM task_events;");
      db.prepare("INSERT INTO tasks (id,title,description,status) VALUES (?,?,?,?)").run("diag", "[Диагностика] Сервис", "_Авто-создано inbox-triage-watcher из inbox/_diagnostic/example.json._", "active");
      db.prepare("INSERT INTO comments (task_id,user_id,text) VALUES (?,?,?)").run("diag", "infra", comment);
      db.prepare("INSERT INTO task_events (id,task_id,kind,to_value) VALUES (?,?,?,?)").run("ev", "diag", "state_changed", "review");
      const stop = startWriter();
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(db.prepare("SELECT count(*) n FROM tasks").get()).toEqual({n:1});
        expect(fs.readFileSync(path.join(root,"inbox/_diagnostic/example.md"),"utf8")).toContain(comment);
      } finally { stop(); fs.rmSync(path.join(root,"inbox/_diagnostic/example.md"),{force:true}); }
    });
  }
});
