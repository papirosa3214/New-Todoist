import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { purgeTasks } from "../src/lib/taskPurge.js";
import { proposeWork } from "../src/runtime/chatWork.js";

// Владелец 12.10.2026: роль из чата готовит работу одной карточкой с шагами
// по ролям, владелец запускает её привычной кнопкой «Запустить» на карточке,
// дальше шаги добавляются в ту же карточку.
describe("работа по разговору: чат запускает исполнителей", () => {
  let app: FastifyInstance;
  const CHAT = "chat-work-test";
  const owner = () => (db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as any).id as string;
  const headers = () => ({ authorization: "Bearer " + app.jwt.sign({ id: owner() }) });
  const roles = () => (db.prepare("SELECT key FROM roles WHERE enabled = 1 ORDER BY position LIMIT 2").all() as any[]).map((r) => r.key as string);
  const proposed = () => db.prepare("SELECT id, task_id FROM chat_work_launches WHERE chat_id = ? AND status = 'proposed'").get(CHAT) as any;
  const clean = () => {
    purgeTasks((db.prepare("SELECT DISTINCT task_id FROM chat_work_launches WHERE chat_id = ?").all(CHAT) as any[]).map((r) => r.task_id));
    db.prepare("DELETE FROM chat_work_launches WHERE chat_id = ?").run(CHAT);
  };
  // В тестовой базе учёток ролей нет, а сервер выбирает ответственного за
  // интеграцию среди участников плана — заводим учётки на время теста.
  const madeUsers: string[] = [];
  beforeAll(async () => {
    app = await buildApp();
    clean();
    for (const key of roles()) {
      const id = "role_" + key;
      if (db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) continue;
      db.prepare("INSERT INTO users(id, name, email, password_hash, role, type, is_system_bot, role_key) VALUES(?, ?, ?, '!', 'agent', 'ai', 1, ?)").run(id, key, id + "@test", key);
      madeUsers.push(id);
    }
  });
  afterAll(async () => {
    clean();
    for (const id of madeUsers) { try { db.prepare("DELETE FROM users WHERE id = ?").run(id); } catch { /* остались ссылки — не мешает */ } }
    await app.close();
  });

  it("готовит одну карточку с шагами по ролям и черновиком плана; ничего не запускает", async () => {
    const [a, b] = roles();
    const res = await proposeWork(a, CHAT, {
      title: "Проверочная работа из чата",
      steps: [{ key: "first", role: a, result: "Первый результат" }, { key: "second", role: b ?? a, result: "Второй результат", after: ["first"] }],
    });
    expect(res.started).toBe(false);
    const task = db.prepare("SELECT status, parent_id, ready_for_pickup FROM tasks WHERE id = ?").get(res.task_id) as any;
    expect(task).toMatchObject({ status: "active", parent_id: null });
    expect(task.ready_for_pickup ?? 0).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(res.task_id) as any).n).toBe(0);
    expect((db.prepare("SELECT status FROM task_collaboration_plans WHERE task_id = ?").get(res.task_id) as any).status).toBe("draft");
    // Шаги видны на карточке до запуска и ещё никем не взяты.
    const steps = db.prepare("SELECT title, done, agent_state FROM subtasks WHERE task_id = ? ORDER BY position").all(res.task_id) as any[];
    expect(steps.map((s) => s.title)).toEqual([expect.stringContaining("Первый результат"), expect.stringContaining("Второй результат")]);
    expect(steps.every((s) => s.done === 0 && s.agent_state === null)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?").get(res.task_id) as any).n).toBe(0);
  });

  it("повторное предложение снимает прежнее незапущенное вместе с его карточкой", async () => {
    const [a] = roles();
    const before = proposed();
    const res = await proposeWork(a, CHAT, { title: "Вторая версия", steps: [{ key: "only", role: a, result: "Результат" }] });
    expect(db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(before.task_id)).toBeUndefined();
    expect((db.prepare("SELECT status FROM chat_work_launches WHERE id = ?").get(before.id) as any).status).toBe("cancelled");
    expect(proposed().task_id).toBe(res.task_id);
  });

  it("некорректные шаги отклоняются и ничего не снимают", async () => {
    const [a] = roles();
    const before = proposed();
    await expect(proposeWork(a, CHAT, { title: "x", steps: [{ role: "no_such_role", result: "r" }] })).rejects.toThrow(/нет включённой роли/);
    await expect(proposeWork(a, CHAT, { title: "x", steps: [{ role: a, result: " " }] })).rejects.toThrow(/какой результат/);
    await expect(proposeWork(a, CHAT, { title: "x", steps: [{ key: "p", role: a, result: "r", after: ["q"] }, { key: "q", role: a, result: "r", after: ["p"] }] })).rejects.toThrow(/по кругу/);
    expect(proposed()).toEqual(before);
    expect(db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(before.task_id)).toBeTruthy();
  });

  it("кнопка «Запустить» на карточке утверждает план; чужому — отказ", async () => {
    const row = proposed();
    const url = `/api/task-intake/drafts/${row.task_id}/start`;
    const stranger = await app.inject({ method: "POST", url, headers: { authorization: "Bearer " + app.jwt.sign({ id: "no-such-user" }) } });
    expect([401, 403]).toContain(stranger.statusCode);
    expect((db.prepare("SELECT status FROM task_collaboration_plans WHERE task_id = ?").get(row.task_id) as any).status).toBe("draft");

    const res = await app.inject({ method: "POST", url, headers: headers() });
    expect(res.statusCode, res.body).toBe(200);
    expect((db.prepare("SELECT status FROM task_collaboration_plans WHERE task_id = ?").get(row.task_id) as any).status).toBe("approved");
    expect((db.prepare("SELECT status FROM chat_work_launches WHERE id = ?").get(row.id) as any).status).toBe("started");
    // План занял уже показанный шаг, а не завёл второй.
    expect((db.prepare("SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ?").get(row.task_id) as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ? AND collaboration_plan_id IS NOT NULL").get(row.task_id) as any).n).toBe(1);
  });

  it("пока работа идёт, новые шаги добавляются в ту же карточку без кнопки", async () => {
    const [a] = roles();
    const running = db.prepare("SELECT task_id FROM chat_work_launches WHERE chat_id = ? AND status = 'started'").get(CHAT) as any;
    const res = await proposeWork(a, CHAT, { steps: [{ key: "more", role: a, result: "Ещё один результат", after: ["only"] }] });
    expect(res.started).toBe(true);
    expect(res.task_id).toBe(running.task_id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_collaboration_plan_nodes n JOIN task_collaboration_plans p ON p.id = n.plan_id WHERE p.task_id = ? AND p.status = 'approved'").get(running.task_id) as any).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(running.task_id) as any).n).toBe(0);
  });
});
