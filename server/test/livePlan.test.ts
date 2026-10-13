import { roleReport } from "./helpers/roleReport.js";
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

  it("помощь до сдачи: помощник стартует, автор ждёт и продолжает после результата", async () => {
    const { taskId, planId } = await planWith("approved", [
      { slot: "analysis", role: "analyst", state: "done" },
      { slot: "delivery", role: "builder", state: "running" },
      { slot: "qa", role: "qa" },
    ], [["analysis", "delivery"], ["delivery", "qa"]]);
    const own = stepOf(planId, "delivery")!.id;
    const attempt=crypto.randomUUID();
    db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at) VALUES(?,?,?,'role_builder',datetime('now'))").run(attempt,taskId,own);
    db.prepare("UPDATE subtasks SET current_attempt_id=? WHERE id=?").run(attempt,own);
    const { taskflowTools } = await import("../src/runtime/inProcessRun.js");
    const tool = taskflowTools("builder",null,taskId,own).find(t=>t.name==="taskflow_plan_request")!;
    const request:any = await tool.execute("help", {subtask_id:own,kind:"request_help",role:"researcher",expected_result:"Проверить совместимость библиотеки",reason:"Без исследования реализация невозможна"});
    const answer=JSON.parse(request.content[0].text);
    expect(answer.итог).toBe("применено");
    expect(answer.ожидание).toContain("Заверши ход без сдачи");
    const helperSlot = answer["новые шаги"][0];
    const helper = stepOf(planId, helperSlot)!;
    expect(edgesOf(planId)).toContain(helperSlot+">delivery");
    expect(edgesOf(planId)).toContain("analysis>"+helperSlot);
    expect(edgesOf(planId)).not.toContain("delivery>"+helperSlot);
    expect(started).toContain(helper.id);
    expect(stepOf(planId,"delivery")).toMatchObject({done:0,agent_state:"blocked"});
    expect(db.prepare("SELECT ended_at,outcome FROM attempts WHERE id=?").get(attempt)).toMatchObject({ended_at:expect.any(String),outcome:"blocked"});
    expect(db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='collaboration_plan_completed'").get(taskId)).toBeUndefined();
    expect(started).not.toContain(stepOf(planId,"qa")!.id);
    const early = await app.inject({method:"PATCH",url:"/api/subtasks/"+own,headers:as("role_builder"),payload:{done:true,report_markdown:roleReport,result:"Не моя работа"}});
    expect(early.statusCode).toBe(400);
    expect(stepOf(planId,"delivery")!.done).toBe(0);
    started.length=0;
    const done = await app.inject({method:"PATCH",url:"/api/subtasks/"+helper.id,headers:as("role_researcher"),payload:{done:true,report_markdown:roleReport,result:"Совместимость подтверждена"}});
    expect(done.statusCode,done.body).toBe(200);
    expect(started).toContain(own);
    expect(stepOf(planId,"delivery")).toMatchObject({done:0,agent_state:"in_progress"});
    expect(started).not.toContain(stepOf(planId,"qa")!.id);
  });

  it("помощь: цикл и чужой шаг отклоняются без изменения графа и состояния", async () => {
    const {taskId,planId}=await planWith("approved",[
      {slot:"delivery",role:"builder",state:"running"},{slot:"qa",role:"qa"}
    ],[["delivery","qa"]]);
    const own=stepOf(planId,"delivery")!.id;
    const req=(who:string,payload:Record<string,unknown>)=>app.inject({method:"POST",url:"/api/subtasks/"+own+"/plan-request",headers:as(who),payload});
    const fields={kind:"request_help",role:"researcher",expected_result:"Исследование",reason:"Нужна помощь"};
    expect((await req("role_qa",fields)).statusCode).toBe(403);
    const cycle=await req("role_builder",{...fields,after:["qa"]});
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json().error).toContain("цикл");
    const unknown=await req("role_builder",{...fields,role:"missing_role"});
    expect(unknown.statusCode).toBe(400);
    expect(edgesOf(planId)).toEqual(["delivery>qa"]);
    expect(stepOf(planId,"delivery")).toMatchObject({done:0,agent_state:"in_progress"});
    expect(started).toEqual([]);
  });

  it("помощь сверх лимита: предложение не блокирует автора, одобрение создаёт ожидание и запускает помощника", async () => {
    const specs:Spec[]=[{slot:"delivery",role:"builder",state:"running"},
      ...Array.from({length:11},(_,i)=>({slot:"finished_"+i,role:"analyst",state:"done" as const}))];
    const {taskId,planId}=await planWith("approved",specs,[]);
    const own=stepOf(planId,"delivery")!.id;
    const request=await app.inject({method:"POST",url:"/api/subtasks/"+own+"/plan-request",headers:as("role_builder"),
      payload:{kind:"request_help",role:"researcher",expected_result:"Помощь сверх лимита",reason:"Нужен исполнитель"}});
    expect(request.statusCode,request.body).toBe(200);
    expect(request.json().result.status).toBe("proposed");
    expect(request.json().waiting_for_help).toBe(false);
    expect(stepOf(planId,"delivery")).toMatchObject({done:0,agent_state:"in_progress"});
    expect(started).toEqual([]);
    const proposal=request.json().result.opId;
    const approved=await app.inject({method:"POST",url:"/api/tasks/"+taskId+"/collaboration-plans/"+planId+"/proposals/"+proposal+"/approve",headers:owner});
    expect(approved.statusCode,approved.body).toBe(200);
    const helper=stepOf(planId,approved.json().result.added[0])!;
    expect(started).toContain(helper.id);
    expect(stepOf(planId,"delivery")).toMatchObject({done:0,agent_state:"blocked"});
  });

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
  it("повтор одинаковой работы от другой роли возвращает существующий слот", async()=>{
    const fixture=await planWith("approved",[{slot:"research",role:"researcher",state:"running"}],[]);
    const planId=(fixture as any).planId;
    const {applyPlanOps}=await import("../src/runtime/planMutations.js");
    const actor={kind:"owner" as const,id:ownerId};
    const op={op:"add_step" as const,role_key:"analyst",expected_result:"Один результат",instructions:"Найти данные",after:["research"]};
    const first:any=applyPlanOps(planId,[op],actor);
    const second:any=applyPlanOps(planId,[{...op,role_key:"builder",expected_result:"  ОДИН   результат ",instructions:"найти данные"}],actor);
    expect(second.added).toEqual(first.added);
    expect(second.version).toBe(first.version);
  });

  it("архивный план не запускается напрямую и не восстанавливается после рестарта", async () => {
    const { taskId, planId } = await planWith("approved", [{slot:"work",role:"builder"}], []);
    const step = stepOf(planId, "work")!;
    db.prepare("UPDATE tasks SET archived_at=datetime('now') WHERE id=?").run(taskId);
    const {startPlanSubtaskRun,recoverInterruptedPlanSubtasks} = await import("../src/runtime/planSubtaskAdmission.js");
    const count = started.length;
    expect((await startPlanSubtaskRun(step.id,"role_builder")).ok).toBe(false);
    expect(started.length).toBe(count);
    db.prepare("UPDATE subtasks SET agent_state='todo' WHERE id=?").run(step.id);
    const before = db.prepare("SELECT * FROM subtasks WHERE id=?").get(step.id);
    await recoverInterruptedPlanSubtasks({skip:row=>row.id!==step.id});
    expect(db.prepare("SELECT * FROM subtasks WHERE id=?").get(step.id)).toEqual(before);
    expect(started.length).toBe(count);
    expect(db.prepare("SELECT count(*) n FROM attempts WHERE subtask_id=?").get(step.id)).toEqual({n:0});
  });

  it("два старта создают одну активную попытку",async()=>{
    const f=await planWith("approved",[{slot:"work",role:"builder",state:"pending"}],[]);
    const step=stepOf(f.planId,"work")!;
    const {startPlanSubtaskRun}=await import("../src/runtime/planSubtaskAdmission.js");
    const results=await Promise.all([startPlanSubtaskRun(step.id,ownerId),startPlanSubtaskRun(step.id,ownerId)]);
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) n FROM attempts WHERE subtask_id=? AND ended_at IS NULL").get(step.id) as any).n).toBe(1);
    expect(db.prepare("SELECT routing_role FROM attempts WHERE subtask_id=? AND ended_at IS NULL").get(step.id)).toEqual({ routing_role: "builder" });
  });
  it("исполнитель слота не захватывает карточку и не меняет назначение",async()=>{
    const f=await planWith("approved",[{slot:"work",role:"builder",state:"running"}],[]);
    const claim=await app.inject({method:"POST",url:`/api/tasks/${f.taskId}/claim`,headers:as("role_builder")});
    expect(claim.statusCode).toBe(403);
    const assign=await app.inject({method:"PATCH",url:`/api/tasks/${f.taskId}`,headers:as("role_builder"),payload:{assignee_id:"role_builder"}});
    expect([403,404]).toContain(assign.statusCode);
  });

  // Владелец 13.10.2026: сданный план не заперт — новый шаг возвращает карточку в работу.
  it("сданный план переоткрывается новым шагом: с проверки, из закрытых и ролью из сданного шага", async () => {
    const { finishPlanIfComplete, unlockReadyPlanSubtasks } = await import("../src/runtime/planSubtaskAdmission.js");
    const task = (id: string) => db.prepare("SELECT status, agent_state, completed_at FROM tasks WHERE id = ?").get(id) as { status: string; agent_state: string | null; completed_at: string | null };
    const delivered = async (review = false) => {
      const f = await planWith("approved", [
        { slot: "analysis", role: "analyst", state: "done" },
        { slot: "delivery", role: "builder", state: "done" },
      ], [["analysis", "delivery"]]);
      db.prepare("UPDATE tasks SET requires_reviewer_review = ? WHERE id = ?").run(review ? 1 : 0, f.taskId);
      expect(finishPlanIfComplete(f.planId, f.taskId, ownerId)).toBe(true);
      expect(task(f.taskId).agent_state).toBe("review");
      return f;
    };

    // Карточка на проверке: шаг добавлен, стартовал, карточка снова в работе, после шага — вторая сдача.
    const a = await delivered();
    const added = await ops(a.taskId, a.planId, { ops: [{ op: "add_step", slot_key: "designer_pass", role_key: "designer", expected_result: "Пройтись по сделанному", after: ["delivery"] }] });
    expect(added.statusCode).toBe(200);
    expect(added.json().result.status).toBe("applied");
    expect(task(a.taskId)).toMatchObject({ status: "active", agent_state: null });
    const pass = stepOf(a.planId, "designer_pass")!;
    expect(started).toContain(pass.id);
    expect(finishPlanIfComplete(a.planId, a.taskId, ownerId)).toBe(false);
    db.prepare("UPDATE subtasks SET done = 1, agent_state = NULL, result = 'Готово' WHERE id = ?").run(pass.id);
    expect(finishPlanIfComplete(a.planId, a.taskId, ownerId)).toBe(true);
    expect(task(a.taskId).agent_state).toBe("review");

    // Закрытая карточка возвращается в активные.
    const b = await delivered();
    db.prepare("UPDATE tasks SET status = 'completed', agent_state = NULL, completed_at = datetime('now') WHERE id = ?").run(b.taskId);
    const reopened = await ops(b.taskId, b.planId, { ops: [{ op: "add_step", role_key: "qa", expected_result: "Перепроверить", after: ["delivery"] }] });
    expect(reopened.statusCode).toBe(200);
    expect(task(b.taskId)).toMatchObject({ status: "active", agent_state: null, completed_at: null });

    // Итоговая проверка ещё не сдана: она ждёт новый шаг и встаёт в очередь после него, второй сдачи нет.
    db.prepare("UPDATE users SET reviewer_first_default = 1 WHERE id = ?").run(ownerId);
    const d = await delivered(true);
    const review = db.prepare("SELECT plan_node_key k FROM subtasks WHERE collaboration_plan_id = ? AND plan_node_key LIKE 'final_review_%'").get(d.planId) as { k: string };
    expect(stepOf(d.planId, review.k)).toMatchObject({ done: 0, agent_state: "todo" });
    expect((await ops(d.taskId, d.planId, { ops: [{ op: "add_step", slot_key: "qa_extra", role_key: "qa", expected_result: "Допроверить", after: ["delivery"] }] })).statusCode).toBe(200);
    expect(edgesOf(d.planId)).toContain("qa_extra>" + review.k);
    expect(stepOf(d.planId, review.k)!.agent_state).toBeNull();
    expect(task(d.taskId).agent_state).toBeNull();
    db.prepare("UPDATE subtasks SET done = 1, agent_state = NULL, result = 'Готово' WHERE id = ?").run(stepOf(d.planId, "qa_extra")!.id);
    expect(finishPlanIfComplete(d.planId, d.taskId, ownerId)).toBe(false);
    await unlockReadyPlanSubtasks(d.planId, d.taskId, ownerId);
    expect(stepOf(d.planId, review.k)!.agent_state).toBe("todo");
    expect(task(d.taskId).agent_state).toBe("review");
    expect((db.prepare("SELECT COUNT(*) n FROM subtasks WHERE collaboration_plan_id = ? AND plan_node_key LIKE 'final_review_%'").get(d.planId) as { n: number }).n).toBe(1);

    // Роль достраивает сданный план из своего сданного шага.
    const c = await delivered();
    const own = stepOf(c.planId, "delivery")!.id;
    const byRole = await app.inject({ method: "POST", url: `/api/subtasks/${own}/plan-request`, headers: as("role_builder"),
      payload: { kind: "add_step", role: "qa", expected_result: "Проверить по просьбе владельца", reason: "Владелец попросил проверку после сдачи" } });
    expect(byRole.statusCode).toBe(200);
    expect(byRole.json().result.status).toBe("applied");
    expect(task(c.taskId).agent_state).toBeNull();
  });

});
