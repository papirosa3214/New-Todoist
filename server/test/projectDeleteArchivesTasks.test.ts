import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

// Владелец 10.10.2026: проект — пустая оболочка, все данные живут в
// карточках. Удаление проекта должно складывать задачи в архив, а не
// стирать их, а имя проекта остаётся в карточке историческим снимком.
describe("удаление проекта складывает задачи в архив", () => {
  let app: FastifyInstance;
  let OWNER = "";

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Владелец теста", email: "owner@pd-archive.test", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    const body = reg.json() as { user: { id: string } };
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(body.user.id);
    OWNER = body.user.id;
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    // Чистим по id: после purge задача остаётся в базе, но уже без
    // привязки к папке, и фильтр по project_id её больше не видит.
    db.exec("DELETE FROM tasks WHERE id LIKE 'pd-%'");
    db.exec("DELETE FROM projects WHERE id LIKE 'pd-%'");
    db.prepare(
      "INSERT INTO projects (id, name, owner_id, created_at) VALUES (?,?,?,datetime('now'))",
    ).run("pd-p1", "Папка которую удаляем", OWNER);
    db.prepare(
      "INSERT INTO tasks (id, title, project_id, status, creator_id, created_at) VALUES (?,?,?,?,?,datetime('now'))",
    ).run("pd-t1", "Задача проекта", "pd-p1", "active", OWNER);
  });

  it("оставляет задачу в архиве и сохраняет имя проекта в карточке", () => {
    const project: any = db.prepare("SELECT * FROM projects WHERE id = ?").get("pd-p1");
    expect(project).toBeTruthy();

    // Ровно тот порядок действий, что теперь делает purge проекта.
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE tasks
            SET project_name_snapshot = COALESCE(project_name_snapshot, ?),
                archived_at = COALESCE(archived_at, datetime('now')),
                archived_by = COALESCE(archived_by, ?)
          WHERE project_id = ? AND archived_at IS NULL`,
      ).run(project.name, OWNER, "pd-p1");
      db.prepare(
        "UPDATE tasks SET agent_state = NULL, agent_heartbeat_at = NULL WHERE project_id = ? AND agent_state IS NOT NULL",
      ).run("pd-p1");
      db.prepare("UPDATE tasks SET project_id = NULL WHERE project_id = ?").run("pd-p1");
      db.prepare("DELETE FROM projects WHERE id = ?").run("pd-p1");
    });
    tx();

    const task: any = db
      .prepare("SELECT archived_at, project_name_snapshot, project_id FROM tasks WHERE id = ?")
      .get("pd-t1");
    expect(task, "задача должна была остаться, а не исчезнуть").toBeTruthy();
    expect(task.archived_at, "задача должна быть в архиве").toBeTruthy();
    expect(task.project_name_snapshot).toBe("Папка которую удаляем");
    expect(task.project_id, "ссылка на удалённую папку должна быть снята").toBeNull();
    expect(db.prepare("SELECT id FROM projects WHERE id = ?").get("pd-p1")).toBeUndefined();
  });

  it("не переписывает дату архива у задач, которые уже в архиве", () => {
    db.prepare(
      "UPDATE tasks SET archived_at = datetime('now','-2 days'), archived_by = ? WHERE id = 'pd-t1'",
    ).run(OWNER);
    const before: any = db.prepare("SELECT archived_at FROM tasks WHERE id = 'pd-t1'").get();

    db.prepare(
      `UPDATE tasks
          SET project_name_snapshot = COALESCE(project_name_snapshot, ?)
        WHERE project_id = ? AND archived_at IS NULL`,
    ).run("Папка которую удаляем", "pd-p1");

    const after: any = (db.prepare("SELECT archived_at FROM tasks WHERE id = ?").all("pd-t1") as any[])[0];
    expect(after.archived_at).toBe(before.archived_at);
  });

  it("задача без папки всё равно отдаёт её имя из снимка", () => {
    db.prepare("UPDATE tasks SET project_name_snapshot = ? WHERE id = 'pd-t1'").run("Старое имя папки");
    db.prepare("UPDATE tasks SET project_id = NULL WHERE project_id = ?").run("pd-p1");
    db.prepare("DELETE FROM projects WHERE id = ?").run("pd-p1");

    const row: any = db
      .prepare(
        `SELECT COALESCE(t.project_name_snapshot, p.name) AS project_name
           FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.id = 'pd-t1'`,
      )
      .get();
    expect(row.project_name).toBe("Старое имя папки");
  });
});