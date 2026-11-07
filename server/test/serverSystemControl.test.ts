import {vi as runtimeVi} from "vitest";
runtimeVi.mock("../src/runtime/inProcessRun.js",async original=>({...await original<any>(),runRoleInProcess:runtimeVi.fn(async()=>({runId:"isolated-contract-test",completion:Promise.resolve()}))}));
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { unitState } from "../src/routes/agent-service.js";
import { kickRoleTaskStrict } from "../src/runtime/inProcessRun.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

describe("Один серверный переключатель Система", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  beforeAll(async () => {
    app = await buildApp();
    seedRoleAccounts(db);
    const reg = await app.inject({method:"POST",url:"/api/auth/register",payload:{
      name:"System owner",email:`system-${Date.now()}@test`,password:"password123"}});
    const body=reg.json();
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(body.user.id);
    token=body.token;
  });
  afterAll(async () => { delete process.env.TASKFLOW_KICK_IN_TESTS; await app.close(); });
  const toggle = (on:boolean) => app.inject({method:"POST",url:"/api/agent-service",
    headers:{authorization:`Bearer ${token}`},payload:{on}});
  it("включает допуск и runtime одним сохранённым значением, без systemd", async () => {
    expect((await toggle(true)).json()).toMatchObject({ok:true,active:true,enabled:true});
    expect((db.prepare("SELECT task_intake_mode FROM users WHERE id='u1'").get() as any).task_intake_mode).toBe("automatic");
    expect((await unitState()).active).toBe(true);
    expect((await toggle(false)).json()).toMatchObject({ok:true,active:false,enabled:false});
    expect((db.prepare("SELECT task_intake_mode FROM users WHERE id='u1'").get() as any).task_intake_mode).toBe("manual");
    expect((await unitState()).active).toBe(false);
  });
  it("при выключенной Системе откладывает автоматическую job, но допускает явный ручной запуск владельца", async () => {
    await toggle(false);
    process.env.TASKFLOW_KICK_IN_TESTS="1";
    expect(await kickRoleTaskStrict("missing", "assigned", "u1")).toMatchObject({outcome:"deferred",reason:"autonomous system is disabled"});
    // Не вызываем модель: отсутствующая карточка должна пройти gate
    // ручного запуска и затем быть пропущена по обычному гейту состояния.
    expect(await kickRoleTaskStrict("missing","assigned","u1",{manualStart:true})).toMatchObject({outcome:"skipped",reason:"task is absent or no longer active"});
    expect(await kickRoleTaskStrict("missing","assigned","role_builder",{manualStart:true})).toMatchObject({outcome:"deferred"});
  });
  // MAK-71: после включения Системы карточка с machine_selected_role
  // получает план из одного шага (через applyIntakeToNewTask →
  // tryStartSingleExecutorPlan), а не assignee_id напрямую.
  it("включение подхватывает карточки, зависшие с выключенной Системой", async () => {
    await toggle(false);
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO tasks (id,title,creator_id,status,machine_selected_role)
      VALUES (?,'Зависшая карточка','u1','active','builder')`).run(id);
    // Пока выключено — карточка не трогается (это же гарантирует и
    // applyIntakeToNewTask на создании, здесь просто убеждаемся, что
    // включение — не единственный путь её испортить).
    expect(db.prepare("SELECT ready_for_pickup FROM tasks WHERE id=?").get(id))
      .toMatchObject({ ready_for_pickup: 0 });

    expect((await toggle(true)).json()).toMatchObject({ ok: true, active: true });

    const row = db.prepare("SELECT ready_for_pickup FROM tasks WHERE id=?").get(id) as any;
    expect(row.ready_for_pickup).toBe(1);
    const plan = db.prepare(
      "SELECT profile, status FROM task_collaboration_plans WHERE task_id = ? ORDER BY revision DESC LIMIT 1",
    ).get(id) as { profile: string; status: string } | undefined;
    expect(plan).toMatchObject({ profile: "single_executor", status: "approved" });
    const sub = db.prepare(
      `SELECT role_key FROM task_collaboration_plan_nodes
         WHERE plan_id IN (SELECT id FROM task_collaboration_plans
                           WHERE task_id = ?)
         LIMIT 1`,
    ).get(id) as { role_key: string } | undefined;
    expect(sub?.role_key).toBe("builder");
  });
  it("повторный POST on:true, когда уже включено, не гоняет разбор заново", async () => {
    await toggle(true);
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO tasks (id,title,creator_id,status,machine_selected_role)
      VALUES (?,'Заведена при включённой Системе','u1','active','builder')`).run(id);
    // Карточка ждёт обычный путь (создание через /api/tasks или Помощника владельца
    // вызвало бы applyIntakeToNewTask само); прямая вставка в обход этого
    // пути здесь нужна только чтобы проверить, что ИЗБЫТОЧНЫЙ POST on:true
    // (уже было включено) не запускает разбор заново — только переход
    // выкл→вкл его запускает.
    await toggle(true);
    expect(db.prepare("SELECT ready_for_pickup, assignee_id FROM tasks WHERE id=?").get(id))
      .toMatchObject({ ready_for_pickup: 0, assignee_id: null });
  });
  // MAK-71: ручной старт через /api/task-intake/drafts/:id/start идёт через
  // startDraftTree → tryStartSingleExecutorPlan(manualStart). Признак
  // «явного запуска» теперь — план single_executor со статусом approved и
  // ролью, выбранной владельцем.
  it("ручной старт карточки создаёт устойчивый признак явного запуска", async () => {
    await toggle(false);
    const id=crypto.randomUUID();
    db.prepare(`INSERT INTO tasks (id,title,creator_id,status,machine_selected_role)
      VALUES (?,'Ручной запуск','u1','active','builder')`).run(id);
    const ownerToken=app.jwt.sign({id:"u1"});
    const res=await app.inject({method:"POST",url:`/api/task-intake/drafts/${id}/start`,
      headers:{authorization:`Bearer ${ownerToken}`}});
    expect(res.statusCode).toBe(200);
    const plan = db.prepare(
      "SELECT profile, status, rationale FROM task_collaboration_plans WHERE task_id = ? ORDER BY revision DESC LIMIT 1",
    ).get(id) as { profile: string; status: string; rationale: string } | undefined;
    expect(plan).toMatchObject({ profile: "single_executor", status: "approved" });
    // rationale маркирует, что запуск был ручным (manualStart), а не системным.
    expect(plan?.rationale ?? "").toMatch(/manualStart/);
  });
});
