import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { kbPendingCount, __raiseKbTriage, __resetKbTriageState } from "../src/lib/kbTriageWatcher.js";

// Порог разбора: рутина не должна гоняться впустую, но и зависнуть не
// должна. Ниже порога — молчим, выше — заводим задачу Секретарю.
describe("триггер разбора накопившихся заметок", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    // Изолированная база: владельца и проекта в ней нет — создаём.
    db.prepare("INSERT OR IGNORE INTO users (id, name, type, role, created_at) VALUES (?,?,?,?,datetime('now'))")
      .run("u1", "Владелец", "human", "owner");
    db.prepare("INSERT OR IGNORE INTO projects (id, name, owner_id, position, created_at) VALUES (?,?,?,0,datetime('now'))")
      .run("c2fcbcdb-951f-449f-a1bd-123ea2a46a58", "TaskFlow - NewTodoist", "u1");
  });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    __resetKbTriageState();
    db.prepare("DELETE FROM tasks WHERE id LIKE 'kb-triage-%'").run();
    db.prepare("DELETE FROM user_notes WHERE id LIKE 'kbp-%'").run();
  });

  function seedPending(n: number) {
    for (let i = 0; i < n; i++) {
      db.prepare(
        "INSERT INTO user_notes (id, title, content, kb_temp_category, created_at, updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))",
      ).run(`kbp-${Date.now()}-${i}`, `Заметка ${i}`,
        JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }), "Из задачи: Координация");
    }
  }

  it("ниже порога задачу не заводит — работа не гоняется впустую", () => {
    seedPending(5);
    expect(kbPendingCount()).toBe(5);
    __raiseKbTriage();
    const n = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id LIKE 'kb-triage-%'").get() as any;
    expect(n.n, "при пяти заметках разбор не нужен").toBe(0);
  });

  it("порог достигнут — заводит задачу и она сразу у Секретаря", () => {
    seedPending(20);
    expect(kbPendingCount()).toBe(20);
    __raiseKbTriage();
    const t = db
      .prepare("SELECT title, description, project_id, owner_selected_role FROM tasks WHERE id LIKE 'kb-triage-%'")
      .get() as any;
    expect(t, "задача на разбор должна появиться").toBeTruthy();
    expect(t.title).toContain("20");
    expect(t.owner_selected_role).toBe("secretary");
    expect(t.description).toContain("не удалять");
    expect(t.description).toContain("Workflows");
  });

  it("разбор идёт в основной проект, а не в «Серверные уведомления»", () => {
    seedPending(20);
    __raiseKbTriage();
    const t = db.prepare("SELECT project_id AS p FROM tasks WHERE id LIKE 'kb-triage-%'").get() as any;
    const p = db.prepare("SELECT name FROM projects WHERE id = ?").get(t.p) as any;
    expect(p?.name, "разбор — рутина, а не поломка").not.toBe("Серверные уведомления");
  });

  it("не заводит вторую задачу в тот же день", () => {
    seedPending(20);
    __raiseKbTriage();
    __raiseKbTriage();
    __raiseKbTriage();
    const n = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id LIKE 'kb-triage-%'").get() as any;
    expect(n.n, "повторы в пределах суток давятся").toBe(1);
  });
});