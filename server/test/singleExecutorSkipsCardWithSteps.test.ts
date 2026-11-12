// Карточка со шагами не уходит в план из одного шага.
//
// Владелец 11.11.2026. Прецедент: 11.11.2026 в 05:54 карточка 342467fb
// создана с 6 шагами (`subtasks_seeded`), но автоприём успел раньше, чем
// собрался план из шагов: `applyIntakeToNewTask` → `tryStartSingleExecutorPlan`
// ({system:true}) подобрал builder, создал план `single_executor`, утвердил и
// стартовал узел. Гейт `skipped-has-steps` стоит в `tryStartSingleExecutorPlan`
// ДО `pickRole`, чтобы модель даже не спрашивали.
//
// Приёмка:
//  • карточка с шагом → { ok: true, reason: "skipped-has-steps" }, плана нет;
//  • карточка без шагов → { ok: true, reason: "started" }, план как раньше;
//  • автоприём (automatic) карточки с шагами плана single_executor не создаёт.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return {
    ...actual,
    runRoleInProcess: async () => ({ runId: "steps-gate-run", completion: Promise.resolve() }),
  };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { tryStartSingleExecutorPlan } from "../src/routes/dispatch.js";

function setOwnerMode(mode: "automatic" | "manual"): void {
  db.prepare("UPDATE users SET task_intake_mode = ? WHERE role = 'owner'").run(mode);
}

describe("карточка со шагами не стартует как single_executor", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let ownerId: string;
  let seq = 0;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "steps gate owner",
        email: `steps-gate-${Date.now()}@test`,
        password: "password123",
      },
    });
    ownerId = reg.json().user.id as string;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };
    // Вход всегда через manual: тесту нужен чистый вызов
    // `tryStartSingleExecutorPlan`, а не побочные планы автоприёма.
    setOwnerMode("manual");
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function makeTask(title: string, role = "builder"): string {
    seq += 1;
    const id = `steps-gate-task-${Date.now()}-${seq}`;
    db.prepare(
      "INSERT INTO tasks (id, title, status, creator_id, owner_selected_role) VALUES (?, ?, 'active', ?, ?)",
    ).run(id, title, ownerId, role);
    // Гасим всё, что могло появиться от триггеров создания.
    db.prepare("UPDATE task_collaboration_plans SET status='superseded' WHERE task_id = ?").run(id);
    return id;
  }

  function addStep(taskId: string, title: string): void {
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, 1)",
    ).run(`steps-gate-sub-${Date.now()}-${++seq}`, taskId, title);
  }

  function plans(taskId: string) {
    return db
      .prepare(
        "SELECT id, status, profile FROM task_collaboration_plans WHERE task_id = ? AND status IN ('draft','approved')",
      )
      .all(taskId) as Array<{ id: string; status: string; profile: string }>;
  }

  it("карточка с шагом получает skipped-has-steps и не заводит план", async () => {
    const taskId = makeTask("Карточка с шагом");
    addStep(taskId, "Шаг 1: собрать данные");

    const outcome = await tryStartSingleExecutorPlan(taskId, ownerId, { system: true });
    expect(outcome).toEqual({ ok: true, reason: "skipped-has-steps" });
    expect(plans(taskId)).toHaveLength(0);
    // Исполнитель не назначен: карточку исполняет её план из шагов.
    const row = db.prepare("SELECT assignee_id FROM tasks WHERE id = ?").get(taskId) as {
      assignee_id: string | null;
    };
    expect(row.assignee_id).toBeNull();
  });

  it("карточка без шагов стартует как раньше", async () => {
    const taskId = makeTask("Карточка без шагов");
    // system: true разрешён только при автоматическом режиме владельца.
    setOwnerMode("automatic");

    const outcome = await tryStartSingleExecutorPlan(taskId, ownerId, { system: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.reason !== "started") {
      throw new Error(`ожидался started, получили ${JSON.stringify(outcome)}`);
    }
    expect(outcome.role).toBe("builder");
    const all = plans(taskId);
    expect(all).toHaveLength(1);
    expect(all[0].profile).toBe("single_executor");
    expect(all[0].status).toBe("approved");
    setOwnerMode("manual");
  });

  it("автоприём карточки с шагами не создаёт план single_executor", async () => {
    // Живой сценарий 11.11.2026: карточка заводится с шагами, режим владельца
    // автоматический, автоприём срабатывает сразу.
    setOwnerMode("automatic");
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: ownerAuth,
        payload: {
          title: "Карточка с шагами из автоприёма",
          subtasks: ["Шаг 1", "Шаг 2"],
        },
      });
      expect(created.statusCode).toBe(200);
      const taskId = (created.json().task as { id: string }).id;

      const steps = db
        .prepare("SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ?")
        .get(taskId) as { n: number };
      expect(steps.n).toBeGreaterThan(0);

      const single = plans(taskId).filter((p) => p.profile === "single_executor");
      expect(single, JSON.stringify(single)).toHaveLength(0);
    } finally {
      setOwnerMode("manual");
    }
  });
});
