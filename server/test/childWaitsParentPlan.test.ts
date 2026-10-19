// Владелец 20.10.2026: оркестратор завёл родителя и три дочерние карточки, и
// через 30 с автоприём сам запустил все три — пока план родителя (подготовка →
// дочерние → итог) висел неутверждённым черновиком. В ленте запуск значился
// от имени владельца, хотя он ничего не нажимал.
//
// Приёмка:
//  • дочерняя карточка, у предка которой есть план, автоприёмом не стартует;
//  • явный запуск владельцем (manualStart) такой карточки проходит;
//  • карточка без плана у предков стартует как раньше, и события автозапуска
//    в ленте записаны от «Системы», а не от владельца.
//
// Карточки заводятся в ручном режиме: в автоматическом сервер отдаёт их
// исполнителю прямо при создании, ещё до привязки к родителю.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return {
    ...actual,
    runRoleInProcess: async () => ({
      runId: "child-waits-run",
      completion: Promise.resolve(),
    }),
  };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { tryStartSingleExecutorPlan } from "../src/routes/dispatch.js";
import { SCHEDULER_USER_ID } from "../src/serviceUser.js";

describe("дочерняя карточка ждёт план родителя", () => {
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
        name: "child-waits owner",
        email: `child-waits-${Date.now()}@test`,
        password: "password123",
      },
    });
    ownerId = reg.json().user.id as string;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };
  });

  beforeEach(() => setMode("manual"));

  afterAll(async () => {
    if (app) await app.close();
  });

  function setMode(mode: "automatic" | "manual"): void {
    db.prepare("UPDATE users SET task_intake_mode=? WHERE id=?").run(
      mode,
      ownerId,
    );
  }

  async function postTask(title: string, parentId?: string): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title },
    });
    expect(r.statusCode).toBe(200);
    const id = (r.json().task as { id: string }).id;
    if (parentId)
      db.prepare("UPDATE tasks SET parent_id=? WHERE id=?").run(parentId, id);
    return id;
  }

  async function draftPlan(taskId: string): Promise<void> {
    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: ownerAuth,
      payload: {
        profile: "single_executor",
        rationale: "План ветки родителя",
        nodes: [
          {
            slot_key: "executor",
            role_key: "architect",
            expected_result: "Итог ветки",
          },
        ],
        edges: [],
      },
    });
    expect(r.statusCode).toBe(201);
  }

  const plansOf = (taskId: string) =>
    db
      .prepare("SELECT status FROM task_collaboration_plans WHERE task_id=?")
      .all(taskId) as Array<{ status: string }>;

  it("автоприём не запускает дочернюю, пока у родителя есть план", async () => {
    const parent = await postTask("Родитель с черновиком плана");
    await draftPlan(parent);
    const child = await postTask("Дочерняя карточка", parent);

    setMode("automatic");
    const outcome = await tryStartSingleExecutorPlan(child, ownerId, {
      system: true,
    });
    expect(outcome).toEqual({ ok: true, reason: "skipped-parent-plan" });
    expect(plansOf(child)).toHaveLength(0);
  });

  it("план у деда тоже держит внучку", async () => {
    const grand = await postTask("Дед с планом");
    await draftPlan(grand);
    const parent = await postTask("Родитель без плана", grand);
    const child = await postTask("Внучка", parent);

    setMode("automatic");
    const outcome = await tryStartSingleExecutorPlan(child, ownerId, {
      system: true,
    });
    expect(outcome).toEqual({ ok: true, reason: "skipped-parent-plan" });
  });

  it("явный запуск владельцем дочерней карточки проходит", async () => {
    const parent = await postTask("Родитель для явного запуска");
    await draftPlan(parent);
    const child = await postTask("Дочерняя для явного запуска", parent);

    const outcome = await tryStartSingleExecutorPlan(child, ownerId, {
      manualStart: true,
    });
    expect(outcome.ok && outcome.reason).toBe("started");
  });

  it("карточка без плана у предков стартует, события — от «Системы»", async () => {
    const parent = await postTask("Родитель без плана");
    const child = await postTask("Дочерняя без плана у родителя", parent);

    setMode("automatic");
    const outcome = await tryStartSingleExecutorPlan(child, ownerId, {
      system: true,
    });
    expect(outcome.ok && outcome.reason).toBe("started");
    const actors = db
      .prepare(
        "SELECT DISTINCT actor_id FROM task_events WHERE task_id=? AND kind IN ('single_executor_plan_proposed','single_executor_plan_started','plan_subtask_started')",
      )
      .all(child) as Array<{ actor_id: string }>;
    expect(actors.map((a) => a.actor_id)).toEqual([SCHEDULER_USER_ID]);
  });
});
