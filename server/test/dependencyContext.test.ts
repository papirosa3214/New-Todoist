import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { buildDependencyContext } from "../src/runtime/dependencyContext.js";

const uid = () => crypto.randomUUID();

migrate();
runMigrations();

describe("DependencyContextEnricher", () => {
  it("даёт корень и транзитивные зависимости с результатом, но не соседнюю карточку", () => {
    const actorId = uid();
    const rootId = uid();
    const targetId = uid();
    const directId = uid();
    const nestedId = uid();
    const unrelatedId = uid();
    db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)")
      .run(actorId, "Context author", `${actorId}@test`, "hash");
    const insertTask = db.prepare(
      "INSERT INTO tasks (id, title, description, creator_id, parent_id, status, agent_state) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertTask.run(rootId, "Общий итог", "Собрать проверенный итог", actorId, null, "active", null);
    insertTask.run(targetId, "Интеграция", "", actorId, rootId, "active", null);
    insertTask.run(directId, "Контракт", "", actorId, rootId, "active", "review");
    insertTask.run(nestedId, "Исследование", "", actorId, rootId, "completed", null);
    insertTask.run(unrelatedId, "Не связанный сосед", "", actorId, rootId, "completed", null);
    db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)").run(targetId, directId);
    db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)").run(directId, nestedId);
    db.prepare("INSERT INTO comments (id, task_id, user_id, text) VALUES (?, ?, ?, ?)")
      .run(uid(), rootId, actorId, "Контракт принят владельцем");
    db.prepare(
      `INSERT INTO artifact_versions (id, task_id, version_no, task_revision, result, evidence_json, artifact_hash, created_by)
       VALUES (?, ?, 1, 1, ?, ?, ?, ?)`,
    ).run(uid(), directId, "Контракт проверен", JSON.stringify([{ path: "docs/contract.md" }]), "hash", actorId);

    const context = buildDependencyContext(targetId);

    expect(context.status).toBe("ok");
    expect(context.root).toMatchObject({ task_id: rootId, goal: "Собрать проверенный итог" });
    expect(context.root?.recent_comments).toContain("Контракт принят владельцем");
    expect(context.dependencies.map((item) => item.task_id)).toEqual([directId, nestedId]);
    expect(context.dependencies[0]).toMatchObject({ result: "Контракт проверен", artifact_refs: ["docs/contract.md"] });
    expect(context.dependencies.map((item) => item.task_id)).not.toContain(unrelatedId);
  });
});
