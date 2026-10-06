// MAK-68: 9 входов запуска сведены к трём группам через одну функцию
// `startSingleExecutorPlan` (см. `server/src/routes/task-collaboration-plans.ts`).
// Обёртка `tryStartSingleExecutorPlan` живёт в `routes/dispatch.ts`.
//
// Карта вырезания (docs/current/taskflow-flow.md, §часть II «Вырезание
// одиночного запуска: карта»):
//   1. applyIntakeToNewTask                     — автоприём
//   2. POST /api/tasks/:id/dispatch             — явный запуск владельцем
//   3. admitParentAfterChildren                 — родитель после детей
//      releaseQueuedSuccessors                  — следующая в очереди
//   4. PATCH /api/tasks/:id ready_for_pickup=1  — флаг владельца
//   5. POST /api/tasks/:id/run (mode=executor)  — кнопка «Запустить»
//   6. ownerDraft.admitTreeAutomatically        — допуск дерева Секретаря
//      ownerDraft.startDraftTree                — «✓ Идёт» в чате
//   7. diagnosticDispatch.dispatchPending…      — диагностические карточки
//   8. agent-state.ts:~1184                     — повторная раздача после
//                                                 blocked→null
//   9. scheduler.launchRole (ветка 4/6)         — расписание
//
// Три группы:
//   A. Действие владельца (2, 4, 5, 6b)            — manualStart: true
//   B. Допуск системой (1, 3, 6a, 7, 8)            — system: true
//   C. Расписание (9)                               — system: true
//
// runRoleInProcess подменён заглушкой, чтобы реальный Pi-агент не
// поднимался на интеграционных тестах (как в mak67SingleExecutor.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return {
    ...actual,
    runRoleInProcess: async () => ({ runId: "mak68-run", completion: Promise.resolve() }),
  };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { tryStartSingleExecutorPlan } from "../src/routes/dispatch.js";

function setOwnerMode(mode: "automatic" | "manual"): void {
  db.prepare("UPDATE users SET task_intake_mode = ? WHERE role = 'owner'").run(mode);
}

function disableSystem(): void {
  // «Будильник» (unitState().active) — отдельный тумблер; для тестов
  // системного допуска он не нужен, потому что `tryStartSingleExecutorPlan`
  // не зависит от unitState. Но `applyIntakeToNewTask` зависит — там
  // отдельная ветка кода, и для чистоты теста системного допуска через
  // helper мы зовём helper напрямую.
}

describe("MAK-68: 9 входов запуска сведены к одной функции", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "MAK68 owner",
        email: `mak68-owner-${Date.now()}@test`,
        password: "password123",
      },
    });
    ownerId = reg.json().user.id as string;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };
    setOwnerMode("manual");
    disableSystem();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function postTask(title: string, role?: string): Promise<string> {
    // Чтобы `applyIntakeToNewTask` (который зовёт `tryStartSingleExecutorPlan`
    // в автоматическом режиме) НЕ создал план сразу, ставим manual до
    // создания задачи, и переключаем на нужный режим в самом тесте.
    setOwnerMode("manual");
    const r = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title },
    });
    expect(r.statusCode).toBe(200);
    const id = (r.json().task as { id: string }).id;
    // Гасим ВСЕ планы (draft и approved): `autoProposeCollaborationPlanIfNeeded`
    // мог создать draft, а `applyIntakeToNewTask` — approved. Нам нужен
    // чистый вход на `tryStartSingleExecutorPlan`.
    db.prepare("UPDATE task_collaboration_plans SET status='superseded' WHERE task_id = ?").run(id);
    if (role) {
      db.prepare("UPDATE tasks SET owner_selected_role = ?, updated_at = datetime('now') WHERE id = ?").run(role, id);
    }
    return id;
  }

  function planRows(taskId: string) {
    return db
      .prepare(
        "SELECT id, status, profile, rationale FROM task_collaboration_plans WHERE task_id = ? ORDER BY revision DESC",
      )
      .all(taskId) as Array<{ id: string; status: string; profile: string; rationale: string | null }>;
  }

  function nodeRows(planId: string) {
    return db
      .prepare(
        "SELECT slot_key, role_key, origin FROM task_collaboration_plan_nodes WHERE plan_id = ?",
      )
      .all(planId) as Array<{ slot_key: string; role_key: string; origin: string | null }>;
  }

  function clearDrafts(taskId: string): void {
    // `autoProposeCollaborationPlanIfNeeded` срабатывает на `POST /api/tasks`
    // и может создать draft для профилей delivery/research/full_cycle.
    // Перед каждым входом в `tryStartSingleExecutorPlan` гасим их, чтобы
    // тест был устойчив к тексту задачи.
    db.prepare("UPDATE task_collaboration_plans SET status='superseded' WHERE task_id = ? AND status='draft'").run(taskId);
  }

  // ── Группа A: действие владельца (manualStart: true) ──────────────────

  it("Группа A: явный запуск владельцем через /dispatch создаёт план из одного шага", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("MAK-68 A: явный /dispatch", "builder");

    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: ownerAuth,
    });
    expect(r.statusCode).toBe(200);

    const plans = planRows(taskId);
    expect(plans).toHaveLength(1);
    expect(plans[0].profile).toBe("single_executor");
    expect(plans[0].status).toBe("approved");
    const nodes = nodeRows(plans[0].id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].slot_key).toBe("executor");
    expect(nodes[0].role_key).toBe("builder");
    expect(nodes[0].origin).toBe("single_executor");
  });

  it("Группа A: PATCH ready_for_pickup=1 без исполнителя создаёт план из одного шага", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("MAK-68 A: PATCH ready_for_pickup", "builder");

    const r = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { ready_for_pickup: true },
    });
    expect(r.statusCode).toBe(200);

    const plans = planRows(taskId);
    expect(plans).toHaveLength(1);
    expect(plans[0].profile).toBe("single_executor");
    expect(plans[0].status).toBe("approved");
  });

  it("Группа A: POST /api/tasks/:id/run (mode=executor) создаёт план из одного шага", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("MAK-68 A: кнопка Запустить", "builder");

    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { role: string; planId: string };
    expect(body.role).toBe("builder");
    expect(body.planId).toMatch(/^tcp_/);

    const plans = planRows(taskId);
    expect(plans).toHaveLength(1);
    expect(plans[0].profile).toBe("single_executor");
  });

  // ── Группа B: допуск системой (system: true) ──────────────────────────

  it("Группа B: системный допуск при automatic создаёт план из одного шага", async () => {
    const taskId = await postTask("MAK-68 B: системный допуск", "builder");
    setOwnerMode("automatic");

    const outcome = await tryStartSingleExecutorPlan(taskId, ownerId, { system: true });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.reason === "started") {
      expect(outcome.role).toBe("builder");
      expect(outcome.planId).toMatch(/^tcp_/);
      expect(outcome.subtaskId).toBeTruthy();
    } else {
      throw new Error(`ожидался started, получили ${JSON.stringify(outcome)}`);
    }

    const plans = planRows(taskId);
    expect(plans).toHaveLength(1);
    expect(plans[0].profile).toBe("single_executor");
  });

  it("Группа B: системный допуск при manual отказывает (правило «Система»)", async () => {
    const taskId = await postTask("MAK-68 B: system при manual", "builder");
    setOwnerMode("manual");

    const outcome = await tryStartSingleExecutorPlan(taskId, ownerId, { system: true });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe(409);
      expect(outcome.error).toMatch(/Система выключена/);
    }
    // План не создан.
    expect(planRows(taskId)).toHaveLength(0);
  });

  it("Группа B: карточка с уже назначенным исполнителем получает skipped-assignee", async () => {
    const taskId = await postTask("MAK-68 B: уже назначен", "builder");
    // Назначаем исполнителя мимо плана.
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run("role_builder", taskId);
    setOwnerMode("automatic");

    const outcome = await tryStartSingleExecutorPlan(taskId, ownerId, { system: true });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.reason).toBe("skipped-assignee");
    }
    // Плана не должно появиться: вход отдан «уже назначенному».
    const allPlans = planRows(taskId);
    expect(allPlans, JSON.stringify(allPlans)).toHaveLength(0);
  });

  it("Группа B: карточка с активным планом получает skipped-plan", async () => {
    const taskId = await postTask("MAK-68 B: уже есть draft", "builder");
    setOwnerMode("manual");
    // Создаём draft-план вручную.
    db.prepare(
      "INSERT INTO task_collaboration_plans (id, task_id, revision, profile, rationale, status, created_by) VALUES (?, ?, 1, 'delivery', 'тест', 'draft', ?)",
    ).run("tcp_test_draft", taskId, ownerId);

    const outcome = await tryStartSingleExecutorPlan(taskId, ownerId, { manualStart: true });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.reason).toBe("skipped-plan");
    }
  });

  // ── Группа C: расписание (system: true) ───────────────────────────────

  it("Группа C: повторный запуск не создаёт второй план (идемпотентность)", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("MAK-68 C: повтор не должен плодить", "builder");

    // Первый запуск.
    const r1 = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: ownerAuth,
    });
    expect(r1.statusCode).toBe(200);

    // Повторный — должен вернуть 409 со skipped-* (а не 201 и не 500).
    const r2 = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: ownerAuth,
    });
    expect(r2.statusCode).toBe(409);
    const body = r2.json() as { reason?: string };
    expect(body.reason).toMatch(/skipped-/);

    // План ровно один.
    expect(planRows(taskId)).toHaveLength(1);
  });

  it("Группа C: повторный /run после первого успешного — 409, без нового плана", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("MAK-68 C: повтор /run", "builder");

    const r1 = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    expect(r2.statusCode).toBe(409);
    expect(planRows(taskId)).toHaveLength(1);
  });
});
