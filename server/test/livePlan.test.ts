// Живой план совместной работы (владелец 01.10.2026): правки черновика и
// запущенного плана операциями, роли достраивают граф в пределах лимита,
// QA/критик отправляют на доработку, сданное и идущее не переписывается.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

// Роли по-настоящему не запускаем: достаточно знать, что шаг стартовал.
const started: string[] = [];
vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return {
    ...actual,
    runRoleInProcess: vi.fn(async (args: { subtaskId?: string }) => {
      if (args.subtaskId) started.push(args.subtaskId);
      return { runId: "run-" + crypto.randomUUID() };
    }),
  };
});

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");

type Spec = { slot: string; role: string; state?: "done" | "running" | "pending" };

describe("живой план совместной работы", () => {
  let app: FastifyInstance;
  let owner: { authorization: string };
  let ownerId: string;
  const as = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ id })}` });

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "LiveOwner", email: `live-${Date.now()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
    owner = { authorization: `Bearer ${reg.json().token}` };
  });
  beforeEach(() => {
    started.length = 0;
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  /** Задача с планом прямо в БД: /approve запустил бы роли раньше времени. */
  async function planWith(status: "draft" | "approved", nodes: Spec[], edges: Array<[string, string]>) {
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: owner, payload: { title: "Live " + crypto.randomUUID() } });
    const taskId = created.json().task.id as string;
    db.prepare("UPDATE task_collaboration_plans SET status = 'superseded' WHERE task_id = ?").run(taskId);
    const planId = "tcp_" + crypto.randomUUID();
    db.prepare(`INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, rationale, created_by, approved_by, approved_at)
                VALUES (?, ?, 50, ?, 'manual', 'live', ?, ?, datetime('now'))`).run(planId, taskId, status, ownerId, ownerId);
    for (const n of nodes) {
      db.prepare("INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result) VALUES (?, ?, ?, ?, 1, ?)")
        .run("tcpn_" + crypto.randomUUID(), planId, n.slot, n.role, `Шаг ${n.slot}`);
      if (status === "approved") {
        db.prepare(`INSERT INTO subtasks (id, task_id, title, position, agent_id, collaboration_plan_id, plan_node_key, done, agent_state)
                    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`)
          .run(crypto.randomUUID(), taskId, `Шаг ${n.slot}`, `role_${n.role}`, planId, n.slot,
            n.state === "done" ? 1 : 0, n.state === "running" ? "in_progress" : null);
      }
    }
    for (const [from, to] of edges) {
      db.prepare("INSERT INTO task_collaboration_plan_edges (id, plan_id, from_slot_key, to_slot_key, start_condition) VALUES (?, ?, ?, ?, 'accepted')")
        .run("tcpe_" + crypto.randomUUID(), planId, from, to);
    }
    return { taskId, planId };
  }

  const ops = (taskId: string, planId: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/ops`, headers: owner, payload });
  const stepOf = (planId: string, slot: string) =>
    db.prepare("SELECT id, done, agent_state, title, agent_id FROM subtasks WHERE collaboration_plan_id = ? AND plan_node_key = ?").get(planId, slot) as
      | { id: string; done: number; agent_state: string | null; title: string; agent_id: string }
      | undefined;
  const edgesOf = (planId: string) =>
    (db.prepare("SELECT from_slot_key || '>' || to_slot_key AS e FROM task_collaboration_plan_edges WHERE plan_id = ? ORDER BY e").all(planId) as Array<{ e: string }>).map((r) => r.e);

  it("черновик: владелец добавляет, меняет и удаляет шаги, порядок не теряется", async () => {
    const { taskId, planId } = await planWith("draft", [
      { slot: "analysis", role: "analyst" },
      { slot: "delivery", role: "builder" },
      { slot: "qa", role: "qa" },
    ], [["analysis", "delivery"], ["delivery", "qa"]]);

    const res = await ops(taskId, planId, {
      base_version: 1,
      ops: [
        { op: "add_step", slot_key: "design", role_key: "designer", expected_result: "Макеты экранов", after: ["analysis"], before: ["delivery"] },
        { op: "update_step", slot_key: "qa", expected_result: "Проверить на iPhone и iPad", instructions: "Оба размера экрана" },
        { op: "remove_step", slot_key: "delivery" },
      ],
    });
    expect(res.statusCode).toBe(200);
    const plan = res.json().plan;
    expect(plan.version).toBe(2);
    expect(plan.nodes.map((n: any) => n.slot_key)).toEqual(["analysis", "qa", "design"]);
    expect(plan.nodes.find((n: any) => n.slot_key === "qa").instructions).toBe("Оба размера экрана");
    // delivery удалён: его предшественники стали предшественниками его последователей.
    expect(edgesOf(planId)).toEqual(["analysis>design", "analysis>qa", "design>qa"]);

    const history = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/history`, headers: owner });
    expect(history.json().history[0]).toMatchObject({ status: "applied", base_version: 1, applied_version: 2 });
  });

  it("конфликт версий и цикл отклоняются, план не меняется", async () => {
    const { taskId, planId } = await planWith("draft", [{ slot: "a", role: "analyst" }, { slot: "b", role: "builder" }], [["a", "b"]]);
    const stale = await ops(taskId, planId, { base_version: 7, ops: [{ op: "remove_step", slot_key: "b" }] });
    expect(stale.statusCode).toBe(409);
    const cycle = await ops(taskId, planId, { ops: [{ op: "update_step", slot_key: "a", after: ["b"] }] });
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json().error).toContain("цикл");
    expect(edgesOf(planId)).toEqual(["a>b"]);
  });

  it("запущенный план: новый шаг становится подзадачей и стартует, сданное и идущее не трогается", async () => {
    const { taskId, planId } = await planWith("approved", [
      { slot: "analysis", role: "analyst", state: "done" },
      { slot: "delivery", role: "builder", state: "running" },
    ], [["analysis", "delivery"]]);

    const add = await ops(taskId, planId, { ops: [{ op: "add_step", role_key: "researcher", expected_result: "Сравнить библиотеки", after: ["analysis"] }] });
    expect(add.statusCode).toBe(200);
    const slot = add.json().result.added[0];
    const step = stepOf(planId, slot)!;
    expect(step.agent_id).toBe("role_researcher");
    expect(started).toContain(step.id);

    const editRunning = await ops(taskId, planId, { ops: [{ op: "update_step", slot_key: "delivery", role_key: "designer" }] });
    expect(editRunning.statusCode).toBe(409);
    const editDone = await ops(taskId, planId, { ops: [{ op: "remove_step", slot_key: "analysis" }] });
    expect(editDone.statusCode).toBe(409);
  });

  it("пропуск шага — с причиной, отличим от сдачи, следующие не ждут", async () => {
    const { taskId, planId } = await planWith("approved", [
      { slot: "analysis", role: "analyst", state: "done" },
      { slot: "design", role: "designer", state: "pending" },
      { slot: "delivery", role: "builder", state: "pending" },
    ], [["analysis", "design"], ["design", "delivery"]]);
    const noReason = await ops(taskId, planId, { ops: [{ op: "skip_step", slot_key: "design", reason: " " }] });
    expect(noReason.statusCode).toBe(400);
    const skip = await ops(taskId, planId, { ops: [{ op: "skip_step", slot_key: "design", reason: "экранов нет" }] });
    expect(skip.statusCode).toBe(200);
    const node = skip.json().plan.nodes.find((n: any) => n.slot_key === "design");
    expect(node.skip_reason).toBe("экранов нет");
    expect(stepOf(planId, "design")).toMatchObject({ done: 1 });
    expect(started).toContain(stepOf(planId, "delivery")!.id);
  });

  it("роль достраивает план из своего шага; сверх лимита — предложение владельцу", async () => {
    const { taskId, planId } = await planWith("approved", [
      { slot: "architecture", role: "architect", state: "running" },
      { slot: "delivery", role: "builder", state: "pending" },
      { slot: "qa", role: "qa", state: "pending" },
    ], [["architecture", "delivery"], ["delivery", "qa"]]);
    const archStep = stepOf(planId, "architecture")!.id;
    const request = (payload: Record<string, unknown>, who = "role_architect", step = archStep) =>
      app.inject({ method: "POST", url: `/api/subtasks/${step}/plan-request`, headers: as(who), payload });

    const first = await request({ kind: "add_step", role: "designer", expected_result: "UX экрана настроек", reason: "в решении новый экран", before: ["delivery"] });
    expect(first.statusCode).toBe(200);
    expect(first.json().result.status).toBe("applied");
    const designSlot = first.json().result.added[0];
    const node = db.prepare("SELECT origin, added_by, added_reason FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?").get(planId, designSlot);
    expect(node).toMatchObject({ origin: "role", added_by: "role_architect", added_reason: "в решении новый экран" });
    // Шаг ждёт архитектора (по умолчанию после автора), а разработчик ждёт дизайнера.
    expect(edgesOf(planId)).toContain(`architecture>${designSlot}`);
    expect(edgesOf(planId)).toContain(`${designSlot}>delivery`);
    expect(started).not.toContain(stepOf(planId, designSlot)!.id);
    // В ленте — от имени роли.
    const note = db.prepare("SELECT text FROM comments WHERE task_id = ? AND user_id = 'role_architect' ORDER BY created_at DESC LIMIT 1").get(taskId) as { text: string };
    expect(note.text).toContain("Изменил план");

    await request({ kind: "add_step", role: "researcher", expected_result: "Бенчмарк", reason: "r2" });
    await request({ kind: "add_step", role: "analyst", expected_result: "Метрики", reason: "r3" });
    const fourth = await request({ kind: "add_step", role: "qa", expected_result: "Нагрузочный тест", reason: "r4" });
    expect(fourth.json().result.status).toBe("proposed");
    const plan = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/collaboration-plans`, headers: owner }))
      .json().plans.find((p: any) => p.id === planId);
    expect(plan.pending_proposals).toHaveLength(1);
    expect(plan.nodes).toHaveLength(6);

    const approve = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans/${planId}/proposals/${plan.pending_proposals[0].id}/approve`,
      headers: owner,
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().plan.nodes).toHaveLength(7);
    expect(approve.json().plan.pending_proposals).toHaveLength(0);

    // Роль не меняет план из чужого шага и не правит чужие шаги.
    const foreign = await request({ kind: "add_step", role: "designer", expected_result: "x", reason: "x" }, "role_architect", stepOf(planId, "qa")!.id);
    expect(foreign.statusCode).toBe(403);
    const notMine = await request({ kind: "rework", defects: "плохо", reason: "x" });
    expect(notMine.statusCode).toBe(403);
  });

  it("QA отправляет на доработку: доработка и повторная проверка встают сами, не больше двух кругов", async () => {
    const { planId } = await planWith("approved", [
      { slot: "delivery", role: "builder", state: "done" },
      { slot: "qa", role: "qa", state: "running" },
      { slot: "critic", role: "critic_verifier", state: "pending" },
    ], [["delivery", "qa"], ["qa", "critic"]]);
    const rework = (step: string) =>
      app.inject({ method: "POST", url: `/api/subtasks/${step}/plan-request`, headers: as("role_qa"),
        payload: { kind: "rework", defects: "Падает при пустом списке", reason: "2 из 5 сценариев красные" } });

    const first = await rework(stepOf(planId, "qa")!.id);
    expect(first.statusCode).toBe(200);
    const [fix, recheck] = first.json().result.added as string[];
    expect(stepOf(planId, fix)!.agent_id).toBe("role_builder");
    expect(stepOf(planId, recheck)!.agent_id).toBe("role_qa");
    // Критик теперь ждёт повторную проверку, а не первую.
    expect(edgesOf(planId)).toEqual([`${fix}>${recheck}`, "delivery>qa", `qa>${fix}`, `${recheck}>critic`].sort());

    // Второй круг из повторной проверки — можно, третий — уже решение владельца.
    db.prepare("UPDATE subtasks SET done = 1 WHERE collaboration_plan_id = ? AND plan_node_key IN ('qa', ?)").run(planId, fix);
    db.prepare("UPDATE subtasks SET agent_state = 'in_progress' WHERE collaboration_plan_id = ? AND plan_node_key = ?").run(planId, recheck);
    const second = await rework(stepOf(planId, recheck)!.id);
    expect(second.statusCode).toBe(200);
    const [fix2, recheck2] = second.json().result.added as string[];
    db.prepare("UPDATE subtasks SET done = 1 WHERE collaboration_plan_id = ? AND plan_node_key IN (?, ?)").run(planId, recheck, fix2);
    db.prepare("UPDATE subtasks SET agent_state = 'in_progress' WHERE collaboration_plan_id = ? AND plan_node_key = ?").run(planId, recheck2);
    const third = await rework(stepOf(planId, recheck2)!.id);
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toContain("решение за владельцем");
  });
});
