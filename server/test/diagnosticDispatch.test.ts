import { beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/migrations.js";
import db, { migrate } from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import * as dispatchModule from "../src/routes/dispatch.js";
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
  it("назначает при включённой Системе и доставляет ровно одну durable job", async () => {
    db.prepare("UPDATE users SET task_intake_mode='automatic' WHERE id='u1'").run();
    const id = make();
    await dispatchPendingDiagnosticTasks();
    const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as any;
    expect(row.ready_for_pickup).toBe(1);
    expect(row.agent_state).toBeNull();
    expect(row.assignee_id).toBe("role_builder");
    expect(row.dispatched_at).toBeTruthy();
    expect(db.prepare("SELECT count(*) n FROM agent_inbox WHERE task_id=? AND event_type='assignment'").get(id)).toEqual({n:1});
    expect(db.prepare("SELECT count(*) n FROM role_run_jobs WHERE task_id=? AND reason='assigned'").get(id)).toEqual({n:1});
    await dispatchPendingDiagnosticTasks();
    expect(db.prepare("SELECT count(*) n FROM role_run_jobs WHERE task_id=? AND reason='assigned'").get(id)).toEqual({n:1});
    expect((db.prepare("SELECT task_intake_mode FROM users WHERE id='u1'").get() as any).task_intake_mode).toBe("automatic");
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
  it("не теряет карточку при отказе выбора роли и повторяет после устранения причины", async () => {
    const id = make();
    const refusal = vi.spyOn(dispatchModule, "dispatchTaskToPi").mockResolvedValueOnce({ok:false,code:400,error:"нет кандидатов"});
    await dispatchPendingDiagnosticTasks();
    expect((db.prepare("SELECT assignee_id FROM tasks WHERE id=?").get(id) as any).assignee_id).toBeNull();
    expect(db.prepare("SELECT count(*) n FROM role_run_jobs WHERE task_id=?").get(id)).toEqual({n:0});
    refusal.mockRestore();
    await dispatchPendingDiagnosticTasks();
    expect((db.prepare("SELECT assignee_id FROM tasks WHERE id=?").get(id) as any).assignee_id).toBe("role_builder");
    expect(db.prepare("SELECT count(*) n FROM role_run_jobs WHERE task_id=?").get(id)).toEqual({n:1});
  });
});
