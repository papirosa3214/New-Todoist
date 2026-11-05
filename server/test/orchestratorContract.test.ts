import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: async () => ({ runId: "contract-run", completion: Promise.resolve() }) };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { orchestratorTools } from "../src/runtime/orchestratorTools.js";
import { planSubtaskPrompt } from "../src/runtime/inProcessRun.js";
import { applyPlanOps } from "../src/runtime/planMutations.js";
import { effectiveArtifactContract, orchestrateContractError } from "../src/lib/missionContract.js";

// Цепочка контракта (владелец 05.11.2026): проверки на сервере есть с 01.11, но записать
// контракт оркестратор не мог, и шаг с пунктами контракта было нечем сдать.
let app: any;
let auth: { authorization: string };
let owner: string;

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  db.prepare("INSERT OR IGNORE INTO roles (key, title) VALUES ('code_orchestrator', 'Оркестратор')").run();
  db.prepare(`INSERT OR IGNORE INTO users (id, name, email, password_hash, role, role_key, type, is_system_bot, permissions)
    VALUES ('role_code_orchestrator','Оркестратор','orch-contract@test','!','agent','code_orchestrator','ai',1,'{"orchestrate":true}')`).run();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Owner", email: `contract-${Date.now()}@test`, password: "password123" } });
  owner = reg.json().user.id;
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner);
  auth = { authorization: `Bearer ${reg.json().token}` };
});
afterAll(async () => app.close());

async function orchestrated() {
  const t = await app.inject({ method: "POST", url: "/api/tasks", headers: auth, payload: { title: "Сбор контракта" } });
  const taskId = t.json().task.id as string;
  const p = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/propose`, headers: auth, payload: { profile: "orchestrated" } });
  const planId = p.json().plan.id as string;
  const a = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: auth });
  expect(a.statusCode, a.body).toBe(200);
  return { taskId, planId };
}

const write = (taskId: string, ids: string[]) =>
  app.inject({ method: "POST", url: `/api/tasks/${taskId}/mission-assertions`, headers: auth, payload: { assertions: ids.map((id) => ({ assertion_id: id, title: `Пункт ${id}`, behavior: "Владелец видит результат", tool: "browser.mjs" })) } });

it("у оркестратора есть инструмент контракта, у рядовой роли нет", () => {
  const names = (role: string) => orchestratorTools(role, (name: string) => ({ name })).map((tool: { name: string }) => tool.name);
  expect(names("code_orchestrator")).toContain("taskflow_mission_contract");
  expect(names("builder")).not.toContain("taskflow_mission_contract");
});

it("инструкция требует контракт до разбиения и привязки работ к его пунктам", async () => {
  const { taskId, planId } = await orchestrated();
  const steps = db.prepare("SELECT id,plan_node_key FROM subtasks WHERE collaboration_plan_id=?").all(planId) as Array<{ id: string; plan_node_key: string }>;
  const first = planSubtaskPrompt(taskId, "code_orchestrator", steps.find((s) => s.plan_node_key === "orchestrate")!.id);
  expect(first.indexOf("taskflow_mission_contract")).toBeGreaterThan(-1);
  expect(first.indexOf("taskflow_mission_contract")).toBeLessThan(first.indexOf("taskflow_plan_ops"));
  expect(first).toContain("fulfills");
  expect(first).toContain("architect");
  const second = planSubtaskPrompt(taskId, "code_orchestrator", steps.find((s) => s.plan_node_key === "assemble")!.id);
  expect(second).toContain("taskflow_mission_contract");
});

it("разложить работу без контракта нельзя", async () => {
  const { taskId, planId } = await orchestrated();
  expect(orchestrateContractError(taskId, planId)).toContain("контракт");
  const step = db.prepare("SELECT id FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key='orchestrate'").get(planId) as { id: string };
  const refused = await app.inject({ method: "PATCH", url: `/api/subtasks/${step.id}`, headers: auth, payload: { done: true, result: "Разложил" } });
  expect(refused.statusCode, refused.body).toBe(409);
  expect(refused.json().error).toContain("контракт");
});

it("контракт записан и покрыт: шаг сдаётся", async () => {
  const { taskId, planId } = await orchestrated();
  expect((await write(taskId, ["VAL-001"])).statusCode).toBe(200);
  const gap = await app.inject({ method: "PATCH", url: `/api/subtasks/${(db.prepare("SELECT id FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key='orchestrate'").get(planId) as { id: string }).id}`, headers: auth, payload: { done: true, result: "Разложил" } });
  expect(gap.statusCode).toBe(409);
  applyPlanOps(planId, [{ op: "add_step", slot_key: "qa_live", role_key: "qa", expected_result: "Сценарий пройден", after: ["orchestrate"], before: ["assemble"], fulfills: ["VAL-001"] }], { kind: "owner", id: owner });
  expect(orchestrateContractError(taskId, planId)).toBeNull();
});

it("пункт контракта на критике отклоняется: он сдаёт только вердикт", async () => {
  const { taskId, planId } = await orchestrated();
  await write(taskId, ["VAL-001"]);
  applyPlanOps(planId, [{ op: "add_step", slot_key: "crit", role_key: "critic_verifier", expected_result: "Вердикт", after: ["orchestrate"], before: ["assemble"], fulfills: ["VAL-001"] }], { kind: "owner", id: owner });
  expect(orchestrateContractError(taskId, planId)).toContain("Критик");
});

it("шаг с пунктами контракта обязан сдавать артефакт с результатами", async () => {
  expect(effectiveArtifactContract(null, null)).toBeNull();
  expect(effectiveArtifactContract(null, "[]")).toBeNull();
  const fallback = effectiveArtifactContract(null, '["VAL-001"]');
  expect(fallback?.required_fields).toEqual(["assertions"]);
  const own = '{"key":"own","type":"result_pack","format":"json","required_fields":["summary"]}';
  expect(effectiveArtifactContract(own, '["VAL-001"]')?.key).toBe("own");
});

it("роль с пунктом контракта сдаёт шаг артефактом и результат попадает в контракт", async () => {
  const { taskId, planId } = await orchestrated();
  await write(taskId, ["VAL-001"]);
  applyPlanOps(planId, [{ op: "add_step", slot_key: "qa_live", role_key: "qa", expected_result: "Сценарий пройден", after: ["orchestrate"], before: ["assemble"], fulfills: ["VAL-001"] }], { kind: "owner", id: owner });
  const step = db.prepare("SELECT id FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key='qa_live'").get(planId) as { id: string };
  db.prepare("UPDATE subtasks SET agent_state='in_progress',agent_id='role_qa' WHERE id=?").run(step.id);
  db.prepare("UPDATE subtasks SET done=1 WHERE collaboration_plan_id=? AND plan_node_key='orchestrate'").run(planId);
  const token = app.jwt.sign({ id: "role_qa" });
  const report = "## Результат\nПройдено\n## Что сделано\nПрошёл сценарий\n## Проверки\nЖивой прогон\n## Ограничения\nНет\n## Материалы\nНет";
  const refused = await app.inject({ method: "PATCH", url: `/api/subtasks/${step.id}`, headers: { authorization: `Bearer ${token}` }, payload: { done: true, result: "Готово" } });
  expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
  const submitted = await app.inject({
    method: "POST", url: `/api/subtasks/${step.id}/artifact`, headers: { authorization: `Bearer ${token}` },
    payload: { summary: "Сценарий пройден", report_markdown: report, payload: { assertions: [{ id: "VAL-001", status: "passed", evidence: ["report.md"], observed: "Работает" }] } },
  });
  expect(submitted.statusCode, submitted.body).toBe(201);
  expect((db.prepare("SELECT status FROM mission_assertions WHERE task_id=?").get(taskId) as { status: string }).status).toBe("passed");
  expect((db.prepare("SELECT count(*) n FROM mission_events WHERE task_id=?").get(taskId) as { n: number }).n).toBeGreaterThan(0);
});
