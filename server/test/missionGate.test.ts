import { roleReport } from "./helpers/roleReport.js";
// Гейт контракта ассерций (владелец 01.11.2026).
// Проверяющий шаг закрывает ассерции контракта (`fulfills`) и обязан
// приложить результат проверки по каждой. Непройденная ассерция →
// `changes_requested` и доработка, а не тихий «готово» (3e27dafe:
// «секретарь не может выдать новый виджет», а проверка была «approved» —
// сценарий никто не прогнал).
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { roleUserId } from "../src/roleRouting.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

async function scenario(app: FastifyInstance, ownerAuth: string, assertionId: string, title: string) {
  const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: `${title} ${crypto.randomUUID()}` } });
  const taskId = created.json().task.id as string;

  const contract = await app.inject({
    method: "POST", url: `/api/tasks/${taskId}/mission-assertions`, headers: { authorization: ownerAuth },
    payload: { assertions: [{ assertion_id: assertionId, title: "Вход работает", behavior: "POST /login даёт 200", tool: "browser.mjs" }] },
  });
  expect(contract.statusCode).toBe(200);

  // Проверяющий шаг — корень плана: он стартует сразу после утверждения.
  const plan = await app.inject({
    method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth }, payload: {
      profile: "manual",
      nodes: [
        { slot_key: "check", role_key: "analyst", fulfills: [assertionId], output_artifact: { key: "check_report", type: "report", format: "json", required_fields: ["summary"] } },
      ],
      edges: [],
    },
  });
  expect(plan.statusCode).toBe(201);
  const planId = plan.json().plan.id as string;

  const ir = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/integration-responsibility`, headers: { authorization: ownerAuth } })).json();
  await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}/integration-responsibility`, headers: { authorization: ownerAuth }, payload: { mode: "manual", owner_id: ir.candidates[0].id } });
  const approved = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: { authorization: ownerAuth } });
  expect(approved.statusCode).toBe(200);

  const subtasks = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/subtasks`, headers: { authorization: ownerAuth } })).json() as Array<{ id: string; plan_node_key: string; agent_id: string | null; agent_state: string | null }>;
  const check = subtasks.find((s) => s.plan_node_key === "check")!;
  // В тестовой среде нет доступных моделей, поэтому роль не стартует сама
  // (`model_unavailable`) — этоenvironmental красной базы, а не гейта.
  // Ставим «в работе» фикстурой: под гейтом проверяется сдача артефакта.
  db.prepare("UPDATE subtasks SET agent_id=?, agent_state='in_progress' WHERE id=?").run(roleUserId("analyst"), check.id);
  return { taskId, planId, checkId: check.id };
}

describe("гейт контракта ассерций: результат проверки решает судьбу работы", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let qaAuth: string;
  let taskId: string;
  let checkId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Gate owner", email: `gate-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = `Bearer ${reg.json().token}`;
    qaAuth = `Bearer ${app.jwt.sign({ id: roleUserId("analyst") })}`;
    const s = await scenario(app, ownerAuth, "VAL-AUTH-001", "Миссия с провалом");
    taskId = s.taskId;
    checkId = s.checkId;
  });

  it("инструкция проверяющего содержит требование приложить результат проверки", async () => {
    const plans = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/collaboration-plans`, headers: { authorization: ownerAuth } })).json().plans as Array<{ nodes: Array<{ slot_key: string; instructions: string | null }> }>;
    const check = plans.find((p) => p.nodes.some((n) => n.slot_key === "check"))!.nodes.find((n) => n.slot_key === "check")!;
    expect(check.instructions ?? "").toContain("Проверка по контракту ассерций");
    expect(check.instructions ?? "").toContain("VAL-AUTH-001");
  });

  it("сдача результата без проверки ассерций отклоняется", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/subtasks/${checkId}/artifact`, headers: { authorization: qaAuth },
      payload: { report_markdown: roleReport, summary: "Проверил", payload: { summary: "всё ок" }, evidence: [{ path: "qa/report.md" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("assertions");
    expect(res.json().error).toContain("VAL-AUTH-001");
  });

  it("непройденная ассерция даёт changes_requested, а не тихий «готово»", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/subtasks/${checkId}/artifact`, headers: { authorization: qaAuth },
      payload: {
        report_markdown: roleReport, summary: "Проверка не прошла",
        payload: { summary: "логин не работает", assertions: [{ id: "VAL-AUTH-001", status: "failed", evidence: [{ path: "qa/report.md" }], observed: "POST /login → 500" }] },
        evidence: [{ path: "qa/report.md" }],
      },
    });
    expect(res.statusCode).toBe(201);

    const subtask = db.prepare("SELECT result, done FROM subtasks WHERE id = ?").get(checkId) as { result: string | null; done: number };
    expect(subtask.result ?? "").toContain("changes_requested");
    expect(subtask.result ?? "").toContain("VAL-AUTH-001");

    const assertion = db.prepare("SELECT status FROM mission_assertions WHERE task_id = ? AND assertion_id = ?").get(taskId, "VAL-AUTH-001") as { status: string };
    expect(assertion.status).toBe("failed");

    const outcome = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/mission-assertions`, headers: { authorization: ownerAuth } })).json().outcome;
    expect(outcome.closed).toBe(false);
    expect(outcome.outstanding).toEqual(["VAL-AUTH-001"]);
    expect(outcome.failed).toBe(1);
  });

  it("журнал миссии показывает, что проверка провалилась", async () => {
    const events = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/mission-events`, headers: { authorization: ownerAuth } })).json().events as Array<{ kind: string; payload_json: string | null }>;
    expect(events.some((e) => e.kind === "contract_replaced")).toBe(true);
    const failed = events.find((e) => e.kind === "assertion_failed");
    expect(failed).toBeTruthy();
    expect(failed!.payload_json).toContain("VAL-AUTH-001");
  });
});

describe("гейт контракта: пройденная проверка закрывает миссию", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let qaAuth: string;
  let taskId: string;
  let checkId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Gate owner 2", email: `gate2-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = `Bearer ${reg.json().token}`;
    qaAuth = `Bearer ${app.jwt.sign({ id: roleUserId("analyst") })}`;
    const s = await scenario(app, ownerAuth, "VAL-OK-001", "Миссия успешная");
    taskId = s.taskId;
    checkId = s.checkId;
  });

  it("пройденная проверка закрывает контракт: миссия готова", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/subtasks/${checkId}/artifact`, headers: { authorization: qaAuth },
      payload: {
        report_markdown: roleReport, summary: "Проверено, всё работает",
        payload: { summary: "ок", assertions: [{ id: "VAL-OK-001", status: "passed", evidence: [{ path: "qa/report.md" }], observed: "POST /login → 200" }] },
        evidence: [{ path: "qa/report.md" }],
      },
    });
    expect(res.statusCode).toBe(201);
    const outcome = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/mission-assertions`, headers: { authorization: ownerAuth } })).json().outcome;
    expect(outcome.closed).toBe(true);
    expect(outcome.passed).toBe(1);
    expect(outcome.outstanding).toEqual([]);
  });
});
