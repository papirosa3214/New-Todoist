// Мост «владелец → 8-роль → план из одного шага».
//
// MAK-71: старая ручка POST /api/tasks/:id/dispatch снесена. Теперь
// владелец запускает карточку через POST /api/tasks/:id/run (mode=executor)
// — это та же единая точка входа `tryStartSingleExecutorPlan`, что и
// автоприём, PATCH ready_for_pickup и допуск системой. Стороны контракта
// (владелец, готовая карточка, выбор 8-роли, идемпотентность) сохранены,
// изменился только шов доставки: вместо «assignee_id = role_X +
// notification assigned + agent_inbox assignment» теперь «план
// single_executor + task_collaboration_plan_nodes.role_key».
//
// Полное покрытие 9 входов запуска и правил гейтов — в
// test/mak68SingleExecutorEntries.test.ts. Здесь — узкая проверка моста:
// действие владельца превращается в план с правильной ролью.
//
// Тест детерминированный, как в mak68: режим постановки до создания
// карточек переводится в ручной (иначе фоновый автоприём заводит план
// раньше, чем тест позовёт /run), а авто-предложенный черновик
// (`autoProposeCollaborationPlanIfNeeded` уходит в delivery на «api/слой»)
// гасится — иначе он блокирует single_executor как «уже есть план».
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

// Фоновый автоприём при создании карточки тоже подбирает роль. Без модели в
// тестовой среде он мог записать любое значение в machine_selected_role, и
// затем /run возвращал не архитектора, а случайную роль — набор становился
// плавающим. Фиксируем подбор: модель — ничего, семантика — архитектор.
vi.mock("../src/routes/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/ai.js")>();
  return { ...actual, pickRoleByModel: async () => null };
});
vi.mock("../src/lib/semanticEnrich.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/semanticEnrich.js")>();
  return {
    ...actual,
    semanticEnrich: async () => ({ matched: [{ role: "architect", score: 0.9 }] }),
  };
});

import { buildApp } from "../src/index.js";
import { ROLE_NAMES } from "./helpers/dispatch.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import db from "../src/db.js";

describe("Мост владелец → 8-роль → запуск через план из одного шага", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let ownerId: string;
  let strangerAuth: string;

  function setOwnerMode(mode: "automatic" | "manual"): void {
    db.prepare("UPDATE users SET task_intake_mode = ? WHERE role = 'owner'").run(mode);
  }

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
    // Ручной режим: фоновый автоприём не создаёт план и не гоняется с
    // тестом за право первого хода. Явные пусковые пути проверяются ниже.
    setOwnerMode("manual");

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

  /** Завести карточку и погасить авто-предложенный черновик плана. */
  async function createTask(title: string, extras: Record<string, unknown> = {}): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title, ...extras },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id as string;
    db.prepare(
      "UPDATE task_collaboration_plans SET status='superseded' WHERE task_id = ? AND status='draft'",
    ).run(taskId);
    // Фоновый автоприём мог записать machine_selected_role — убираем,
    // чтобы дефолтный /run брал роль из подбора, а не из остатка гонки.
    db.prepare("UPDATE tasks SET machine_selected_role=NULL WHERE id = ?").run(taskId);
    return taskId;
  }

  /** Создать задачу без исполнителя и поднять владельцу флаг готовности. */
  async function createReadyUnassigned(
    title: string,
    extras: Record<string, unknown> = {},
  ): Promise<string> {
    const taskId = await createTask(title, extras);
    // Флаг ставится прямо в базу, а не через PATCH: PATCH сам стартует план,
    // а тестам ниже нужна карточка готовая, но ещё не отданная.
    db.prepare(
      `UPDATE tasks
          SET ready_for_pickup = 1,
              ready_set_at = datetime('now'),
              ready_set_by = ?
        WHERE id = ?`,
    ).run(ownerId, taskId);
    return taskId;
  }

  /** Слот роли в новом плане single_executor. */
  function planRole(taskId: string): string | null {
    const row = db
      .prepare(
        `SELECT n.role_key AS role_key
           FROM task_collaboration_plan_nodes n
           JOIN task_collaboration_plans p ON p.id = n.plan_id
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

  // ── Гейты: от постороннего / с занятым исполнителем ──

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

  it("карточка с занятым assignee_id — запуск не сбивает чужого", async () => {
    const stranger = await regAndPatch(
      "OtherExecutor",
      `dispatch-other-${Date.now()}-${Math.random()}@test`,
      { type: "ai" },
    );
    const taskId = await createTask("занята", { assignee_id: stranger.id });
    db.prepare("UPDATE tasks SET ready_for_pickup = 1 WHERE id = ?").run(taskId);

    const run = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    // Карточка занята — запуск встанет в skipped-assignee (а не подменит
    // чужого исполнителя). Это инвариант «не сбиваем чужое назначение».
    expect(run.statusCode).toBeGreaterThanOrEqual(400);

    const row = db
      .prepare("SELECT assignee_id FROM tasks WHERE id = ?")
      .get(taskId) as { assignee_id: string | null };
    expect(row.assignee_id).toBe(stranger.id);
  });

  // ── Явное действие владельца не требует флага готовности ──

  it("/run без флага готовности работает — это явное действие владельца", async () => {
    const taskId = await createTask("без флага");

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

    const taskId = await createTask("чужой выбор", { assignee_id: stranger.id });
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

  // ── Идемпотентность: повторный /run после успешного — 4xx, планов один ──

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

  // ── Флаг готовности и роль в одном PATCH: роль не должна потеряться ──

  it("PATCH с owner_selected_role и ready_for_pickup сразу → план с выбранной ролью", async () => {
    const taskId = await createTask("флаг и роль одним патчем");

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { owner_selected_role: "builder", ready_for_pickup: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().task.owner_selected_role).toBe("builder");
    // Роль сохраняется раньше запуска по флагу — план обязан взять builder,
    // а не дефолтного architect.
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
    setOwnerMode("manual");
    const taskId = await createReadyUnassigned("ручной режим");

    const run = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      headers: ownerAuth,
      payload: { mode: "executor" },
    });
    expect(run.statusCode).toBe(200);
    expect(planRole(taskId)).toBeTruthy();
    setOwnerMode("manual");
  });

  it("автомат: карточка агента с исполнителем получает флаг, исполнитель не переписан", async () => {
    setOwnerMode("automatic");
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
      },
    });
    const taskId = created.json().task.id as string;

    // Автоприём идёт фоном: ждём, пока флаг доедет. Карточка с указанным
    // исполнителем получает флаг, но НЕ план single_executor — чужое
    // назначение остаётся нетронутым.
    for (let i = 0; i < 40; i++) {
      const row = db
        .prepare("SELECT ready_for_pickup FROM tasks WHERE id = ?")
        .get(taskId) as { ready_for_pickup: number };
      if (row.ready_for_pickup === 1) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const row = db
      .prepare("SELECT assignee_id, ready_for_pickup FROM tasks WHERE id = ?")
      .get(taskId) as { assignee_id: string | null; ready_for_pickup: number };
    expect(row.ready_for_pickup).toBe(1);
    expect(row.assignee_id).toBe(stranger.id);

    setOwnerMode("manual");
  }, 20_000);
});
