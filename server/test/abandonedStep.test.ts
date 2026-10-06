// Событие «шаг брошен» (MAK-97, пункт 4): при гибели/зависании шага событие
// несёт хвост журнала хода и однострочный снимок git рабочей копии. Сбор
// подсказок best-effort и ограничен — проверяем и содержимое, и устойчивость.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { roleUserId } from "../src/roleRouting.js";
import { slotSessionDirectory } from "../src/runtime/slotSession.js";
import {
  ABANDONED_STEP_KIND,
  buildAbandonedStepHints,
  gitStateHint,
  logStepAbandoned,
  tailOfText,
  transcriptTail,
} from "../src/runtime/abandonedStep.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

describe("шаг брошен: хвост журнала и снимок git", () => {
  let app: FastifyInstance;
  let repo: string;

  beforeAll(async () => {
    app = await buildApp();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "abandoned-repo-"));
    git(repo, ["init", "-b", "main"]);
    git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"]);
    fs.writeFileSync(path.join(repo, "work.txt"), "one\n");
    git(repo, ["add", "work.txt"]);
    git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "add"]);
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("tailOfText берёт последние строки, короткий текст не режет", () => {
    expect(tailOfText("a\nb\nc", 2)).toBe("b\nc");
    expect(tailOfText("")).toBeNull();
    expect(tailOfText(null)).toBeNull();
  });

  it("transcriptTail читает конец файла и не падает на пропавшем", () => {
    const file = path.join(repo, "journal.jsonl");
    fs.writeFileSync(file, Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
    const tail = transcriptTail(file, 3);
    expect(tail).toBe("line 27\nline 28\nline 29");
    expect(transcriptTail(path.join(repo, "нет.jsonl"))).toBeNull();
  });

  it("gitStateHint даёт однострочный снимок с числом несохранённых файлов", () => {
    fs.writeFileSync(path.join(repo, "work.txt"), "one\ntwo\n");
    const hint = gitStateHint(repo);
    expect(hint).toMatch(/^main @ [0-9a-f]+ .+\(\d+ несохранённых файлов\)$/);
    fs.writeFileSync(path.join(repo, "extra.txt"), "x\n");
    expect(gitStateHint(repo)).toMatch(/\(\d+ несохранённых файлов\)/);
    expect(gitStateHint(path.join(repo, "нет-такой-папки"))).toBeNull();
  });

  it("событие несёт хвост журнала хода и снимок git рабочей копии", () => {
    const taskId = crypto.randomUUID();
    const subtaskId = crypto.randomUUID();
    const role = "builder";
    const ownerId = "u1";
    db.prepare("INSERT INTO tasks (id, title, status, creator_id) VALUES (?, 'abandoned', 'active', ?)").run(taskId, ownerId);
    db.prepare("INSERT INTO subtasks (id, task_id, title, done, position, plan_node_key) VALUES (?, ?, 'шаг', 0, 0, 'executor')").run(subtaskId, taskId);
    db.prepare("INSERT INTO slot_sessions (subtask_id, session_file, cwd, session_id) VALUES (?, ?, ?, 's1')")
      .run(subtaskId, path.join(repo, "session.jsonl"), repo);

    // Журнал хода шага: 25 строк, в событие должны попасть последние 20.
    const dir = slotSessionDirectory(taskId, role, subtaskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run.jsonl"), Array.from({ length: 25 }, (_, i) => `event ${i}`).join("\n"));

    const hints = buildAbandonedStepHints({ taskId, subtaskId, role, reason: "тест" });
    expect(hints.journal_tail).toContain("event 5");
    expect(hints.journal_tail).toContain("event 24");
    expect(hints.journal_tail).not.toContain("event 4\n");
    expect(hints.git_snapshot).toMatch(/main @ /);

    const event = logStepAbandoned({ taskId, subtaskId, role, reason: "ход оборвался" });
    expect(event?.journal_tail).toContain("event 24");
    const rows = db.prepare("SELECT to_value FROM task_events WHERE task_id = ? AND kind = ?").all(taskId, ABANDONED_STEP_KIND) as Array<{ to_value: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].to_value) as { reason: string; journal_tail: string | null; git_snapshot: string | null; slot_key: string | null };
    expect(payload.reason).toBe("ход оборвался");
    expect(payload.slot_key).toBe("executor");
    expect(payload.journal_tail).toContain("event 24");
    expect(payload.git_snapshot).toMatch(/main @ /);

    // Уборка фикстуры.
    db.prepare("DELETE FROM subtasks WHERE id = ?").run(subtaskId);
    db.prepare("DELETE FROM task_events WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(roleUserId(role)).toBe(roleUserId(role));
  });

  it("без сессии и cwd событие всё равно записывается, подсказки пусты", () => {
    const taskId = crypto.randomUUID();
    const ownerId = "u1";
    db.prepare("INSERT INTO tasks (id, title, status, creator_id) VALUES (?, 'abandoned none', 'active', ?)").run(taskId, ownerId);
    const event = logStepAbandoned({ taskId, subtaskId: null, role: null, reason: "нет данных" });
    expect(event).not.toBeNull();
    expect(event?.journal_tail).toBeNull();
    expect(event?.git_snapshot).toBeNull();
    db.prepare("DELETE FROM task_events WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  });
});
