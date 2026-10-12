import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { purgeTasks } from "../src/lib/taskPurge.js";
import { canPlanSubtaskBecomeReady } from "../src/runtime/planSubtaskAdmission.js";
import { setNodePhase, BranchPhaseError } from "../src/runtime/branchPhase.js";

// Владелец 12.10.2026: родитель может сначала сделать подготовку (архитектура,
// вводные), потом работают дочерние, потом родитель собирает итог.
describe("группы шагов родителя: до и после дочерних", () => {
  let app: FastifyInstance;
  const owner = () => (db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as any).id as string;
  const headers = () => ({ authorization: "Bearer " + app.jwt.sign({ id: owner() }) });
  const role = () => (db.prepare("SELECT key FROM roles ORDER BY position LIMIT 1").get() as any).key as string;
  const step = (id: string) => db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id) as any;
  const ready = (id: string) => canPlanSubtaskBecomeReady(step(id));

  beforeAll(async () => {
    app = await buildApp();
    purgeTasks(["ph-parent", "ph-child"]);
    const task = db.prepare("INSERT INTO tasks(id, title, creator_id, status, parent_id) VALUES(?, ?, ?, 'active', ?)");
    task.run("ph-parent", "Родитель", owner(), null);
    task.run("ph-child", "Дочерняя", owner(), "ph-parent");
    const plan = db.prepare("INSERT INTO task_collaboration_plans(id, task_id, revision, status, profile, created_by) VALUES(?, ?, 1, 'approved', 'manual', ?)");
    plan.run("ph-plan-p", "ph-parent", owner());
    plan.run("ph-plan-c", "ph-child", owner());
    const node = db.prepare("INSERT INTO task_collaboration_plan_nodes(id, plan_id, slot_key, role_key, expected_result) VALUES(?, ?, ?, ?, ?)");
    node.run("ph-n1", "ph-plan-p", "prep", role(), "Архитектура и вводные");
    node.run("ph-n2", "ph-plan-p", "final", role(), "Сборка итога");
    node.run("ph-n3", "ph-plan-c", "work", role(), "Работа дочерней");
    db.prepare("INSERT INTO task_collaboration_plan_edges(id, plan_id, from_slot_key, to_slot_key, start_condition) VALUES('ph-e1', 'ph-plan-p', 'prep', 'final', 'submitted')").run();
    const sub = db.prepare("INSERT INTO subtasks(id, task_id, title, done, position, collaboration_plan_id, plan_node_key) VALUES(?, ?, ?, 0, 0, ?, ?)");
    sub.run("ph-s-prep", "ph-parent", "подготовка", "ph-plan-p", "prep");
    sub.run("ph-s-final", "ph-parent", "итог", "ph-plan-p", "final");
    sub.run("ph-s-work", "ph-child", "работа", "ph-plan-c", "work");
  });
  afterAll(async () => { purgeTasks(["ph-parent", "ph-child"]); await app.close(); });

  it("по умолчанию — старый порядок: дочерняя идёт, родитель ждёт её закрытия", () => {
    expect(ready("ph-s-work")).toBe(true);
    expect(ready("ph-s-prep")).toBe(false);
  });

  it("подготовка запускается первой, дочерняя ждёт её, итог ждёт дочернюю", () => {
    setNodePhase("ph-plan-p", "prep", "before");
    expect(ready("ph-s-prep")).toBe(true);
    expect(ready("ph-s-work")).toBe(false);
    expect(ready("ph-s-final")).toBe(false);

    db.prepare("UPDATE subtasks SET done = 1, result = 'архитектура готова' WHERE id = 'ph-s-prep'").run();
    expect(ready("ph-s-work")).toBe(true);
    expect(ready("ph-s-final")).toBe(false);

    db.prepare("UPDATE subtasks SET done = 1 WHERE id = 'ph-s-work'").run();
    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = 'ph-child'").run();
    expect(ready("ph-s-final")).toBe(true);
  });

  it("запреты: у дочерней группы нет, итог не может стоять перед подготовкой", () => {
    expect(() => setNodePhase("ph-plan-c", "work", "before")).toThrow(BranchPhaseError);
    db.prepare("UPDATE subtasks SET done = 0 WHERE id = 'ph-s-prep'").run();
    setNodePhase("ph-plan-p", "prep", "after");
    // final зависит от prep: перенести в подготовку только final нельзя.
    expect(() => setNodePhase("ph-plan-p", "final", "before")).toThrow(/подготовительный шаг не может идти после итогового/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM plan_node_phases WHERE plan_id = 'ph-plan-p' AND phase = 'before'").get() as any).n).toBe(0);
  });

  it("ответ плана несёт группу, состояние и номер порядка узла", async () => {
    setNodePhase("ph-plan-p", "prep", "before");
    const res = await app.inject({ method: "GET", url: "/api/tasks/ph-parent/collaboration-plans", headers: headers() });
    expect(res.statusCode).toBe(200);
    const plan = (res.json() as any).plans[0];
    const bySlot = (suffix: string) => plan.nodes.find((n: any) => String(n.slot_key).endsWith(suffix));
    expect(bySlot("prep")).toMatchObject({ branch_phase: "before", execution_state: "ready", order: 1 });
    expect(bySlot("work")).toMatchObject({ branch_phase: "after", order: 2 });
    expect(bySlot("final")).toMatchObject({ branch_phase: "after", order: 3 });
    // подготовка → дочерняя → итог
    const has = (a: string, b: string) => plan.edges.some((e: any) => String(e.from_slot_key).endsWith(a) && String(e.to_slot_key).endsWith(b));
    expect(has("prep", "work")).toBe(true);
    expect(has("work", "final")).toBe(true);

    const put = await app.inject({ method: "PUT", url: "/api/tasks/ph-parent/collaboration-plans/ph-plan-p/nodes/prep/phase", headers: headers(), payload: { phase: "after" } });
    expect(put.statusCode).toBe(200);
    expect((put.json() as any).plan.nodes.find((n: any) => String(n.slot_key).endsWith("prep")).branch_phase).toBe("after");
  });
});
