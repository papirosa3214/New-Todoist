// Режим «Оркестратор» (владелец 13.10.2026): план из двух шагов Оркестратора —
// разложить работу по ролям и принять/собрать итог. Проверяем шаблон,
// инструкции шагов, отключение автоинтегратора и побудку при блоке шага команды.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: async () => ({ runId: "orch-run", completion: Promise.resolve() }) };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { planSubtaskPrompt } from "../src/runtime/inProcessRun.js";
import { integrationResponsibility } from "../src/lib/integrationResponsibility.js";
import { wakeOrchestrator } from "../src/runtime/orchestratorWake.js";
import { roleUserId } from "../src/roleRouting.js";
import { applyPlanOps } from "../src/runtime/planMutations.js";

describe("режим «Оркестратор»", () => {
  let app: FastifyInstance;
  let auth: { authorization: string };
  let taskId: string;
  let planId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    db.prepare("INSERT OR IGNORE INTO roles (key, title) VALUES ('code_orchestrator', 'Оркестратор')").run();
    db.prepare(`INSERT OR IGNORE INTO users (id, name, email, password_hash, role, role_key, type, is_system_bot, permissions) VALUES ('role_code_orchestrator', 'Оркестратор', 'orch@taskflow.local', '', 'agent', 'code_orchestrator', 'ai', 1, '{"orchestrate":true}')`).run();
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Orch owner", email: `orch-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(reg.json().user.id);
    auth = { authorization: `Bearer ${reg.json().token}` };
    const t = await app.inject({ method: "POST", url: "/api/tasks", headers: auth, payload: { title: "Накопления и справочник" } });
    taskId = t.json().task.id;
  });
  afterAll(async () => { if (app) await app.close(); });

  it("propose orchestrated даёт два шага Оркестратора: разложить → собрать", async () => {
    const r = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/propose`, headers: auth, payload: { profile: "orchestrated" } });
    expect(r.statusCode).toBe(201);
    const plan = r.json().plan;
    planId = plan.id;
    expect(plan.profile).toBe("orchestrated");
    expect(plan.nodes.map((n: any) => [n.slot_key, n.role_key])).toEqual([["orchestrate", "code_orchestrator"], ["assemble", "code_orchestrator"]]);
    expect(plan.edges.map((e: any) => [e.from_slot_key, e.to_slot_key])).toEqual([["orchestrate", "assemble"]]);
  });

  it("автоинтегратор для такого плана не назначается", () => {
    const state = integrationResponsibility(taskId);
    expect(state.mode).toBe("not_required");
    expect(state.owner_id).toBeNull();
  });

  it("шаги получают инструкции оркестратора, а не исполнителя", async () => {
    const ap = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: auth });
    expect(ap.json().plan.status).toBe("approved");
    const steps = db.prepare("SELECT id, plan_node_key FROM subtasks WHERE collaboration_plan_id=?").all(planId) as Array<{ id: string; plan_node_key: string }>;
    const first = planSubtaskPrompt(taskId, "code_orchestrator", steps.find(s => s.plan_node_key === "orchestrate")!.id);
    expect(first).toContain("режим «Оркестратор»");
    expect(first).toContain("НЕ делаешь работу задачи сам");
    expect(first).toContain(planId);
    expect(first).not.toContain("Сделай работу.");
    const second = planSubtaskPrompt(taskId, "code_orchestrator", steps.find(s => s.plan_node_key === "assemble")!.id);
    expect(second).toContain("сам в main не вливай");
  });

  it("Оркестратор раскладывает работу: шаги ролей встают между его шагами и применяются сразу", () => {
    const version = (db.prepare("SELECT version FROM task_collaboration_plans WHERE id=?").get(planId) as { version: number }).version;
    const r = applyPlanOps(planId, [
      { op: "add_step", slot_key: "builder_main", role_key: "builder", expected_result: "Раздел накоплений", after: ["orchestrate"], before: ["assemble"] },
      { op: "add_step", slot_key: "critic_main", role_key: "critic_verifier", expected_result: "Вердикт", after: ["builder_main"], before: ["assemble"] },
    ] as any, { kind: "owner", id: "role_code_orchestrator" }, { baseVersion: version, reason: "декомпозиция" });
    expect(r.status).toBe("applied");
    const edges = db.prepare("SELECT from_slot_key||'>'||to_slot_key AS e FROM task_collaboration_plan_edges WHERE plan_id=? ORDER BY e").all(planId).map((x: any) => x.e);
    expect(edges).toEqual(expect.arrayContaining(["orchestrate>builder_main", "builder_main>critic_main", "builder_main>assemble", "critic_main>assemble"]));
  });

  it("блок шага команды будит Оркестратора сообщением в очередь; свой шаг — нет", () => {
    const own = db.prepare("SELECT id FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key='orchestrate'").get(planId) as { id: string };
    expect(wakeOrchestrator(own.id, roleUserId("builder")!, "blocked", "x")).toBeNull();

    db.prepare(`INSERT INTO task_collaboration_plan_nodes (plan_id, slot_key, role_key, required, expected_result)
                SELECT plan_id, 'builder_1', 'builder', 1, 'Реализация' FROM task_collaboration_plan_nodes WHERE plan_id=? AND slot_key='orchestrate'`).run(planId);
    const sid = "orch-test-" + Date.now();
    db.prepare("INSERT INTO subtasks (id, task_id, title, collaboration_plan_id, plan_node_key) VALUES (?,?,?,?,?)").run(sid, taskId, "Реализация", planId, "builder_1");
    const wake = wakeOrchestrator(sid, roleUserId("builder")!, "blocked", "нет доступа к API");
    expect(wake).not.toBeNull();
    // Сессия «Заминки» своей задачи (21.10.2026): создатель — владелец.
    const room = db.prepare("SELECT id,title,task_id,room_kind,created_by FROM chats WHERE id=?").get(wake!.chatId) as any;
    expect(room).toMatchObject({ id: "wake:" + taskId, title: "Заминки", task_id: taskId, room_kind: "wake" });
    expect(db.prepare("SELECT role FROM users WHERE id=?").get(room.created_by)).toMatchObject({ role: "owner" });
    expect(wake!.roleId).toBe(roleUserId("code_orchestrator"));
    const q = db.prepare("SELECT status FROM chat_message_queue WHERE message_id=?").get(wake!.messageId) as { status: string };
    expect(q.status).toBe("pending");
    const msg = db.prepare("SELECT text FROM chat_messages WHERE id=?").get(wake!.messageId) as { text: string };
    expect(msg.text).toContain("нет доступа к API");
    const ret = wakeOrchestrator(sid, roleUserId("qa")!, "returned", "нет обработки пустого ввода");
    expect((db.prepare("SELECT text FROM chat_messages WHERE id=?").get(ret!.messageId) as { text: string }).text).toContain("возвращён проверяющим");
    const ask = wakeOrchestrator(sid, roleUserId("builder")!, "approval", "op_id=x");
    expect((db.prepare("SELECT text FROM chat_messages WHERE id=?").get(ask!.messageId) as { text: string }).text).toContain("taskflow_plan_proposal_decide");
  });

  it("в плане другого профиля блок будит Оркестратора, а возврат — нет (20.10.2026)", () => {
    // Шаг builder_1 заведён предыдущим тестом.
    const sid = (db.prepare("SELECT id FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key='builder_1'").get(planId) as { id: string }).id;
    db.prepare("UPDATE task_collaboration_plans SET profile='single_executor' WHERE id=?").run(planId);
    try {
      db.prepare("UPDATE subtasks SET block_type='capability' WHERE id=?").run(sid);
      const wake = wakeOrchestrator(sid, roleUserId("builder")!, "blocked", "жду ответа владельца");
      expect(wake).not.toBeNull();
      const text = (db.prepare("SELECT text FROM chat_messages WHERE id=?").get(wake!.messageId) as { text: string }).text;
      expect(text).toContain("Тебя разбудили, потому что шаг встал в блок");
      expect(text).toContain("Вид блока: capability");
      for (const tool of ["taskflow_plan_read", "taskflow_plan_ops", "taskflow_team_read", "taskflow_slot_restart", "taskflow_topic_send", "taskflow_ask_user_question", "taskflow_notify_owner_urgent"]) expect(text).toContain(tool);
      expect(wakeOrchestrator(sid, roleUserId("qa")!, "returned", "дефект")).toBeNull();
      expect(wakeOrchestrator(sid, roleUserId("builder")!, "retry", null)).toBeNull();
    } finally {
      db.prepare("UPDATE task_collaboration_plans SET profile='orchestrated' WHERE id=?").run(planId);
    }
  });
});

describe("перенос карточки в другой проект", () => {
  it("пустая тема переезжает в группу нового проекта, план утверждается", async () => {
    const app = await buildApp();
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Move owner", email: `move-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(reg.json().user.id);
    const auth = { authorization: `Bearer ${reg.json().token}` };
    const p1 = (await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { name: "Старый" } })).json();
    const p2 = (await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { name: "Новый" } })).json();
    const t = (await app.inject({ method: "POST", url: "/api/tasks", headers: auth, payload: { title: "Переезд", project_id: p1.id } })).json().task;
    expect((await app.inject({ method: "POST", url: `/api/tasks/${t.id}/topic`, headers: auth, payload: {} })).statusCode).toBe(200);
    await app.inject({ method: "PATCH", url: `/api/tasks/${t.id}`, headers: auth, payload: { project_id: p2.id } });
    const plan = (await app.inject({ method: "POST", url: `/api/tasks/${t.id}/collaboration-plans/propose`, headers: auth, payload: { profile: "research" } })).json().plan;
    const ap = await app.inject({ method: "POST", url: `/api/tasks/${t.id}/collaboration-plans/${plan.id}/approve`, headers: auth, payload: {} });
    expect(ap.statusCode).toBe(200);
    const topic = db.prepare("SELECT project_id FROM chats WHERE task_id=? AND parent_chat_id IS NOT NULL").get(t.id) as { project_id: string };
    expect(topic.project_id).toBe(p2.id);
    await app.close();
  });
});
