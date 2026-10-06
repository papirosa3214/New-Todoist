import { beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrations.js";
import db, { migrate } from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { dispatchPendingDiagnosticTasks } from "../src/lib/diagnosticDispatch.js";

describe("Автоматическое назначение диагностики", () => {
  beforeAll(() => { migrate(); runMigrations(); seedRoleAccounts(db); });
  const make = (diagnostic = true, excluded = false) => {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO tasks
      (id,title,description,creator_id,status,agent_state,machine_selected_role,role_exclusions)
      VALUES (?, ?, ?, 'u1', 'active', 'todo', 'builder', ?)`).run(
      id, "[Диагностика] Проверить канал",
      diagnostic ? "_Авто-создано inbox-triage-watcher из inbox/2026-09-27/_diagnostic/test.json._" : "Обычная задача",
      excluded ? JSON.stringify(["researcher","analyst","critic_verifier","architect","builder","qa","designer"]) : "[]",
    );
    return id;
  };
  // MAK-71: автоприём диагностики идёт через tryStartSingleExecutorPlan →
  // план single_executor с role_key='builder', а не assignee_id + role_run_jobs.
  it("назначает при включённой Системе и создаёт ровно один план single_executor", async () => {
    db.prepare("UPDATE users SET task_intake_mode='automatic' WHERE id='u1'").run();
    const id = make();
    await dispatchPendingDiagnosticTasks();
    const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as any;
    expect(row.ready_for_pickup).toBe(1);
    expect(row.agent_state).toBeNull();
    const plan = db.prepare(
      "SELECT profile, status FROM task_collaboration_plans WHERE task_id = ? ORDER BY revision DESC LIMIT 1",
    ).get(id) as { profile: string; status: string } | undefined;
    expect(plan).toMatchObject({ profile: "single_executor", status: "approved" });
    const sub = db.prepare(
      `SELECT role_key FROM plan_subtasks
         WHERE plan_id IN (SELECT id FROM task_collaboration_plans
                           WHERE task_id = ?)
         LIMIT 1`,
    ).get(id) as { role_key: string } | undefined;
    expect(sub?.role_key).toBe("builder");
    // Повторный вызов — идемпотентен, второй план не создаётся.
    await dispatchPendingDiagnosticTasks();
    const count = db.prepare(
      "SELECT count(*) n FROM task_collaboration_plans WHERE task_id = ?",
    ).get(id) as { n: number };
    expect(count.n).toBe(1);
  });
  it("не допускает обычные задачи, завершённые и уже назначенные карточки", async () => {
    const normal = make(false), closed = make(), assigned = make();
    db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(closed);
    db.prepare("UPDATE tasks SET assignee_id='role_qa' WHERE id=?").run(assigned);
    await dispatchPendingDiagnosticTasks();
    expect((db.prepare("SELECT ready_for_pickup FROM tasks WHERE id=?").get(normal) as any).ready_for_pickup).toBe(0);
    expect((db.prepare("SELECT ready_for_pickup FROM tasks WHERE id=?").get(closed) as any).ready_for_pickup).toBe(0);
    expect((db.prepare("SELECT assignee_id FROM tasks WHERE id=?").get(assigned) as any).assignee_id).toBe("role_qa");
  });
  // MAK-71: проверка «отказ → нет плана; восстановление → план создан»
  // через tryStartSingleExecutorPlan (без обращения к dispatchTaskToPi).
  it("не теряет карточку при отказе выбора роли и повторяет после устранения причины", async () => {
    const id = make();
    // Прямой отказ подменяемой функции в новом пути нет, поэтому просто
    // проверяем: пока исключения роль отсекает — план не создаётся;
    // убираем исключение — план появляется.
    db.prepare("UPDATE tasks SET role_exclusions = ? WHERE id = ?").run(
      JSON.stringify(["researcher","analyst","critic_verifier","architect","builder","qa","designer"]),
      id,
    );
    await dispatchPendingDiagnosticTasks();
    expect(db.prepare("SELECT count(*) n FROM task_collaboration_plans WHERE task_id=?").get(id))
      .toEqual({n:0});
    db.prepare("UPDATE tasks SET role_exclusions = '[]' WHERE id = ?").run(id);
    await dispatchPendingDiagnosticTasks();
    const plan = db.prepare(
      "SELECT profile, status FROM task_collaboration_plans WHERE task_id = ? ORDER BY revision DESC LIMIT 1",
    ).get(id) as { profile: string; status: string } | undefined;
    expect(plan).toMatchObject({ profile: "single_executor", status: "approved" });
  });
});
