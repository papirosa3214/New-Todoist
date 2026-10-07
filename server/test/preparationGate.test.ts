// Утверждение плана владельцем не блокируется подготовкой (владелец 07.10.2026): идущие задания
// подготовки гасятся, вопрос модели снимается, упавшая подготовка не мешает.
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { settlePreparationOnApproval } from "../src/lib/preparationGate.js";

function task(id: string, clarification = 0) {
  db.prepare("INSERT OR REPLACE INTO tasks (id, title, needs_clarification, clarification_question) VALUES (?, 'Карточка', ?, ?)").run(id, clarification, clarification ? "Что именно?" : null);
}
let version = 0;
function job(taskId: string, status: string) {
  db.prepare(
    "INSERT INTO task_preparation_jobs (task_id, input_version, status, snapshot) VALUES (?, ?, ?, '{}')",
  ).run(taskId, ++version, status);
}
const statuses = (taskId: string) =>
  (db.prepare("SELECT status FROM task_preparation_jobs WHERE task_id=? ORDER BY id").all(taskId) as { status: string }[]).map((r) => r.status);

describe("settlePreparationOnApproval", () => {
  beforeAll(async () => { await buildApp(); });

  it("гасит идущие задания подготовки, остальные не трогает", () => {
    task("gate-t1");
    for (const s of ["failed", "queued", "running", "ready", "skipped"]) job("gate-t1", s);
    settlePreparationOnApproval("gate-t1");
    expect(statuses("gate-t1")).toEqual(["failed", "superseded", "superseded", "ready", "skipped"]);
  });

  it("снимает вопрос модели «нужно уточнить» — владелец ответил утверждением", () => {
    task("gate-t2", 1);
    settlePreparationOnApproval("gate-t2");
    const row = db.prepare("SELECT needs_clarification AS n, clarification_question AS q FROM tasks WHERE id='gate-t2'").get() as { n: number; q: string | null };
    expect(row.n).toBe(0);
    expect(row.q).toBeNull();
  });

  it("чужие карточки не затрагивает", () => {
    task("gate-t3"); task("gate-t4", 1);
    job("gate-t4", "running");
    settlePreparationOnApproval("gate-t3");
    expect(statuses("gate-t4")).toEqual(["running"]);
    expect((db.prepare("SELECT needs_clarification AS n FROM tasks WHERE id='gate-t4'").get() as { n: number }).n).toBe(1);
  });
});
