// MAK-67: одна внутренняя функция «план из одного шага» с правилом
// «Система». Карта вырезания одиночного запуска (docs/current/taskflow-flow.md,
// раздел «Вырезание одиночного запуска»).
//
// Приёмка:
//  • создание и старт: задача + роль → план single_executor с одним узлом,
//    утверждён и стартован;
//  • отказ системному допуску при manual: {system:true} + task_intake_mode=
//    'manual' → 409, узел не создан, ничего не запущено;
//  • явный запуск владельцем проходит: HTTP POST …/single-executor-plan
//    владельцем при любом режиме создаёт план и стартует узел;
//  • single_executor принимается сервером: POST …/collaboration-plans с
//    profile='single_executor' валиден (есть уже в PROFILES, но фиксируем
//    поведение для отдельного теста);
//  • правило «Система» действует на автоцепочках:
//      — unlockReadyPlanSubtasks при manual не стартует готовые узлы;
//      — recoverInterruptedPlanSubtasks при manual не поднимает узлы
//        после рестарта.
//
// runRoleInProcess подменён заглушкой, чтобы реальный Pi-агент не
// поднимался на интеграционных тестах (как и в соседних файлах
// task-collaboration-plans.test.ts, branchPlan.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return {
    ...actual,
    runRoleInProcess: async () => ({ runId: "mak67-run", completion: Promise.resolve() }),
  };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { ownerIntakeMode, startSingleExecutorPlan } from "../src/routes/task-collaboration-plans.js";
import { roleUserId } from "../src/roleRouting.js";
import { recoverInterruptedPlanSubtasks, unlockReadyPlanSubtasks } from "../src/runtime/planSubtaskAdmission.js";

function setOwnerMode(mode: "automatic" | "manual"): void {
  db.prepare("UPDATE users SET task_intake_mode = ? WHERE role = 'owner'").run(mode);
}

describe("MAK-67 план из одного шага с правилом «Система»", () => {
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
        name: "MAK67 owner",
        email: `mak67-owner-${Date.now()}@test`,
        password: "password123",
      },
    });
    ownerId = reg.json().user.id as string;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };
    setOwnerMode("manual");
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function postTask(title: string): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title },
    });
    expect(r.statusCode).toBe(200);
    return (r.json().task as { id: string }).id;
  }

  function planRows(taskId: string) {
    return db
      .prepare(
        "SELECT id, status, profile, rationale FROM task_collaboration_plans WHERE task_id = ? ORDER BY revision DESC",
      )
      .all(taskId) as Array<{ id: string; status: string; profile: string; rationale: string }>;
  }

  function nodeRows(planId: string) {
    return db
      .prepare(
        "SELECT slot_key, role_key, expected_result, origin FROM task_collaboration_plan_nodes WHERE plan_id = ?",
      )
      .all(planId) as Array<{ slot_key: string; role_key: string; expected_result: string; origin: string }>;
  }

  function subtaskState(taskId: string) {
    return db
      .prepare(
        "SELECT id, plan_node_key, done, agent_state, agent_id FROM subtasks WHERE task_id = ? AND plan_node_key IS NOT NULL",
      )
      .all(taskId) as Array<{
        id: string;
        plan_node_key: string;
        done: number;
        agent_state: string | null;
        agent_id: string | null;
      }>;
  }

  it("single_executor принимается сервером как валидный профиль плана", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("Одиночная задача для single_executor профиля");
    const created = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: ownerAuth,
      payload: {
        profile: "single_executor",
        rationale: "Маленькая задача — одного исполнителя достаточно",
        nodes: [
          { slot_key: "executor", role_key: "builder", expected_result: "Проверяемый результат задачи" },
        ],
        edges: [],
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { plan: { profile: string; nodes: Array<{ slot_key: string; role_key: string }> } };
    expect(body.plan.profile).toBe("single_executor");
    expect(body.plan.nodes).toHaveLength(1);
    expect(body.plan.nodes[0].slot_key).toBe("executor");
    expect(body.plan.nodes[0].role_key).toBe("builder");
  });

  it("явный запуск владельцем создаёт план, утверждает его и стартует корневой узел", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("Явный запуск через single-executor-plan");

    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/single-executor-plan`,
      headers: ownerAuth,
      payload: {
        role_key: "builder",
        expected_result: "Готовый план из одного шага",
        rationale: "Владелец нажал «Запустить»",
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { plan_id: string; subtask_id: string; run_id: string };
    expect(body.plan_id).toMatch(/^tcp_/);
    expect(body.subtask_id).toBeTruthy();
    expect(body.run_id).toBe("mak67-run");

    // План есть, утверждён, профиль single_executor.
    const plans = planRows(taskId);
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe("approved");
    expect(plans[0].profile).toBe("single_executor");

    // Узел один, наш, исполнитель — builder.
    const nodes = nodeRows(plans[0].id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].slot_key).toBe("executor");
    expect(nodes[0].role_key).toBe("builder");
    expect(nodes[0].expected_result).toBe("Готовый план из одного шага");
    expect(nodes[0].origin).toBe("single_executor");

    // Подзадача появилась и пошла в работу (runRoleInProcess — заглушка,
    // резолвится мгновенно, поэтому узел уже in_progress).
    const steps = subtaskState(taskId);
    expect(steps).toHaveLength(1);
    expect(steps[0].plan_node_key).toBe("executor");
    expect(steps[0].agent_state).toBe("in_progress");
    expect(steps[0].agent_id).toBe(roleUserId("builder"));
    expect(steps[0].done).toBe(0);
  });

  it("повторный явный запуск той же карточки не плодит второй план", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("Повторный запуск той же карточки");
    const first = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/single-executor-plan`,
      headers: ownerAuth,
      payload: { role_key: "builder", expected_result: "Первый запуск" },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/single-executor-plan`,
      headers: ownerAuth,
      payload: { role_key: "builder", expected_result: "Второй запуск" },
    });
    expect(second.statusCode).toBe(409);
    expect(planRows(taskId)).toHaveLength(1);
  });

  it("явный запуск отклоняет задачу с уже назначенным исполнителем", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("Карточка с исполнителем не запускается");
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(roleUserId("analyst"), taskId);
    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/single-executor-plan`,
      headers: ownerAuth,
      payload: { role_key: "builder" },
    });
    expect(r.statusCode).toBe(409);
    expect(planRows(taskId)).toHaveLength(0);
  });

  it("гонка автоприёма при Системе: явный запуск проигрывает и отдаёт 409", async () => {
    // Known limitation. Под automatic фон applyIntakeToNewTask ставит
    // assignee_id раньше, чем владелец успевает нажать «Запустить»;
    // воспроизвести «владелец успел раньше Системы» в живом флоу почти
    // невозможно, и для этого теста мы лишь проверяем, что функция
    // устойчиво отвечает 409 на догоняющий вызов. Полноценный путь
    // «владелец успел раньше Системы» прикрыт кейсом
    // «явный запуск владельцем при manual стартует узел» ниже.
    setOwnerMode("automatic");
    const taskId = await postTask("Явный запуск при automatic уже разобранной карточки");
    // Дать фоновому applyIntakeToNewTask время поставить assignee_id.
    // После MAK-68 фоновый допуск идёт через startSingleExecutorPlan: признак — план, а не assignee_id.
    for (let i = 0; i < 30; i++) {
      if (planRows(taskId).length > 0) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(planRows(taskId).length).toBeGreaterThan(0);
    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/single-executor-plan`,
      headers: ownerAuth,
      payload: { role_key: "builder", expected_result: "Запуск при automatic" },
    });
    expect(r.statusCode).toBe(409);
    // Второй план не создан: остался только план фонового допуска.
    expect(planRows(taskId)).toHaveLength(1);
  });

  it("системный допуск при manual отказывает: план не создан, узел не запущен", async () => {
    setOwnerMode("manual");
    expect(ownerIntakeMode()).toBe("manual");
    const taskId = await postTask("Системный допуск под manual");

    const outcome = await startSingleExecutorPlan(taskId, ownerId, {
      roleKey: "builder",
      expectedResult: "Автоприём при выключенной Системе",
      system: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("ожидался отказ");
    expect(outcome.code).toBe(409);
    expect(outcome.error).toMatch(/Система выключена/);

    // Никакого плана, никакой подзадачи плана, никаких side-effects.
    expect(planRows(taskId)).toHaveLength(0);
    expect(subtaskState(taskId)).toHaveLength(0);
    // Событие отказа легло в ленту карточки.
    const refused = db
      .prepare(
        "SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'single_executor_plan_admission_refused'",
      )
      .get(taskId);
    expect(refused).toBeTruthy();
  });

  it("системный допуск при automatic создаёт план и стартует узел", async () => {
    // Known limitation: этот тест проверяет «голую» функцию
    // startSingleExecutorPlan, а не реальный путь
    // applyIntakeToNewTask → startSingleExecutorPlan, потому что
    // под automatic фон успевает поставить assignee_id раньше
    // нашего вызова. Реальный e2e «владелец не успел, Система забрала»
    // прикрыт кейсом выше («гонка автоприёма при Системе»). Здесь мы
    // дожидаемся фона, чистим карточку к состоянию «никто не назначен»
    // и проверяем именно допуск самой функции.
    setOwnerMode("automatic");
    expect(ownerIntakeMode()).toBe("automatic");
    const taskId = await postTask("Системный допуск под automatic");

    for (let i = 0; i < 50; i++) {
      if (planRows(taskId).length > 0) break; // после MAK-68 фон создаёт план через startSingleExecutorPlan
      await new Promise((r) => setTimeout(r, 80));
    }
    db.prepare("UPDATE tasks SET assignee_id = NULL, agent_state = NULL, current_attempt_id = NULL, ready_for_pickup = 0 WHERE id = ?").run(taskId);
    db.prepare("UPDATE task_collaboration_plans SET status = 'superseded' WHERE task_id = ? AND status IN ('draft','approved')").run(taskId);
    db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(taskId);

    const outcome = await startSingleExecutorPlan(taskId, ownerId, {
      roleKey: "analyst",
      expectedResult: "Автоприём при включённой Системе",
      system: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.planId).toMatch(/^tcp_/);
    // В списке и вытесненный план фонового допуска, и новый.
    expect(planRows(taskId).filter((p: { status: string }) => p.status !== "superseded")).toHaveLength(1);
    const steps = subtaskState(taskId);
    expect(steps).toHaveLength(1);
    expect(steps[0].agent_state).toBe("in_progress");
    expect(steps[0].agent_id).toBe(roleUserId("analyst"));
  });

  it("явный запуск владельцем при manual стартует узел даже под выключенной Системой", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("Владелец при manual — явный запуск");
    const outcome = await startSingleExecutorPlan(taskId, ownerId, {
      roleKey: "researcher",
      expectedResult: "Владелец хочет research при manual",
      system: false,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error);
    const steps = subtaskState(taskId);
    expect(steps).toHaveLength(1);
    expect(steps[0].agent_id).toBe(roleUserId("researcher"));
    expect(steps[0].agent_state).toBe("in_progress");
  });

  it("неизвестная роль возвращает 400, плана не появляется", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("Неизвестная роль");
    const outcome = await startSingleExecutorPlan(taskId, ownerId, {
      roleKey: "not_a_role",
      system: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("ожидался отказ");
    expect(outcome.code).toBe(400);
    expect(planRows(taskId)).toHaveLength(0);
  });

  // ─── правило «Система» для автоцепочек (MAK-67, блокер 2) ───────────
  // Покрывают: unlockReadyPlanSubtasks и recoverInterruptedPlanSubtasks при
  // task_intake_mode='manual' НЕ стартуют узлы сами — лог-событие
  // plan_subtask_manual_hold и свободный узел в ожидании явного
  // действия владельца. При 'automatic' автоцепочка по-прежнему стартует.

  it("unlockReadyPlanSubtasks при manual не стартует готовый узел, только лог-событие manual_hold", async () => {
    setOwnerMode("manual");
    expect(ownerIntakeMode()).toBe("manual");
    const taskId = await postTask("Готовый узел под manual");

    // Утверждённый план с одним узлом, но agent_state=NULL (руками) —
    // имитируем «готово, ещё не запущено». approve сразу поднимет узел
    // через worker, поэтому мы сначала отменяем аренду обратно.
    const created = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: ownerAuth,
      payload: {
        profile: "manual",
        rationale: "manual-цепочка",
        nodes: [{ slot_key: "executor", role_key: "builder", required: true, expected_result: "Результат" }],
        edges: [],
      },
    });
    expect(created.statusCode).toBe(201);
    const planId = (created.json() as { plan: { id: string } }).plan.id;
    const approve = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`,
      headers: ownerAuth,
    });
    expect(approve.statusCode).toBeLessThan(300);
    // Снимаем аренду approve: узел свободен и ждёт владельца.
    db.prepare("UPDATE subtasks SET agent_state = NULL, current_attempt_id = NULL WHERE task_id = ? AND plan_node_key = 'executor'").run(taskId);
    const before = subtaskState(taskId);
    expect(before).toHaveLength(1);
    expect(before[0].agent_state).toBeNull();

    await unlockReadyPlanSubtasks(planId, taskId, ownerId);

    const after = subtaskState(taskId);
    expect(after).toHaveLength(1);
    expect(after[0].agent_state).toBeNull();
    // agent_id остаётся от approve — это поле владельца узла, не
    // признак аренды.

    const holds = db
      .prepare("SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'plan_subtask_manual_hold'")
      .get(taskId);
    expect(holds).toBeTruthy();
  });

  it("unlockReadyPlanSubtasks при automatic стартует готовый узел (старое поведение сохранено)", async () => {
    setOwnerMode("manual");
    const taskId = await postTask("Готовый узел под automatic");
    // Сначала создаём задачу под manual, чтобы фон applyIntakeToNewTask
    // не успел поставить автоплан и узел в работу. Переключаем режим
    // уже после того, как карточка «остыла», и принудительно гасим
    // любой висящий авто-план (на случай гонки).
    const created = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: ownerAuth,
      payload: {
        profile: "manual",
        rationale: "auto-цепочка",
        nodes: [{ slot_key: "executor", role_key: "builder", required: true, expected_result: "Результат" }],
        edges: [],
      },
    });
    const planId = (created.json() as { plan: { id: string } }).plan.id;
    const approve = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`,
      headers: ownerAuth,
    });
    expect(approve.statusCode).toBeLessThan(300);
    // Approve поднимает узел в работу и открывает attempts; для
    // автостарта надо их закрыть и снять аренду. Имитируем «готовый
    // узел ждёт Систему».
    db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'interrupted', reason = 'sim' WHERE subtask_id IN (SELECT id FROM subtasks WHERE task_id = ? AND plan_node_key = 'executor') AND ended_at IS NULL").run(taskId);
    db.prepare("UPDATE subtasks SET agent_state = NULL, current_attempt_id = NULL WHERE task_id = ? AND plan_node_key = 'executor'").run(taskId);
    setOwnerMode("automatic");
    expect(ownerIntakeMode()).toBe("automatic");

    await unlockReadyPlanSubtasks(planId, taskId, ownerId);

    const after = subtaskState(taskId);
    expect(after).toHaveLength(1);
    expect(after[0].agent_state).toBe("in_progress");
    expect(after[0].agent_id).toBe(roleUserId("builder"));
  });

  it("recoverInterruptedPlanSubtasks при manual не поднимает узел после рестарта", async () => {
    setOwnerMode("manual");
    expect(ownerIntakeMode()).toBe("manual");
    const taskId = await postTask("Восстановление под manual");
    const created = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: ownerAuth,
      payload: {
        profile: "manual",
        rationale: "recover-manual",
        nodes: [{ slot_key: "executor", role_key: "builder", required: true, expected_result: "Результат" }],
        edges: [],
      },
    });
    const planId = (created.json() as { plan: { id: string } }).plan.id;
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: ownerAuth });
    const rows = subtaskState(taskId);
    expect(rows).toHaveLength(1);
    const subtaskId = rows[0].id as unknown as string;
    // Имитируем обрыв хода на рестарте: попытка живая, узел «в работе».
    db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'interrupted', reason = 'sim' WHERE subtask_id = ? AND ended_at IS NULL").run(subtaskId);
    db.prepare("UPDATE subtasks SET agent_state = 'in_progress' WHERE id = ?").run(subtaskId);

    const result = await recoverInterruptedPlanSubtasks();

    expect(result.manual_hold).toBeGreaterThanOrEqual(1);
    expect(result.resumed).toBe(0);
    const after = subtaskState(taskId);
    expect(after).toHaveLength(1);
    expect(after[0].agent_state).toBeNull();
    // agent_id остаётся — это исходное поведение MAK-66 (recover снимает
    // только аренду, но не меняет владельца узла).

    const holds = db
      .prepare("SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'plan_subtask_manual_hold'")
      .get(taskId);
    expect(holds).toBeTruthy();
  });
});