import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { purgeTasks } from "../src/lib/taskPurge.js";
import { taskChatBrief } from "../src/lib/taskChatBrief.js";

// Владелец 12.10.2026: роль, проснувшаяся в чате задачи, первым делом узнаёт,
// что она участник этой задачи, и получает её суть и свои шаги.
describe("первый блок подсказки в чате задачи", () => {
  let app: FastifyInstance;
  const owner = () => (db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as any).id as string;
  const roles = () => (db.prepare("SELECT key FROM roles WHERE enabled = 1 ORDER BY position LIMIT 2").all() as any[]).map((r) => r.key as string);
  beforeAll(async () => {
    app = await buildApp();
    purgeTasks(["brief-task"]);
    const [a] = roles();
    db.prepare("INSERT INTO tasks(id, title, description, creator_id, status) VALUES('brief-task', 'Задача для брифа', 'Нужно починить выгрузку отчёта', ?, 'active')").run(owner());
    db.prepare("INSERT INTO task_collaboration_plans(id, task_id, revision, status, profile, created_by) VALUES('brief-plan', 'brief-task', 1, 'approved', 'manual', ?)").run(owner());
    db.prepare("INSERT INTO task_collaboration_plan_nodes(id, plan_id, slot_key, role_key, expected_result) VALUES('brief-n1', 'brief-plan', 'work', ?, 'Выгрузка работает')").run(a);
    db.prepare("INSERT INTO subtasks(id, task_id, title, done, position, collaboration_plan_id, plan_node_key, result) VALUES('brief-s1', 'brief-task', 'Починить выгрузку', 1, 0, 'brief-plan', 'work', 'Исправлен разбор дат')").run();
  });
  afterAll(async () => { purgeTasks(["brief-task"]); await app.close(); });

  it("участнику с шагом: задача, описание, карта и его итог как есть", () => {
    const [a] = roles();
    const brief = taskChatBrief("brief-task", a);
    expect(brief.startsWith("ЧАТ ЗАДАЧИ")).toBe(true);
    expect(brief).toContain("Твоя задача: «Задача для брифа»");
    expect(brief).toContain("← ТЫ ЗДЕСЬ");
    expect(brief).toContain("Нужно починить выгрузку отчёта");
    expect(brief).toContain("Исправлен разбор дат");
  });

  it("роли без шага: честно сказано, что шага нет; несуществующая задача — пусто", () => {
    const [a, b] = roles();
    expect(taskChatBrief("brief-task", b && b !== a ? b : "no_such_role")).toContain("Своего этапа в плане у тебя нет");
    expect(taskChatBrief("no-such-task", a)).toBe("");
  });
});
