import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { purgeTasks } from "../src/lib/taskPurge.js";

// Владелец 12.10.2026: закрытие карточки закрывает дочерние карточки и все шаги.
describe("закрытие карточки закрывает всё под ней", () => {
  let app: FastifyInstance;
  const ids = ["close-root", "close-child-a", "close-child-done", "close-other"];
  const owner = () => (db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as any).id as string;
  const headers = () => ({ authorization: "Bearer " + app.jwt.sign({ id: owner() }) });

  beforeAll(async () => {
    app = await buildApp();
    purgeTasks(ids);
    const task = db.prepare("INSERT INTO tasks(id, title, creator_id, status, parent_id) VALUES(?, ?, ?, ?, ?)");
    task.run("close-root", "Корень", owner(), "active", null);
    task.run("close-child-a", "Дочерняя в работе", owner(), "active", "close-root");
    task.run("close-child-done", "Дочерняя закрытая", owner(), "completed", "close-root");
    task.run("close-other", "Чужая карточка", owner(), "active", null);
    const step = db.prepare("INSERT INTO subtasks(id, task_id, title, done, position, agent_state) VALUES(?, ?, ?, ?, ?, ?)");
    step.run("close-s1", "close-root", "шаг корня", 0, 0, null);
    step.run("close-s2", "close-child-a", "шаг дочерней в работе", 0, 0, "in_progress");
    step.run("close-s3", "close-other", "шаг чужой", 0, 0, null);
  });
  afterAll(async () => { purgeTasks(ids); await app.close(); });

  it("дочерние и шаги закрываются, чужая карточка не затронута", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/tasks/close-root", headers: headers(), payload: { status: "completed" } });
    expect(res.statusCode).toBe(200);

    const status = (id: string) => (db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as any).status;
    expect(status("close-root")).toBe("completed");
    expect(status("close-child-a")).toBe("completed");
    expect(status("close-other")).toBe("active");
    expect((db.prepare("SELECT completed_at FROM tasks WHERE id = 'close-child-a'").get() as any).completed_at).toBeTruthy();

    const step = (id: string) => db.prepare("SELECT done, agent_state FROM subtasks WHERE id = ?").get(id) as any;
    expect(step("close-s1")).toEqual({ done: 1, agent_state: null });
    expect(step("close-s2")).toEqual({ done: 1, agent_state: null });
    expect(step("close-s3").done).toBe(0);

    const ev = db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = 'close-child-a' AND kind = 'state_changed' AND to_value = 'completed'").get() as any;
    expect(ev.n).toBe(1);
  });
});
