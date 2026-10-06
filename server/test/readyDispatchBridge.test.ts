// Мост «owner поднял ready на задаче без исполнителя» → «канонический
// выбор 8-роли и запуск через план из одного шага».
//
// MAK-71: старая ручка POST /api/tasks/:id/dispatch снесена. Теперь
// владелец запускает карточку через POST /api/tasks/:id/run (mode=executor)
// — это та же единая точка входа `tryStartSingleExecutorPlan`, что и
// автоприём, PATCH ready_for_pickup и допуск системой. Стороны контракта
// (владелец, готовая карточка, выбор 8-роли, идемпотентность) сохранены,
// изменился только шов доставки: вместо «assignee_id = role_X +
// notification assigned + agent_inbox assignment» теперь «plan
// single_executor + plan_subtasks.role_key».
//
// Полное покрытие 9 входов запуска и правил гейтов — в
// test/mak68SingleExecutorEntries.test.ts. Здесь — узкая проверка моста:
// подъём флага владельцем превращается в план с правильной ролью.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";

// applyIntakeToNewTask в dispatch.ts вызывает unitState() по динамическому
// импорту — на живом сервере это честный systemctl, в тестовой среде unit
// не запущен. Мокаем, чтобы автоприём не висел на выключенной Системе.
vi.mock("../src/routes/agent-service.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/routes/agent-service.js")
  >();
  return {
    ...actual,
    unitState: async () => ({
      active: true,
      enabled: true,
      last_alive_at: null,
      next_scan_at: null,
      scan_interval_sec: 180,
    }),
  };
});

import { buildApp } from "../src/index.js";
import { ROLE_NAMES } from "./helpers/dispatch.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import db from "../src/db.js";

describe("Мост ready → 8-роль → запуск через план из одного шага", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let ownerId: string;
  let strangerAuth: string;

  async function regAndPatch(
    name: string,
    email: string,
    patch?: { role?: string; type?: string },
  ): Promise<{ id: string; jwt: string }> {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email, password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    const body = reg.json();
    if (patch?.role)
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(
        patch.role,
        body.user.id,
      );
    if (patch?.type)
      db.prepare("UPDATE users SET type = ? WHERE id = ?").run(
        patch.type,
        body.user.id,
      );
    return { id: body.user.id as string, jwt: body.token as string };
  }

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);

    const owner = await regAndPatch(
      "DispatchOwner",
      `dispatch-owner-${Date.now()}@test`,
      { role: "owner" },
    );
    ownerId = owner.id;
    ownerAuth = bearer(owner.jwt);

    const stranger = await regAndPatch(
      "DispatchStranger",
      `dispatch-stranger-${Date.now()}@test`,
    );
    strangerAuth = bearer(stranger.jwt);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /** Создать задачу без исполнителя и поднять владельцу флаг готовности. */
  async function createReadyUnassigned(
    title: string,
    extras: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title, ...extras },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id as string;
    db.prepare(
      `UPDATE tasks
          SET ready_for_pickup = 1,
              ready_set_at = datetime('now'),
              ready_set_by = ?
        WHERE id = ?`,
    ).run(ownerId, taskId);
    return taskId;
  }

  /** Снять последний план/запуск, чтобы следующий it стартовал с чистого. */
  function resetTask(taskId: string): void {
    db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id IN (SELECT id FROM task_collaboration_plans WHERE task_id = ?)").run(taskId);
    db.prepare("DELETE FROM task_collaboration_plans WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM role_run_jobs WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM task_events WHERE task_id = ?").run(taskId);
    db.prepare("UPDATE tasks SET assignee_id = NULL, dispatched_role = NULL, dispatched_at = NULL, dispatched_by = NULL, agent_state = NULL, ready_for_pickup = 1 WHERE id = ?").run(taskId);
  }

  /** Слот роли в новом плане single_executor. */
  function planRole(taskId: string): string | null {
    const row = db
      .prepare(
        `SELECT ps.role_key AS role_key
           FROM task_collaboration_plan_nodes ps
           JOIN task_collaboration_plans p ON p.id = ps.plan_id
          WHERE p.task_id = ?
          ORDER BY p.revision DESC
          LIMIT 1`,
      )
      .get(taskId) as { role_key: string } | undefined;
    return row?.role_key ?? null;
  }

  function planProfile(taskId: string): { profile: string; status: string } | null {
    const row = db
      .prepare(
        `SELECT profile, status FROM task_collaboration_plans
          WHERE task_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(taskId) as { profile: string; status: string } | undefined;
    return row ?? null;
  }

  // ── Гейты: без готовности / от постороннего / с занятым исполнителем ──

  it("/run без ready_for_pickup → 4xx, план не создан", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "не готова" },
    });
    const taskId = created.json().task.id as string;

    const run = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    expect(run.statusCode).toBeGreaterThanOrEqual(400);
    expect(planRole(taskId)).toBeNull();
  });

  it("/run от не-владельца → 403", async () => {
    const taskId = await createReadyUnassigned("чужим нельзя");

    const run = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: strangerAuth,
      payload: { mode: "executor" },
    });
    expect(run.statusCode).toBe(403);
    expect(planRole(taskId)).toBeNull();
  });

  it("карточка с занятым assignee_id — запуск идёт через plan, чужих не сбивает", async () => {
    const stranger = await regAndPatch(
      "OtherExecutor",
      `dispatch-other-${Date.now()}-${Math.random()}@test`,
      { type: "ai" },
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "занята", assignee_id: stranger.id },
    });
    const taskId = created.json().task.id as string;
    db.prepare("UPDATE tasks SET ready_for_pickup = 1 WHERE id = ?").run(taskId);

    const run = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    // Карточка занята — запуск от владельца встанет в skipped-* (а не
    // подменит чужого исполнителя). Это и есть инвариант «не сбиваем
    // чужое назначение».
    expect(run.statusCode).toBeGreaterThanOrEqual(400);

    const row = db
      .prepare("SELECT assignee_id FROM tasks WHERE id = ?")
      .get(taskId) as { assignee_id: string | null };
    expect(row.assignee_id).toBe(stranger.id);
  });

  // ── Счастливый путь: дефолтная роль ──

  it("без owner_selected_role → дефолт (architect), план single_executor с ролью architect", async () => {
    const taskId = await createReadyUnassigned("выбрать слой API");

    const run = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    expect(run.statusCode).toBe(200);
    expect(planProfile(taskId)).toMatchObject({
      profile: "single_executor",
      status: "approved",
    });
    expect(planRole(taskId)).toBe("architect");
  });

  // ── Owner override ──

  it("owner_selected_role побеждает: PATCH с ролью + /run → выбранная владельцем роль", async () => {
    const taskId = await createReadyUnassigned("выбрать слой API");

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { owner_selected_role: "builder" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().task.owner_selected_role).toBe("builder");

    const run = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    expect(run.statusCode).toBe(200);
    expect(planRole(taskId)).toBe("builder");
  });

  it("owner_selected_role можно снять (null) — дефолт снова побеждает", async () => {
    const taskId = await createReadyUnassigned("снять выбор");

    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { owner_selected_role: "qa" },
    });
    const clear = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { owner_selected_role: null },
    });
    expect(clear.statusCode).toBe(200);

    const run = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    expect(run.statusCode).toBe(200);
    expect(planRole(taskId)).toBe("architect");
  });

  it("owner_selected_role валидируется против 8 ролей — мусор → 400", async () => {
    const taskId = await createReadyUnassigned("плохая роль");
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { owner_selected_role: "wizard" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/рол/i);

    const row = db
      .prepare("SELECT owner_selected_role FROM tasks WHERE id = ?")
      .get(taskId) as { owner_selected_role: string | null };
    expect(row.owner_selected_role).not.toBe("wizard");
    if (row.owner_selected_role !== null) {
      expect(ROLE_NAMES).toContain(row.owner_selected_role);
    }
  });

  it("не-владелец не может задать owner_selected_role → 403", async () => {
    const stranger = await regAndPatch(
      "OtherDispatchAgent",
      `dispatch-other-${Date.now()}-${Math.random()}@test`,
      { type: "ai" },
    );
    const strangerHeaders = bearer(stranger.jwt);

    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "чужой выбор", assignee_id: stranger.id },
    });
    const taskId = created.json().task.id as string;
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { ready_for_pickup: true },
    });

    const denied = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: strangerHeaders,
      payload: { owner_selected_role: "builder" },
    });
    expect(denied.statusCode).toBe(403);
  });

  // ── Каждая из 8 ролей (owner_selected_role) даёт план с этой ролью ──

  for (const role of ROLE_NAMES) {
    it(`/run + owner_selected_role=${role} → план с role_key=${role}`, async () => {
      const taskId = await createReadyUnassigned(`роль ${role}`);

      const patch = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${taskId}`,
        headers: ownerAuth,
        payload: { owner_selected_role: role },
      });
      expect(patch.statusCode).toBe(200);

      const run = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/run`,
        headers: ownerAuth,
        payload: { mode: "executor" },
      });
      expect(run.statusCode).toBe(200);
      expect(planRole(taskId)).toBe(role);
    });
  }

  // ── Идемпотентность: повторный /run после успешного — 409, планов один ──

  it("повторный /run после успешного — 4xx, второй план не создан", async () => {
    const taskId = await createReadyUnassigned("идемпотентность");

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
    expect(r2.statusCode).toBeGreaterThanOrEqual(400);

    const planCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM task_collaboration_plans WHERE task_id = ?",
      )
      .get(taskId) as { n: number };
    expect(planCount.n).toBe(1);
  });

  it("владелец поднял флаг через API → задача уже у исполнителя, /run даёт 4xx без нового плана", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "флаг через PATCH", owner_selected_role: "builder" },
    });
    const taskId = created.json().task.id as string;

    // PATCH ready_for_pickup=true сам стартует план через tryStartSingleExecutorPlan.
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { ready_for_pickup: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(planRole(taskId)).toBe("builder");

    // Повторный /run — отказ, планов всё ещё один.
    const r2 = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    expect(r2.statusCode).toBeGreaterThanOrEqual(400);
    const planCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM task_collaboration_plans WHERE task_id = ?",
      )
      .get(taskId) as { n: number };
    expect(planCount.n).toBe(1);
  });

  // ── Режим «Система»: ручной /run работает при любом режиме ──

  it("ручной режим: /run создаёт план без оглядки на тумблер «Система»", async () => {
    db.prepare("UPDATE users SET task_intake_mode = 'manual' WHERE id = ?").run(
      ownerId,
    );
    const taskId = await createReadyUnassigned("ручной режим");

    const run = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    expect(run.statusCode).toBe(200);
    expect(planRole(taskId)).toBeTruthy();
    db.prepare("UPDATE users SET task_intake_mode = 'automatic' WHERE id = ?").run(
      ownerId,
    );
  });

  it("автомат: карточка агента с исполнителем получает план, исполнитель не переписан", async () => {
    db.prepare("UPDATE users SET task_intake_mode = 'automatic' WHERE id = ?").run(
      ownerId,
    );
    const stranger = await regAndPatch(
      "AutoAgent",
      `dispatch-auto-${Date.now()}@test`,
      { type: "ai" },
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: {
        title: "автомат чужой",
        assignee_id: stranger.id,
        owner_selected_role: "qa",
      },
    });
    const taskId = created.json().task.id as string;
    // НИЧЕГО руками не поднимаем — это проверка «автомат сам поднял флаг
    // и стартовал узел». В нашей моде автомат идёт через PATCH ready_for_pickup
    // внутри applyIntakeToNewTask, либо — если флаг уже поднят — стартует
    // узел сразу. Здесь флаг не поднят, поэтому ждём PATCH от владельца.
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { ready_for_pickup: true },
    });
    expect(planRole(taskId)).toBe("qa");

    const row = db
      .prepare("SELECT assignee_id FROM tasks WHERE id = ?")
      .get(taskId) as { assignee_id: string | null };
    expect(row.assignee_id).toBe(stranger.id);

    db.prepare("UPDATE users SET task_intake_mode = 'manual' WHERE id = ?").run(
      ownerId,
    );
  });
});
