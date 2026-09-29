// Владелец 30.09.2026: план совместной работы (draft) и обычная раздача
// одному исполнителю раньше гонялись наперегонки — раздача синхронная и
// всегда выигрывала, план так и висел неутверждённым черновиком рядом с
// уже занятой карточкой (прецедент: «Добавить бейдж…», T03 предложен,
// но раздача забрала карточку одному дизайнеру раньше, чем владелец успел
// решить). Теперь ровно один путь из двух: «Утвердить план» или
// «Запустить исполнителя» (PATCH ready_for_pickup) — выбор одного гасит
// другой.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// applyIntakeToNewTask зовёт unitState() из agent-service по динамическому
// импорту — в тестовой среде systemd не запущен, unitState() вернула бы
// active=false, и конвейер «автомат» вообще не дошёл бы до проверки,
// которую мы тестируем. Мокаем «будильник жив», как в readyDispatchBridge.
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
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import db from "../src/db.js";

describe("План совместной работы vs единственный исполнитель — взаимоисключение", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };

  const FEATURE_DESCRIPTION =
    "Новая функция для приложения: нужен отдельный экран, пользователь сможет включить/выключить настройку. " +
    "Критерии приёмки: экран открывается из настроек, состояние сохраняется и переживает перезапуск.";

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "PlanOwner",
        email: `plan-owner-${Date.now()}@test`,
        password: "password123",
      },
    });
    const body = reg.json();
    db.prepare(
      "UPDATE users SET role='owner', task_intake_mode='automatic' WHERE id=?",
    ).run(body.user.id);
    ownerAuth = { authorization: `Bearer ${body.token}` };
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("карточке предложен план (draft) — автомат не раздаёт её одному исполнителю", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: {
        title: "Добавить настройку в отдельном экране",
        description: FEATURE_DESCRIPTION,
      },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id as string;

    // План предлагается СИНХРОННО внутри POST /tasks (autoProposeCollaborationPlanIfNeeded,
    // routes/tasks.ts:950) — к этому моменту он уже должен быть в БД.
    const plan = db
      .prepare(
        "SELECT status FROM task_collaboration_plans WHERE task_id = ?",
      )
      .get(taskId) as { status: string } | undefined;
    expect(plan?.status).toBe("draft");

    // Приём (applyIntakeToNewTask) идёт фоном — даём ему время доехать и
    // убеждаемся, что он ОСТАНОВИЛСЯ, увидев черновик плана, а не поднял
    // флаг/раздал карточку.
    await new Promise((r) => setTimeout(r, 800));
    const row = db
      .prepare("SELECT ready_for_pickup, assignee_id FROM tasks WHERE id = ?")
      .get(taskId) as { ready_for_pickup: number; assignee_id: string | null };
    expect(row.ready_for_pickup).toBe(0);
    expect(row.assignee_id).toBeNull();
  }, 10_000);

  it("«Запустить исполнителя» (ready_for_pickup=true) гасит черновик плана", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: {
        title: "Добавить настройку во втором экране",
        description: FEATURE_DESCRIPTION,
      },
    });
    const taskId = created.json().task.id as string;

    const planBefore = db
      .prepare(
        "SELECT id, status FROM task_collaboration_plans WHERE task_id = ?",
      )
      .get(taskId) as { id: string; status: string } | undefined;
    expect(planBefore?.status).toBe("draft");

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { ready_for_pickup: true },
    });
    expect(patch.statusCode).toBe(200);

    const planAfter = db
      .prepare("SELECT status FROM task_collaboration_plans WHERE id = ?")
      .get(planBefore!.id) as { status: string };
    expect(planAfter.status).toBe("superseded");

    // Утвердить погашенный план уже нельзя — approve требует status='draft'.
    const approve = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans/${planBefore!.id}/approve`,
      headers: ownerAuth,
    });
    expect(approve.statusCode).toBe(409);
  }, 10_000);

  it("карточке без сигнала фичи (диагностика/рутина) план не предлагается — автомат работает как раньше", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: {
        title: "Починить падение при открытии карточки",
        description: "Приложение падает, если открыть карточку без описания. Нужно исправить ошибку.",
      },
    });
    const taskId = created.json().task.id as string;

    const plan = db
      .prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id = ?")
      .get(taskId);
    expect(plan).toBeUndefined();

    for (let i = 0; i < 40; i++) {
      const row = db
        .prepare("SELECT ready_for_pickup FROM tasks WHERE id = ?")
        .get(taskId) as { ready_for_pickup: number };
      if (row.ready_for_pickup === 1) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const row = db
      .prepare("SELECT ready_for_pickup FROM tasks WHERE id = ?")
      .get(taskId) as { ready_for_pickup: number };
    expect(row.ready_for_pickup).toBe(1);
  }, 20_000);
});
