// Архив / возврат / удаление карточки из Linear повторяются в Linear (14.10.2026).
import { afterAll, beforeAll, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { archiveTask, restoreTask, purgeArchivedTask } from "../src/lib/taskArchive.js";
import { runLinearLifecyclePass, isLinearTombstoned } from "../src/lib/linearLifecycle.js";

let app: any, owner: string;
beforeAll(async () => {
  app = await buildApp();
  owner = crypto.randomUUID();
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES (?,\x27Owner\x27,?,\x27!\x27,\x27owner\x27,\x27human\x27)").run(owner, owner + "@test");
});
afterAll(async () => app.close());

function linked() {
  const task = crypto.randomUUID(), issue = crypto.randomUUID();
  db.prepare("INSERT INTO tasks(id,title,creator_id,status) VALUES (?,\x27Из Linear\x27,?,\x27completed\x27)").run(task, owner);
  db.prepare("INSERT INTO linear_import_tasks(owner_id,workspace_id,source_id,task_id,source_url,snapshot,applied_fields) VALUES (?,\x27ws\x27,?,?,\x27u\x27,\x27{}\x27,\x27{}\x27)").run(owner, issue, task);
  return { task, issue };
}
const pending = (issue: string) => (db.prepare("SELECT operation FROM linear_lifecycle_queue WHERE issue_id=? AND status=\x27pending\x27 ORDER BY created_at").all(issue) as any[]).map(r => r.operation);

it("архив и возврат: последнее действие побеждает", () => {
  const { task, issue } = linked();
  archiveTask(task, owner);
  expect(pending(issue)).toEqual(["archive"]);
  restoreTask(task, owner);
  expect(pending(issue)).toEqual(["unarchive"]);
});

it("удаление из архива: задание удалить и «не заводить», задание переживает карточку", () => {
  const { task, issue } = linked();
  archiveTask(task, owner);
  const res = purgeArchivedTask(task, owner);
  expect(res.ok).toBe(true);
  expect(db.prepare("SELECT 1 FROM tasks WHERE id=?").get(task)).toBeUndefined();
  expect(pending(issue)).toEqual(["delete"]);
  expect(isLinearTombstoned(owner, "ws", issue)).toBe(true);
});

it("проход отправляет задания в Linear", async () => {
  const { task, issue } = linked();
  archiveTask(task, owner);
  const calls: string[] = [];
  const writer = { archiveIssue: async (id: string) => { calls.push("archive:" + id); }, unarchiveIssue: async () => {}, deleteIssue: async () => {} };
  const r = await runLinearLifecyclePass(writer, Date.now(), 100);
  expect(calls).toContain("archive:" + issue);
  expect(r.failed).toBe(0);
  expect(pending(issue)).toEqual([]);
});

it("карточка не из Linear заданий не ставит", () => {
  const task = crypto.randomUUID();
  db.prepare("INSERT INTO tasks(id,title,creator_id,status) VALUES (?,\x27Своя\x27,?,\x27active\x27)").run(task, owner);
  const before = (db.prepare("SELECT count(*) n FROM linear_lifecycle_queue").get() as any).n;
  archiveTask(task, owner);
  expect((db.prepare("SELECT count(*) n FROM linear_lifecycle_queue").get() as any).n).toBe(before);
});
