// Удаление карточки с планом совместной работы (владелец 07.10.2026).
//
// Подзадача ссылается на план, шаг плана — на подзадачу, обе ссылки без
// каскада: карточка с планом не удалялась ни корзиной, ни вычисткой проекта.
// Проверяем, что общая функция (lib/taskPurge.ts) разрывает кольцо, уносит
// потомков и не трогает чужое. База одноразовая — test/setup.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { purgeTasks } from "../src/lib/taskPurge.js";

describe("Удаление карточки с планом: кольцо «подзадача ↔ план»", () => {
  let app: FastifyInstance;
  let token: string;
  let userId: string;
  const uid = () => crypto.randomUUID();

  async function makeTask(title: string, parentId?: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: "/api/tasks",
      headers: { authorization: `Bearer ${token}` },
      payload: parentId ? { title, parent_id: parentId } : { title },
    });
    expect(res.statusCode).toBe(200);
    return res.json().task.id;
  }

  /** План с одним шагом и подзадача, которые ссылаются друг на друга. */
  function ring(taskId: string) {
    const planId = uid(), subtaskId = uid();
    const role = (db.prepare("SELECT key FROM roles LIMIT 1").get() as { key: string }).key;
    db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,profile,created_by) VALUES(?,?,?,?,?)").run(planId, taskId, 1, "manual", userId);
    db.prepare("INSERT INTO subtasks(id,task_id,title,collaboration_plan_id) VALUES(?,?,?,?)").run(subtaskId, taskId, "шаг", planId);
    db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,source_subtask_id) VALUES(?,?,?,?,?)").run(uid(), planId, "s1", role, subtaskId);
    return { planId, subtaskId };
  }

  const exists = (table: string, id: string) => Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Владелец", email: `purge-${uid()}@example.com`, password: "password123" } });
    expect(reg.statusCode).toBe(200);
    token = reg.json().token; userId = reg.json().user.id;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(userId);
  });
  afterAll(async () => { await app.close(); });

  it("корзина сохраняет план; явное удаление архивной карточки не трогает соседнюю", async () => {
    const victim = await makeTask("с планом"), neighbour = await makeTask("соседняя");
    const a = ring(victim), b = ring(neighbour);
    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${victim}`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect((db.prepare("SELECT archived_at FROM tasks WHERE id=?").get(victim) as any).archived_at).toBeTruthy();
    expect(exists("task_collaboration_plans", a.planId)).toBe(true);
    const purge=await app.inject({method:"DELETE",url:`/api/tasks/${victim}`,headers:{authorization:`Bearer ${token}`}});
    expect(purge.statusCode).toBe(200);
    expect(exists("tasks", victim)).toBe(false);
    expect(exists("task_collaboration_plans", a.planId)).toBe(false);
    expect(exists("subtasks", a.subtaskId)).toBe(false);
    expect(exists("tasks", neighbour)).toBe(true);
    expect(exists("task_collaboration_plans", b.planId)).toBe(true);
    expect(exists("subtasks", b.subtaskId)).toBe(true);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("вместе с родителем уходят потомки со своими планами", async () => {
    const parent = await makeTask("родитель"), child = await makeTask("дочерняя", parent);
    ring(parent); const c = ring(child);
    expect(purgeTasks([parent])).toBe(2);
    expect(exists("tasks", child)).toBe(false);
    expect(exists("task_collaboration_plans", c.planId)).toBe(false);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
